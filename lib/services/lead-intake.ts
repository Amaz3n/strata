import "server-only"

import { createHash, randomBytes } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { verifyInboundSignature } from "@/lib/inbound/signature"
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/secrets"
import { shouldShowCustomBuildNavigation, normalizeProductTier } from "@/lib/product-tier"
import { COOP_AGENT_ROLE, type InquiryChannel } from "@/lib/sales/activity"
import { leadDealHref, type LeadDesk } from "@/lib/sales/lead-desk"
import { leadContactKeys, leadDisplayName, phoneMatchIsSameBuyer, type LeadContactKeys } from "@/lib/sales/lead-identity"
import { isLeadRoutingOutcome, routeLead, type LeadRoutingOutcome, type LeadRoutingRule } from "@/lib/sales/lead-routing"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { completeOutboxJob, enqueueOutboxJob } from "@/lib/services/outbox"
import { findContactIdByEmail, promotePersonToDirectoryWithClient } from "@/lib/services/party-promotion"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { DEAL_WRITE_PERMISSIONS } from "@/lib/services/prospect-write-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  createLeadSourceInputSchema,
  dismissLeadReceiptInputSchema,
  divisionLeadOwnerInputSchema,
  leadReceiptIdSchema,
  leadRoutingRuleInputSchema,
  leadSourceIdSchema,
  leadSubmissionSchema,
  setLeadSourceStatusInputSchema,
  type CreateLeadSourceInput,
  type DismissLeadReceiptInput,
  type LeadRoutingRuleInput,
  type LeadSubmission,
} from "@/lib/validation/lead-intake"

/**
 * Website leads, filed into Arc's own pipeline.
 *
 * A builder's site (or form vendor) posts a signed delivery to
 * `/api/leads/intake/<public id>`. The delivery is logged first
 * (`lead_intake_receipts`), then filed through `file_lead()` — the same core a
 * consultant's walk-in registration uses — which merges a returning buyer into
 * their open deal or opens a new one, routed to an owner. Anything that does not
 * file shows on the desk: a bad payload or unknown community fails at once, a
 * database fault retries through the outbox and fails after three attempts.
 */

export const LEAD_INTAKE_JOB_TYPE = "file_lead_intake"


const MAX_FILING_ATTEMPTS = 3
const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000
const ATTENTION_CAP = 100

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const nullableString = z.string().nullable()

const sourceRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  name: z.string(),
  public_id: z.string(),
  secret_hint: z.string(),
  default_source_label: z.string(),
  default_community_id: nullableString,
  default_owner_user_id: nullableString,
  status: z.enum(["active", "disabled"]),
  last_received_at: nullableString,
  last_rejected_at: nullableString,
  last_rejection_reason: nullableString,
  rejected_count: z.number(),
  previous_secret_expires_at: nullableString,
  created_at: z.string(),
})
const SOURCE_COLUMNS =
  "id, org_id, name, public_id, secret_hint, default_source_label, default_community_id, default_owner_user_id, status, last_received_at, last_rejected_at, last_rejection_reason, rejected_count, previous_secret_expires_at, created_at"

const sourceSecretRowSchema = sourceRowSchema.extend({
  signing_secret_encrypted: z.string(),
  previous_secret_encrypted: nullableString,
})

const receiptRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  source_id: z.string(),
  idempotency_key: nullableString,
  payload_hash: nullableString,
  payload: z.unknown(),
  status: z.enum(["received", "filed", "merged", "failed", "rejected", "dismissed"]),
  failure_code: nullableString,
  last_error: nullableString,
  attempts: z.number(),
  next_attempt_at: nullableString,
  community_id: nullableString,
  contact_name: nullableString,
  contact_email: nullableString,
  contact_phone: nullableString,
  prospect_id: nullableString,
  matched_by: nullableString,
  prior_prospect_id: nullableString,
  possible_duplicate_prospect_id: nullableString,
  owner_user_id: nullableString,
  routing_outcome: nullableString,
  routing_reason: nullableString,
  received_at: z.string(),
})
type ReceiptRow = z.infer<typeof receiptRowSchema>
const RECEIPT_COLUMNS =
  "id, org_id, source_id, idempotency_key, payload_hash, payload, status, failure_code, last_error, attempts, next_attempt_at, community_id, contact_name, contact_email, contact_phone, prospect_id, matched_by, prior_prospect_id, possible_duplicate_prospect_id, owner_user_id, routing_outcome, routing_reason, received_at"

const filingResultSchema = z.object({
  prospect_id: z.string(),
  outcome: z.enum(["filed", "merged"]),
  matched_by: nullableString.optional(),
  prior_prospect_id: nullableString.optional(),
  possible_duplicate_prospect_id: nullableString.optional(),
  owner_user_id: nullableString.optional(),
  routing_outcome: nullableString.optional(),
  replayed: z.boolean(),
})
export type LeadFilingResult = z.infer<typeof filingResultSchema>

const routingContextSchema = z.object({
  division_id: nullableString,
  community_assignees: z.array(z.object({ user_id: z.string(), last_assigned_at: nullableString })),
  division_default_user_id: nullableString,
  eligible_user_ids: z.array(z.string()),
})

const ruleRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number(),
  source_id: nullableString,
  community_id: nullableString,
  division_id: nullableString,
  utm_source: nullableString,
  utm_campaign: nullableString,
  assigned_user_id: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
})
const RULE_COLUMNS = "id, name, priority, source_id, community_id, division_id, utm_source, utm_campaign, assigned_user_id, is_active, created_at"

function toRule(row: z.infer<typeof ruleRowSchema>): LeadRoutingRule {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    createdAt: row.created_at,
    isActive: row.is_active,
    sourceId: row.source_id,
    communityId: row.community_id,
    divisionId: row.division_id,
    utmSource: row.utm_source,
    utmCampaign: row.utm_campaign,
    assignedUserId: row.assigned_user_id,
  }
}

// ---------------------------------------------------------------------------
// The filing core, shared with the consultant's manual inquiry
// ---------------------------------------------------------------------------

/** How a lead counts against its community's daily traffic. A phone call is not footfall. */
const TRAFFIC_BUCKET: Record<InquiryChannel, "walk_ins" | "appointments" | "web_inquiries" | null> = {
  walk_in: "walk_ins",
  appointment: "appointments",
  web: "web_inquiries",
  phone: null,
}

export interface LeadFilingInput {
  name: string
  email: string | null
  phone: string | null
  /** A directory contact a consultant picked; attached as they are on file. */
  contactId?: string | null
  communityId: string | null
  ownerUserId: string | null
  /** The deal's source label (first touch). */
  source: string | null
  planInterest?: string | null
  priceRange?: string | null
  timeframe?: string | null
  notes?: string | null
  channel: InquiryChannel
  /** Calendar day the traffic counts on. */
  occurredOn?: string | null
  occurredAt?: string | null
  createdBy: string | null
  routingOutcome?: LeadRoutingOutcome | null
  routingReason?: string | null
  /** The community rotation's eligible consultants; filing takes the turn from these under a lock. */
  rotation?: string[]
  attribution?: {
    sourceLabel?: string | null
    utmSource?: string | null
    utmMedium?: string | null
    utmCampaign?: string | null
    utmTerm?: string | null
    utmContent?: string | null
    clickIds?: Record<string, string>
    referrerUrl?: string | null
    landingUrl?: string | null
  }
}

/**
 * Files one lead: merge into the open deal that already holds this email or
 * phone, or open a new one, append the touch and count the traffic — one
 * transaction. The caller has authorized the actor (or verified the delivery).
 */
export async function fileLeadRecord(
  service: SupabaseClient,
  orgId: string,
  receiptId: string | null,
  lead: LeadFilingInput,
): Promise<LeadFilingResult> {
  const attribution = lead.attribution ?? {}
  const { data, error } = await service.rpc("file_lead", {
    p_org_id: orgId,
    p_receipt_id: receiptId,
    p_lead: {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      contact_id: lead.contactId ?? null,
      community_id: lead.communityId,
      owner_user_id: lead.ownerUserId,
      source: lead.source,
      project_type: lead.planInterest ?? null,
      budget_range: lead.priceRange ?? null,
      timeline_preference: lead.timeframe ?? null,
      notes: lead.notes ?? null,
      created_by: lead.createdBy,
      channel: lead.channel,
      traffic_bucket: TRAFFIC_BUCKET[lead.channel],
      occurred_on: lead.occurredOn ?? null,
      occurred_at: lead.occurredAt ?? null,
      routing_outcome: lead.routingOutcome ?? null,
      routing_reason: lead.routingReason ?? null,
      round_robin_user_ids: lead.rotation ?? [],
      source_label: attribution.sourceLabel ?? lead.source,
      utm_source: attribution.utmSource ?? null,
      utm_medium: attribution.utmMedium ?? null,
      utm_campaign: attribution.utmCampaign ?? null,
      utm_term: attribution.utmTerm ?? null,
      utm_content: attribution.utmContent ?? null,
      click_ids: attribution.clickIds ?? {},
      referrer_url: attribution.referrerUrl ?? null,
      landing_url: attribution.landingUrl ?? null,
    },
  })
  if (error) throw new LeadFilingError(error.message, error.code === "22023" || error.code === "P0002")
  return filingResultSchema.parse(data)
}

/** A filing refusal. `permanent` faults (bad input) fail at once; others retry. */
export class LeadFilingError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message)
    this.name = "LeadFilingError"
  }
}

/**
 * What follows a filing, for every channel: the buyer enters the directory
 * (never by name alone for web input), the co-op agent is attached once, and
 * the deal's timeline, audit trail and search index learn about it.
 */
export async function recordLeadFiled(
  service: SupabaseClient,
  input: {
    orgId: string
    actorId: string | null
    result: LeadFilingResult
    lead: LeadFilingInput
    receiptId: string | null
    /** False for unauthenticated input: a shared name is not the same person. */
    matchDirectoryByName: boolean
    coopAgent?: { name: string; brokerage: string | null; email: string | null; phone: string | null } | null
  },
) {
  const { orgId, actorId, result, lead } = input
  if (result.replayed) return
  const prospectId = result.prospect_id

  if (result.outcome === "filed") {
    const contactId = lead.contactId ?? (await findDirectoryContact(service, orgId, leadContactKeys(lead)))
    const promotion = promotePersonToDirectoryWithClient(service, orgId, actorId, {
      contactId,
      fullName: lead.name,
      email: lead.email,
      phone: lead.phone,
      roleKey: "prospect",
      roleStatus: "inquiry",
      matchByName: input.matchDirectoryByName,
    })
    // A picked contact must attach; a typed or posted one entering the directory
    // late is not a reason for the lead to fail.
    const promoted = lead.contactId ? await promotion : await promotion.catch(() => null)
    if (promoted) {
      const { error } = await service
        .from("prospect_contacts")
        .update({ contact_id: promoted.contactId })
        .eq("org_id", orgId)
        .eq("prospect_id", prospectId)
        .eq("is_primary", true)
        .is("contact_id", null)
      if (error) throw new Error(`Failed to link the buyer to the directory: ${error.message}`)
    }
  }

  if (input.coopAgent) await attachCoopAgent(service, orgId, actorId, prospectId, input.coopAgent)

  const eventType = result.outcome === "filed" ? "prospect_created" : "lead_merged"
  await Promise.all([
    recordEvent({
      orgId,
      actorId,
      eventType,
      entityType: "prospect",
      entityId: prospectId,
      payload: {
        name: lead.name,
        channel: lead.channel,
        source: lead.attribution?.sourceLabel ?? lead.source,
        utm_campaign: lead.attribution?.utmCampaign ?? null,
        receipt_id: input.receiptId,
        matched_by: result.matched_by ?? null,
        returning_from: result.prior_prospect_id ?? null,
        possible_duplicate_of: result.possible_duplicate_prospect_id ?? null,
        routing_outcome: result.routing_outcome ?? null,
      },
    }),
    result.outcome === "filed"
      ? recordAudit({
          orgId,
          actorId: actorId ?? undefined,
          action: "insert",
          entityType: "prospect",
          entityId: prospectId,
          after: { id: prospectId, name: lead.name, community_id: lead.communityId, owner_user_id: result.owner_user_id ?? null, source: lead.source },
        })
      : Promise.resolve(),
  ])
}

async function findDirectoryContact(service: SupabaseClient, orgId: string, keys: LeadContactKeys | null) {
  if (!keys) return null
  if (keys.email) {
    const byEmail = await findContactIdByEmail(service, orgId, keys.email)
    if (byEmail) return byEmail
  }
  if (!keys.phone) return null
  // A phone names the same person only when one side has no email; the cap
  // bounds a number shared across a whole office.
  const { data, error } = await service
    .from("contacts")
    .select("id, email")
    .eq("org_id", orgId)
    .eq("phone_normalized", keys.phone)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(25)
  if (error) throw new Error(`Failed to match contact by phone: ${error.message}`)
  return z.array(z.object({ id: z.string(), email: z.string().nullable() })).parse(data ?? [])
    .find((contact) => phoneMatchIsSameBuyer(keys.email, contact.email))?.id ?? null
}

async function attachCoopAgent(
  service: SupabaseClient,
  orgId: string,
  actorId: string | null,
  prospectId: string,
  agent: { name: string; brokerage: string | null; email: string | null; phone: string | null },
) {
  const { data: existing, error: existingError } = await service
    .from("prospect_contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .eq("role", COOP_AGENT_ROLE)
    .limit(1)
  if (existingError) throw new Error(`Failed to read the deal's co-op agent: ${existingError.message}`)
  if ((existing ?? []).length > 0) return

  const promoted = await promotePersonToDirectoryWithClient(service, orgId, actorId, {
    fullName: agent.name,
    email: agent.email,
    phone: agent.phone,
    roleKey: "agent",
    roleStatus: "active",
    companyName: agent.brokerage,
    title: COOP_AGENT_ROLE,
    matchByName: false,
  }).catch(() => null)
  const { error } = await service.from("prospect_contacts").insert({
    org_id: orgId,
    prospect_id: prospectId,
    contact_id: promoted?.contactId ?? null,
    full_name: agent.name,
    company_name: agent.brokerage,
    email: agent.email,
    phone: agent.phone,
    role: COOP_AGENT_ROLE,
    is_primary: false,
  })
  if (error) throw new Error(`Failed to attach the co-op agent: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Website deliveries
// ---------------------------------------------------------------------------

export interface LeadDeliveryResponse {
  status: 200 | 202 | 400 | 401 | 404 | 409 | 422
  body: Record<string, unknown>
}

async function loadSourceForDelivery(service: SupabaseClient, publicId: string) {
  const { data, error } = await service
    .from("lead_intake_sources")
    .select(`${SOURCE_COLUMNS}, signing_secret_encrypted, previous_secret_encrypted`)
    .eq("public_id", publicId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the lead source: ${error.message}`)
  return data ? sourceSecretRowSchema.parse(data) : null
}

function contactSummary(payload: unknown) {
  const parsed = leadSubmissionSchema.safeParse(payload)
  if (!parsed.success) return { contact_name: null, contact_email: null, contact_phone: null }
  return {
    contact_name: leadDisplayName({ name: parsed.data.name, firstName: parsed.data.first_name, lastName: parsed.data.last_name }),
    contact_email: parsed.data.email || null,
    contact_phone: parsed.data.phone || null,
  }
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(rawBody)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
  } catch {
    return null
  }
}

/**
 * One signed delivery, start to finish. The receipt is persisted before
 * anything can fail, so a delivery is never lost: the sender gets a 2xx (or a
 * 4xx it should not retry) and the outbox owns every retry from there.
 */
export async function receiveLeadDelivery(input: {
  publicId: string
  rawBody: string
  timestamp: string | null
  signature: string | null
  idempotencyKey: string | null
  now?: Date
}): Promise<LeadDeliveryResponse> {
  const now = input.now ?? new Date()
  const service = createServiceSupabaseClient()
  const source = await loadSourceForDelivery(service, input.publicId)
  if (!source || source.status !== "active") return { status: 404, body: { error: "Unknown lead source" } }

  const previousLive =
    source.previous_secret_encrypted && source.previous_secret_expires_at && new Date(source.previous_secret_expires_at) > now
  const secrets = [
    decryptIntegrationSecret(source.signing_secret_encrypted),
    ...(previousLive && source.previous_secret_encrypted ? [decryptIntegrationSecret(source.previous_secret_encrypted)] : []),
  ]
  const verified = verifyInboundSignature({ secrets, timestamp: input.timestamp, signature: input.signature, rawBody: input.rawBody, now })
  if (!verified.ok) {
    const { error: rejectionError } = await service.rpc("record_lead_delivery_rejection", {
      p_source_id: source.id,
      p_reason: verified.reason,
      p_at: now.toISOString(),
    })
    if (rejectionError) throw new Error(`Failed to record a rejected delivery: ${rejectionError.message}`)
    return { status: 401, body: { error: "Invalid signature", reason: verified.reason } }
  }

  const payload = parseJsonObject(input.rawBody)
  const idempotencyKey = input.idempotencyKey?.trim() || (typeof payload?.submission_id === "string" ? payload.submission_id.trim() : "")
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return { status: 400, body: { error: "Send an Idempotency-Key header (or submission_id) of at most 200 characters" } }
  }
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex")

  const existing = await findReceiptByKey(service, source.id, idempotencyKey)
  if (existing) return replayResponse(existing, payloadHash)

  const { data: inserted, error: insertError } = await service
    .from("lead_intake_receipts")
    .insert({
      org_id: source.org_id,
      source_id: source.id,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      payload,
      status: "received",
      received_at: now.toISOString(),
      ...contactSummary(payload),
    })
    .select("id")
    .single()
  if (insertError?.code === "23505") {
    const raced = await findReceiptByKey(service, source.id, idempotencyKey)
    if (raced) return replayResponse(raced, payloadHash)
  }
  if (insertError || !inserted) throw new Error(`Failed to record the delivery: ${insertError?.message}`)
  const receipt = z.object({ id: z.string() }).parse(inserted)
  const { error: touchError } = await service
    .from("lead_intake_sources")
    .update({ last_received_at: now.toISOString() })
    .eq("id", source.id)
  if (touchError) throw new Error(`Failed to update the lead source: ${touchError.message}`)

  // Durable first: if this request dies mid-filing, the worker files it later.
  // The job waits five minutes so the inline attempt normally completes it.
  const job = await enqueueOutboxJob({
    orgId: source.org_id,
    jobType: LEAD_INTAKE_JOB_TYPE,
    payload: { receipt_id: receipt.id },
    runAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    dedupeByPayloadKeys: ["receipt_id"],
  })
  // An unexpected fault leaves the receipt received and the job pending: the
  // sender has been heard, so it gets a 202, never a 5xx that invites a resend.
  const outcome = await fileLeadReceipt(receipt.id, source.org_id).catch((): LeadReceiptOutcome => ({
    status: "retrying",
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  }))
  if (outcome.status !== "retrying" && job.enqueued) await completeOutboxJob(job.id)

  if (outcome.status === "failed") {
    return { status: 422, body: { receipt_id: receipt.id, status: "failed", reason: outcome.failureCode, detail: outcome.message } }
  }
  return { status: 202, body: { receipt_id: receipt.id, status: outcome.status === "retrying" ? "received" : outcome.status } }
}

async function findReceiptByKey(service: SupabaseClient, sourceId: string, idempotencyKey: string) {
  const { data, error } = await service
    .from("lead_intake_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("source_id", sourceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (error) throw new Error(`Failed to look up the delivery: ${error.message}`)
  return data ? receiptRowSchema.parse(data) : null
}

function replayResponse(existing: ReceiptRow, payloadHash: string): LeadDeliveryResponse {
  if (existing.payload_hash !== payloadHash) {
    return { status: 409, body: { error: "This Idempotency-Key was already used for a different submission", receipt_id: existing.id } }
  }
  return { status: 200, body: { receipt_id: existing.id, status: existing.status } }
}

export type LeadReceiptOutcome =
  | { status: "filed" | "merged"; prospectId: string }
  | { status: "failed"; failureCode: string; message: string }
  | { status: "retrying"; attempts: number; nextAttemptAt: string }
  | { status: "dismissed" | "rejected" }

/**
 * Files one logged delivery. Shared by the endpoint (inline), the outbox worker
 * and a consultant's Retry. Bad input fails at once and is shown to operators;
 * a database fault is retried with the outbox's backoff and fails visibly after
 * three attempts.
 */
export async function fileLeadReceipt(receiptId: string, orgId: string): Promise<LeadReceiptOutcome> {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("lead_intake_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", receiptId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the delivery: ${error.message}`)
  if (!data) throw new Error("Lead delivery not found")
  const receipt = receiptRowSchema.parse(data)
  if (receipt.status === "filed" || receipt.status === "merged") {
    return { status: receipt.status, prospectId: receipt.prospect_id ?? "" }
  }
  if (receipt.status === "dismissed" || receipt.status === "rejected") return { status: receipt.status }
  if (receipt.status === "failed") return { status: "failed", failureCode: receipt.failure_code ?? "filing_error", message: receipt.last_error ?? "" }

  const fail = async (failureCode: string, message: string, attempts = receipt.attempts): Promise<LeadReceiptOutcome> => {
    const { error: failError } = await service
      .from("lead_intake_receipts")
      .update({ status: "failed", failure_code: failureCode, last_error: message.slice(0, 2000), next_attempt_at: null, attempts })
      .eq("id", receipt.id)
    if (failError) throw new Error(`Failed to record the filing failure: ${failError.message}`)
    await recordEvent({ orgId, eventType: "lead_intake_failed", entityType: "lead_intake_receipt", entityId: receipt.id, payload: { failure_code: failureCode } })
    return { status: "failed", failureCode, message }
  }

  const parsed = leadSubmissionSchema.safeParse(receipt.payload)
  if (!parsed.success) return fail("invalid_payload", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  const submission = parsed.data
  const keys = leadContactKeys({ email: submission.email, phone: submission.phone })
  if (!keys) return fail("no_contact_key", "The submission has neither an email nor a phone number.")

  const { data: sourceRow, error: sourceError } = await service
    .from("lead_intake_sources")
    .select(SOURCE_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", receipt.source_id)
    .single()
  if (sourceError || !sourceRow) throw new Error(`Failed to load the lead source: ${sourceError?.message}`)
  const source = sourceRowSchema.parse(sourceRow)

  const community = await resolveCommunity(service, orgId, submission.community, source.default_community_id)
  if (community === "unknown") return fail("unknown_community", `No community matches “${submission.community ?? ""}”.`)

  try {
    const [routing, customBuildNavigation] = await Promise.all([
      routeWebLead(service, orgId, source, community, submission),
      orgShowsCustomBuildNavigation(service, orgId),
    ])
    const name = leadDisplayName({ name: submission.name, firstName: submission.first_name, lastName: submission.last_name })
      ?? submission.email
      ?? submission.phone
      ?? "Website lead"
    const lead: LeadFilingInput = {
      name,
      email: submission.email || null,
      phone: submission.phone || null,
      communityId: community?.id ?? null,
      ownerUserId: routing.ownerUserId,
      source: source.default_source_label,
      planInterest: submission.plan_interest ?? null,
      priceRange: submission.price_range ?? null,
      timeframe: submission.timeframe ?? null,
      notes: submission.message ?? null,
      channel: "web",
      occurredAt: submission.submitted_at ?? receipt.received_at,
      occurredOn: (submission.submitted_at ?? receipt.received_at).slice(0, 10),
      createdBy: null,
      routingOutcome: routing.outcome,
      routingReason: routing.reason,
      rotation: routing.rotation,
      attribution: submissionAttribution(source.default_source_label, submission),
    }
    const result = await fileLeadRecord(service, orgId, receipt.id, lead)
    const realtorName = submission.realtor?.name?.trim()
    await recordLeadFiled(service, {
      orgId,
      actorId: null,
      result,
      lead,
      receiptId: receipt.id,
      matchDirectoryByName: false,
      coopAgent: realtorName
        ? { name: realtorName, brokerage: submission.realtor?.brokerage || null, email: submission.realtor?.email || null, phone: submission.realtor?.phone || null }
        : null,
    })
    if (!result.replayed && result.owner_user_id && result.routing_outcome !== "existing_owner") {
      await new NotificationService().createAndQueue({
        orgId,
        userId: result.owner_user_id,
        type: "lead_assigned",
        title: `New lead: ${name}`,
        message: `${source.name}${community ? ` · ${community.name}` : ""}${submission.utm_campaign ? ` · ${submission.utm_campaign}` : ""}`,
        entityType: "prospect",
        entityId: result.prospect_id,
        metadata: { href: leadDealHref({ communityId: community?.id ?? null, prospectId: result.prospect_id }, { customBuildNavigation }) },
      })
    }
    return { status: result.outcome, prospectId: result.prospect_id }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    const attempts = receipt.attempts + 1
    if (caught instanceof LeadFilingError && caught.permanent) return fail("filing_error", message, attempts)
    if (attempts >= MAX_FILING_ATTEMPTS) return fail("filing_error", message, attempts)
    // The first retry is the job the endpoint queued five minutes out; the
    // outbox then backs off 15 minutes. The receipt says when, so the desk can
    // show "retrying at 10:45" rather than a spinner.
    const nextAttemptAt = new Date(Date.now() + Math.pow(3, attempts - 1) * 5 * 60 * 1000).toISOString()
    const { error: retryError } = await service
      .from("lead_intake_receipts")
      .update({ status: "received", attempts, last_error: message.slice(0, 2000), next_attempt_at: nextAttemptAt, failure_code: null })
      .eq("id", receipt.id)
    if (retryError) throw new Error(`Failed to record the filing attempt: ${retryError.message}`)
    return { status: "retrying", attempts, nextAttemptAt }
  }
}

/** The touch a submission records: the source's label and every campaign marker the form carried. */
function submissionAttribution(sourceLabel: string, submission: LeadSubmission): NonNullable<LeadFilingInput["attribution"]> {
  return {
    sourceLabel,
    utmSource: submission.utm_source,
    utmMedium: submission.utm_medium,
    utmCampaign: submission.utm_campaign,
    utmTerm: submission.utm_term,
    utmContent: submission.utm_content,
    clickIds: Object.fromEntries(
      (["gclid", "fbclid", "msclkid"] as const).flatMap((key) => (submission[key] ? [[key, submission[key] ?? ""]] : [])),
    ),
    referrerUrl: submission.referrer_url,
    landingUrl: submission.landing_url,
  }
}

/**
 * A failed delivery a consultant is about to file by hand from the inquiry
 * form: visible to them, still failed, and with the touch its submission
 * carried (the source's label alone when the submission could not be read).
 */
export async function leadReceiptForHandFiling(context: OrgServiceContext, receiptId: string) {
  const receipt = await loadVisibleReceipt(context, leadReceiptIdSchema.parse(receiptId))
  if (receipt.status !== "failed") throw new Error("Only a delivery that could not be filed is filed by hand. Refresh the desk.")
  // Source configuration is private to lead_intake.manage; the label is what the delivery was filed under.
  const { data, error } = await createServiceSupabaseClient().from("lead_intake_sources").select("default_source_label")
    .eq("org_id", context.orgId).eq("id", receipt.source_id).single()
  if (error) throw new Error(`Failed to load the lead source: ${error.message}`)
  const sourceLabel = z.string().parse(data.default_source_label)
  const submission = leadSubmissionSchema.safeParse(receipt.payload)
  return {
    receiptId: receipt.id,
    failureCode: receipt.failure_code,
    attribution: submission.success ? submissionAttribution(sourceLabel, submission.data) : { sourceLabel },
  }
}

/** The outbox handler: a delivery still retrying throws, so the worker backs off. */
export async function runLeadIntakeJob(orgId: string, payload: Record<string, unknown>) {
  const receiptId = leadReceiptIdSchema.parse(payload.receipt_id)
  const outcome = await fileLeadReceipt(receiptId, orgId)
  if (outcome.status === "retrying") throw new Error(`Lead delivery ${receiptId} will retry (attempt ${outcome.attempts} failed)`)
}

async function resolveCommunity(
  service: SupabaseClient,
  orgId: string,
  requested: string | null | undefined,
  fallbackId: string | null,
): Promise<{ id: string; name: string; divisionId: string | null } | null | "unknown"> {
  const wanted = requested?.trim() || null
  if (!wanted && !fallbackId) return null
  let query = service.from("communities").select("id, name, code, division_id").eq("org_id", orgId).is("archived_at", null)
  query = wanted
    ? z.string().uuid().safeParse(wanted).success
      ? query.eq("id", wanted)
      : query.ilike("code", wanted.replace(/[\\%_]/g, (character) => `\\${character}`))
    : query.eq("id", fallbackId ?? "")
  const { data, error } = await query.limit(2)
  if (error) throw new Error(`Failed to resolve the community: ${error.message}`)
  const rows = z.array(z.object({ id: z.string(), name: z.string(), division_id: nullableString })).parse(data ?? [])
  // Two communities sharing a code is not a community.
  if (rows.length !== 1) return "unknown"
  return { id: rows[0].id, name: rows[0].name, divisionId: rows[0].division_id }
}

async function routeWebLead(
  service: SupabaseClient,
  orgId: string,
  source: z.infer<typeof sourceRowSchema>,
  community: { id: string; divisionId: string | null } | null,
  submission: LeadSubmission,
) {
  const { data: ruleRows, error: rulesError } = await service
    .from("lead_routing_rules")
    .select(RULE_COLUMNS)
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .limit(200)
  if (rulesError) throw new Error(`Failed to load routing rules: ${rulesError.message}`)
  const rules = z.array(ruleRowSchema).parse(ruleRows ?? []).map(toRule)
  const candidates = [...new Set([...rules.map((rule) => rule.assignedUserId), ...(source.default_owner_user_id ? [source.default_owner_user_id] : [])])]
  const { data: contextData, error: contextError } = await service.rpc("lead_routing_context", {
    p_org_id: orgId,
    p_community_id: community?.id ?? null,
    p_candidate_ids: candidates,
  })
  if (contextError) throw new Error(`Failed to load routing context: ${contextError.message}`)
  const context = routingContextSchema.parse(contextData)
  return routeLead({
    lead: {
      sourceId: source.id,
      communityId: community?.id ?? null,
      divisionId: context.division_id,
      utmSource: submission.utm_source ?? null,
      utmCampaign: submission.utm_campaign ?? null,
    },
    rules,
    communityAssignees: context.community_assignees.map((row) => ({ userId: row.user_id, lastAssignedAt: row.last_assigned_at })),
    divisionDefaultUserId: context.division_default_user_id,
    sourceDefaultUserId: source.default_owner_user_id,
    eligibleUserIds: new Set(context.eligible_user_ids),
  })
}

/** The posture predicate's inputs, read without a signed-in user. */
async function orgShowsCustomBuildNavigation(service: SupabaseClient, orgId: string) {
  const [org, projects] = await Promise.all([
    service.from("orgs").select("product_tier").eq("id", orgId).single(),
    service
      .from("projects")
      .select("id")
      .eq("org_id", orgId)
      .eq("status", "active")
      .or("property_type.is.null,property_type.neq.production")
      .limit(1),
  ])
  if (org.error || projects.error) throw new Error(`Failed to read the org's posture: ${(org.error ?? projects.error)?.message}`)
  return shouldShowCustomBuildNavigation(normalizeProductTier(org.data?.product_tier), (projects.data ?? []).length > 0)
}

// ---------------------------------------------------------------------------
// The desk: what operators see and do
// ---------------------------------------------------------------------------

export type LeadAttentionKind = "failed" | "retrying" | "unrouted" | "duplicate"

export interface LeadAttentionRow {
  receiptId: string
  kind: LeadAttentionKind
  receivedAt: string
  sourceName: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  communityId: string | null
  communityName: string | null
  failureCode: string | null
  detail: string | null
  attempts: number
  nextAttemptAt: string | null
  routingOutcome: LeadRoutingOutcome | null
  dealHref: string | null
}

export interface LeadAttention {
  rows: LeadAttentionRow[]
  counts: Record<LeadAttentionKind, number>
  truncated: boolean
  canAct: boolean
}

/**
 * Deliveries a sales operator must deal with, in the desk's ambient scope:
 * failed (with why), still retrying (with when), filed but unrouted while the
 * deal still has no owner, and filed as a new deal that shares a phone with
 * another buyer's open deal until someone reviews it. Row-level security keeps
 * a division-limited consultant to their own divisions.
 */
export async function listLeadAttention(
  input: { desk: LeadDesk; customBuildNavigation: boolean; communityIds?: string[] | null },
  orgId?: string,
): Promise<LeadAttention> {
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(input.desk === "sales" ? ["sales.read"] : ["pipeline.read"], context)

  const scoped = (columns: string) => {
    let query = context.supabase.from("lead_intake_receipts").select(columns).eq("org_id", context.orgId)
    if (input.desk === "pipeline") query = query.is("community_id", null)
    else if (input.customBuildNavigation) query = query.not("community_id", "is", null)
    if (input.communityIds) {
      query = input.communityIds.length
        ? query.or(`community_id.is.null,community_id.in.(${input.communityIds.join(",")})`)
        : query.is("community_id", null)
    }
    return query.order("received_at", { ascending: false }).limit(ATTENTION_CAP + 1)
  }
  const display = `${RECEIPT_COLUMNS}, source:lead_intake_sources(name), community:communities(name)`
  const [stuck, unrouted, duplicates, canAct] = await Promise.all([
    scoped(display).or("status.eq.failed,and(status.eq.received,attempts.gt.0)"),
    // "Unrouted" stops mattering the moment someone owns the deal.
    scoped(`${display}, prospect:prospects!lead_intake_receipts_prospect_fkey!inner(owner_user_id)`)
      .in("status", ["filed", "merged"])
      .eq("routing_outcome", "unrouted")
      .is("prospect.owner_user_id", null),
    scoped(`${display}, duplicate:prospects!lead_intake_receipts_possible_duplicate_fkey(name)`)
      .eq("status", "filed")
      .not("possible_duplicate_prospect_id", "is", null)
      .is("resolved_at", null),
    requireAnyPermission(input.desk === "sales" ? ["sales.manage"] : ["pipeline.write"], context).then(() => true, () => false),
  ])
  const failure = stuck.error ?? unrouted.error ?? duplicates.error
  if (failure) throw new Error(`Failed to load lead deliveries: ${failure.message}`)
  const named = z.object({ name: z.string() }).nullable()
  const rowsSchema = z.array(receiptRowSchema.extend({ source: named, community: named, duplicate: named.optional() }))
  const tag = (data: unknown, kind: (row: z.infer<typeof rowsSchema>[number]) => LeadAttentionKind) =>
    rowsSchema.parse(data ?? []).map((row) => ({ row, kind: kind(row) }))
  const tagged = [
    ...tag(stuck.data, (row) => (row.status === "failed" ? "failed" : "retrying")),
    ...tag(unrouted.data, () => "unrouted"),
    ...tag(duplicates.data, () => "duplicate"),
  ]
  // A lead both unrouted and flagged shows once, as unrouted: assigning it opens the deal either way.
  const rows = tagged.filter((entry, index) => tagged.findIndex((other) => other.row.id === entry.row.id) === index)
    .sort((a, b) => b.row.received_at.localeCompare(a.row.received_at))

  const attention = rows.map(({ row, kind }): LeadAttentionRow => {
    return {
      receiptId: row.id,
      kind,
      receivedAt: row.received_at,
      sourceName: row.source?.name ?? "Lead source",
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      communityId: row.community_id,
      communityName: row.community?.name ?? null,
      failureCode: row.failure_code,
      detail: kind === "unrouted" ? row.routing_reason
        : kind === "duplicate" ? `Same phone as ${row.duplicate?.name ?? "another buyer"}'s open deal, different email`
        : row.last_error,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      routingOutcome: isLeadRoutingOutcome(row.routing_outcome) ? row.routing_outcome : null,
      dealHref: row.prospect_id
        ? leadDealHref({ communityId: row.community_id, prospectId: row.prospect_id }, { customBuildNavigation: input.customBuildNavigation })
        : null,
    }
  })
  const visible = attention.slice(0, ATTENTION_CAP)
  const count = (kind: LeadAttentionKind) => visible.filter((row) => row.kind === kind).length
  return {
    rows: visible,
    counts: { failed: count("failed"), retrying: count("retrying"), unrouted: count("unrouted"), duplicate: count("duplicate") },
    truncated: attention.length > ATTENTION_CAP || [stuck, unrouted, duplicates].some((result) => (result.data ?? []).length > ATTENTION_CAP),
    canAct,
  }
}

async function loadVisibleReceipt(context: OrgServiceContext, receiptId: string) {
  // Read as the caller: the division wall decides whether they may see it at all.
  const { data, error } = await context.supabase
    .from("lead_intake_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("org_id", context.orgId)
    .eq("id", receiptId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the delivery: ${error.message}`)
  if (!data) throw new Error("Lead delivery not found")
  return receiptRowSchema.parse(data)
}

/** A consultant files a failed delivery again, after fixing whatever failed it. */
export async function retryLeadReceipt(receiptId: string, orgId?: string): Promise<LeadReceiptOutcome> {
  const id = leadReceiptIdSchema.parse(receiptId)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(DEAL_WRITE_PERMISSIONS, context)
  const receipt = await loadVisibleReceipt(context, id)
  if (receipt.status !== "failed") throw new Error("Only a failed delivery can be retried.")

  const service = createServiceSupabaseClient()
  const { data: reset, error } = await service
    .from("lead_intake_receipts")
    .update({ status: "received", attempts: 0, failure_code: null, next_attempt_at: null })
    .eq("id", receipt.id)
    .eq("status", "failed")
    .select("id")
    .maybeSingle()
  if (error) throw new Error(`Failed to retry the delivery: ${error.message}`)
  if (!reset) throw new Error("This delivery changed. Refresh and try again.")

  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "lead_intake_receipt",
    entityId: receipt.id,
    before: { status: receipt.status, failure_code: receipt.failure_code },
    after: { status: "received" },
  })
  const outcome = await fileLeadReceipt(receipt.id, context.orgId)
  if (outcome.status === "retrying") {
    await enqueueOutboxJob({
      orgId: context.orgId,
      jobType: LEAD_INTAKE_JOB_TYPE,
      payload: { receipt_id: receipt.id },
      runAt: outcome.nextAttemptAt,
      dedupeByPayloadKeys: ["receipt_id"],
    })
  }
  return outcome
}

/** Closing a delivery nobody will file (spam, a test, a duplicate entered by hand). */
export async function dismissLeadReceipt(input: DismissLeadReceiptInput, orgId?: string): Promise<void> {
  const parsed = dismissLeadReceiptInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(DEAL_WRITE_PERMISSIONS, context)
  const receipt = await loadVisibleReceipt(context, parsed.receiptId)
  if (receipt.status !== "failed") throw new Error("Only a failed delivery can be dismissed.")

  const resolvedAt = new Date().toISOString()
  const { data, error } = await createServiceSupabaseClient()
    .from("lead_intake_receipts")
    .update({ status: "dismissed", resolved_by: context.userId, resolved_at: resolvedAt, resolution_note: parsed.note })
    .eq("id", receipt.id)
    .eq("status", "failed")
    .select("id")
    .maybeSingle()
  if (error) throw new Error(`Failed to dismiss the delivery: ${error.message}`)
  if (!data) throw new Error("This delivery changed. Refresh and try again.")

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "lead_intake_dismissed",
      entityType: "lead_intake_receipt",
      entityId: receipt.id,
      payload: { note: parsed.note, failure_code: receipt.failure_code },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "lead_intake_receipt",
      entityId: receipt.id,
      before: { status: receipt.status },
      after: { status: "dismissed", resolution_note: parsed.note, resolved_at: resolvedAt },
    }),
  ])
}

/**
 * A lead flagged as a possible duplicate (same phone, different email) was
 * looked at and is its own buyer. Merging two deals that are one buyer stays
 * the pipeline's job; this only takes the flag off the desk.
 */
export async function confirmLeadNotDuplicate(receiptId: string, orgId?: string): Promise<void> {
  const id = leadReceiptIdSchema.parse(receiptId)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(DEAL_WRITE_PERMISSIONS, context)
  const receipt = await loadVisibleReceipt(context, id)
  if (receipt.status !== "filed" || !receipt.possible_duplicate_prospect_id) throw new Error("This lead is not flagged as a possible duplicate.")

  const resolvedAt = new Date().toISOString()
  const note = "Reviewed: not the same buyer"
  const { data, error } = await createServiceSupabaseClient()
    .from("lead_intake_receipts")
    .update({ resolved_by: context.userId, resolved_at: resolvedAt, resolution_note: note })
    .eq("id", receipt.id)
    .eq("status", "filed")
    .is("resolved_at", null)
    .select("id")
    .maybeSingle()
  if (error) throw new Error(`Failed to clear the duplicate flag: ${error.message}`)
  if (!data) throw new Error("This lead changed. Refresh and try again.")

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "lead_duplicate_reviewed",
      entityType: "lead_intake_receipt",
      entityId: receipt.id,
      payload: { prospect_id: receipt.prospect_id, possible_duplicate_of: receipt.possible_duplicate_prospect_id },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "lead_intake_receipt",
      entityId: receipt.id,
      before: { resolved_at: null },
      after: { resolved_at: resolvedAt, resolution_note: note },
    }),
  ])
}

// ---------------------------------------------------------------------------
// Settings: sources, rules, division fallback owners
// ---------------------------------------------------------------------------

export interface LeadSourceDTO {
  id: string
  name: string
  publicId: string
  endpointUrl: string
  secretHint: string
  defaultSourceLabel: string
  defaultCommunityId: string | null
  defaultOwnerUserId: string | null
  status: "active" | "disabled"
  lastReceivedAt: string | null
  lastRejectedAt: string | null
  lastRejectionReason: string | null
  rejectedCount: number
  previousSecretExpiresAt: string | null
}

export interface LeadIntakeSettings {
  sources: LeadSourceDTO[]
  rules: LeadRoutingRule[]
  divisions: Array<{ id: string; name: string; defaultLeadOwnerUserId: string | null }>
  communities: Array<{ id: string; name: string; code: string | null }>
  /** Deliveries per source in the last seven days, by status. */
  recent: Record<string, { filed: number; failed: number; rejected: number }>
}

const SETTINGS_CAP = 50

function endpointUrl(publicId: string) {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
  return `${base}/api/leads/intake/${publicId}`
}

function toSourceDTO(row: z.infer<typeof sourceRowSchema>): LeadSourceDTO {
  return {
    id: row.id,
    name: row.name,
    publicId: row.public_id,
    endpointUrl: endpointUrl(row.public_id),
    secretHint: row.secret_hint,
    defaultSourceLabel: row.default_source_label,
    defaultCommunityId: row.default_community_id,
    defaultOwnerUserId: row.default_owner_user_id,
    status: row.status,
    lastReceivedAt: row.last_received_at,
    lastRejectedAt: row.last_rejected_at,
    lastRejectionReason: row.last_rejection_reason,
    rejectedCount: row.rejected_count,
    previousSecretExpiresAt: row.previous_secret_expires_at,
  }
}

export async function getLeadIntakeSettings(orgId?: string): Promise<LeadIntakeSettings> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [sources, rules, divisions, communities, recent] = await Promise.all([
    context.supabase.from("lead_intake_sources").select(SOURCE_COLUMNS).eq("org_id", context.orgId).order("created_at").limit(SETTINGS_CAP),
    context.supabase.from("lead_routing_rules").select(RULE_COLUMNS).eq("org_id", context.orgId).order("priority").order("created_at").limit(SETTINGS_CAP),
    context.supabase.from("divisions").select("id, name, default_lead_owner_user_id").eq("org_id", context.orgId).is("archived_at", null).order("name"),
    context.supabase.from("communities").select("id, name, code").eq("org_id", context.orgId).is("archived_at", null).order("name").limit(500),
    createServiceSupabaseClient()
      .from("lead_intake_receipts")
      .select("source_id, status")
      .eq("org_id", context.orgId)
      .gte("received_at", since)
      .limit(5000),
  ])
  const failure = sources.error ?? rules.error ?? divisions.error ?? communities.error ?? recent.error
  if (failure) throw new Error(`Failed to load lead intake settings: ${failure.message}`)

  const counts: LeadIntakeSettings["recent"] = {}
  for (const row of z.array(z.object({ source_id: z.string(), status: z.string() })).parse(recent.data ?? [])) {
    const bucket = (counts[row.source_id] ??= { filed: 0, failed: 0, rejected: 0 })
    if (row.status === "filed" || row.status === "merged") bucket.filed += 1
    else if (row.status === "failed") bucket.failed += 1
    else if (row.status === "rejected") bucket.rejected += 1
  }
  return {
    sources: z.array(sourceRowSchema).parse(sources.data ?? []).map(toSourceDTO),
    rules: z.array(ruleRowSchema).parse(rules.data ?? []).map(toRule),
    divisions: z
      .array(z.object({ id: z.string(), name: z.string(), default_lead_owner_user_id: nullableString }))
      .parse(divisions.data ?? [])
      .map((row) => ({ id: row.id, name: row.name, defaultLeadOwnerUserId: row.default_lead_owner_user_id })),
    communities: z.array(z.object({ id: z.string(), name: z.string(), code: nullableString })).parse(communities.data ?? []),
    recent: counts,
  }
}

const PUBLIC_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

function newPublicId() {
  return `lis_${Array.from(randomBytes(24), (byte) => PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length]).join("")}`
}

function newSigningSecret() {
  return `arcwh_${randomBytes(32).toString("base64url")}`
}

async function assertActiveMember(context: OrgServiceContext, userId: string | null | undefined) {
  if (!userId) return
  const { data, error } = await context.supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", context.orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle()
  if (error) throw new Error(`Failed to check the team member: ${error.message}`)
  if (!data) throw new Error("Choose an active team member in this organization.")
}

async function assertOrgCommunity(context: OrgServiceContext, communityId: string | null | undefined) {
  if (!communityId) return
  const { data, error } = await context.supabase
    .from("communities")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", communityId)
    .is("archived_at", null)
    .maybeSingle()
  if (error) throw new Error(`Failed to check the community: ${error.message}`)
  if (!data) throw new Error("Community not found")
}

/** A new feed. The signing secret is returned once and never readable again. */
export async function createLeadSource(input: CreateLeadSourceInput, orgId?: string): Promise<{ source: LeadSourceDTO; secret: string }> {
  const parsed = createLeadSourceInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  await Promise.all([assertOrgCommunity(context, parsed.defaultCommunityId), assertActiveMember(context, parsed.defaultOwnerUserId)])

  const secret = newSigningSecret()
  const { data, error } = await createServiceSupabaseClient()
    .from("lead_intake_sources")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      public_id: newPublicId(),
      signing_secret_encrypted: encryptIntegrationSecret(secret),
      secret_hint: secret.slice(-4),
      default_source_label: parsed.defaultSourceLabel,
      default_community_id: parsed.defaultCommunityId ?? null,
      default_owner_user_id: parsed.defaultOwnerUserId ?? null,
      created_by: context.userId,
    })
    .select(SOURCE_COLUMNS)
    .single()
  if (error || !data) throw new Error(`Failed to create the lead source: ${error?.message}`)
  const source = sourceRowSchema.parse(data)

  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lead_source_created", entityType: "lead_intake_source", entityId: source.id, payload: { name: source.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "lead_intake_source", entityId: source.id, after: data }),
  ])
  return { source: toSourceDTO(source), secret }
}

/**
 * A new signing secret, shown once. The previous one keeps working for 24
 * hours so the website can be redeployed without dropping leads.
 */
export async function rotateLeadSourceSecret(sourceId: string, orgId?: string): Promise<{ source: LeadSourceDTO; secret: string }> {
  const id = leadSourceIdSchema.parse(sourceId)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  const service = createServiceSupabaseClient()
  const { data: current, error: currentError } = await service
    .from("lead_intake_sources")
    .select(`${SOURCE_COLUMNS}, signing_secret_encrypted, previous_secret_encrypted`)
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (currentError) throw new Error(`Failed to load the lead source: ${currentError.message}`)
  if (!current) throw new Error("Lead source not found")
  const existing = sourceSecretRowSchema.parse(current)

  const secret = newSigningSecret()
  const { data, error } = await service
    .from("lead_intake_sources")
    .update({
      signing_secret_encrypted: encryptIntegrationSecret(secret),
      previous_secret_encrypted: existing.signing_secret_encrypted,
      previous_secret_expires_at: new Date(Date.now() + SECRET_ROTATION_GRACE_MS).toISOString(),
      secret_hint: secret.slice(-4),
    })
    .eq("id", existing.id)
    .eq("signing_secret_encrypted", existing.signing_secret_encrypted)
    .select(SOURCE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Failed to rotate the secret: ${error.message}`)
  if (!data) throw new Error("The secret was rotated by someone else. Refresh before rotating again.")
  const source = sourceRowSchema.parse(data)

  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lead_source_secret_rotated", entityType: "lead_intake_source", entityId: source.id, payload: { name: source.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lead_intake_source", entityId: source.id, before: { secret_hint: existing.secret_hint }, after: { secret_hint: source.secret_hint } }),
  ])
  return { source: toSourceDTO(source), secret }
}

/** Disabling answers every delivery with 404; nothing already filed changes. */
export async function setLeadSourceStatus(input: { sourceId: string; status: "active" | "disabled" }, orgId?: string): Promise<LeadSourceDTO> {
  const parsed = setLeadSourceStatusInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  const { data, error } = await createServiceSupabaseClient()
    .from("lead_intake_sources")
    .update({ status: parsed.status })
    .eq("org_id", context.orgId)
    .eq("id", parsed.sourceId)
    .select(SOURCE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Failed to update the lead source: ${error.message}`)
  if (!data) throw new Error("Lead source not found")
  const source = sourceRowSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: parsed.status === "disabled" ? "lead_source_disabled" : "lead_source_enabled", entityType: "lead_intake_source", entityId: source.id, payload: { name: source.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lead_intake_source", entityId: source.id, after: { status: parsed.status } }),
  ])
  return toSourceDTO(source)
}

export async function createLeadRoutingRule(input: LeadRoutingRuleInput, orgId?: string): Promise<LeadRoutingRule> {
  const parsed = leadRoutingRuleInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  await Promise.all([assertOrgCommunity(context, parsed.communityId), assertActiveMember(context, parsed.assignedUserId)])
  const { data, error } = await context.supabase
    .from("lead_routing_rules")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      priority: parsed.priority,
      source_id: parsed.sourceId ?? null,
      community_id: parsed.communityId ?? null,
      division_id: parsed.divisionId ?? null,
      utm_source: parsed.utmSource || null,
      utm_campaign: parsed.utmCampaign || null,
      assigned_user_id: parsed.assignedUserId,
      created_by: context.userId,
    })
    .select(RULE_COLUMNS)
    .single()
  if (error || !data) throw new Error(`Failed to save the routing rule: ${error?.message}`)
  const rule = toRule(ruleRowSchema.parse(data))
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lead_routing_rule_created", entityType: "lead_routing_rule", entityId: rule.id, payload: { name: rule.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "lead_routing_rule", entityId: rule.id, after: data }),
  ])
  return rule
}

export async function deleteLeadRoutingRule(ruleId: string, orgId?: string): Promise<void> {
  const id = z.string().uuid().parse(ruleId)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  const { data, error } = await context.supabase
    .from("lead_routing_rules")
    .delete()
    .eq("org_id", context.orgId)
    .eq("id", id)
    .select(RULE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Failed to delete the routing rule: ${error.message}`)
  if (!data) throw new Error("Routing rule not found")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lead_routing_rule_deleted", entityType: "lead_routing_rule", entityId: id, payload: {} }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "lead_routing_rule", entityId: id, before: data }),
  ])
}

/** Who takes a division's leads when no community consultant can. */
export async function setDivisionLeadOwner(input: { divisionId: string; ownerUserId: string | null }, orgId?: string): Promise<void> {
  const parsed = divisionLeadOwnerInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lead_intake.manage", context)
  await assertActiveMember(context, parsed.ownerUserId)
  const { data, error } = await context.supabase
    .from("divisions")
    .update({ default_lead_owner_user_id: parsed.ownerUserId })
    .eq("org_id", context.orgId)
    .eq("id", parsed.divisionId)
    .select("id, default_lead_owner_user_id")
    .maybeSingle()
  if (error) throw new Error(`Failed to set the division's lead owner: ${error.message}`)
  if (!data) throw new Error("Division not found")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "division_lead_owner_set", entityType: "division", entityId: parsed.divisionId, payload: { owner_user_id: parsed.ownerUserId } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "division", entityId: parsed.divisionId, after: data }),
  ])
}
