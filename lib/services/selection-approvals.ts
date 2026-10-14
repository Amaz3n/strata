import { createHash, randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { SelectionApprovalRequestEmail } from "@/lib/emails/selection-approval-request-email"
import { renderSelectionApprovalPdf } from "@/lib/pdfs/selection-approval"
import {
  approvalBlocker,
  latestApproval,
  selectionApprovalState,
  type SelectionApprovalState,
  type SelectionApprovalStatus,
  type SelectionApprovalSummary,
  type SelectionTermsSummary,
} from "@/lib/selections/approval-state"
import { recordAudit } from "@/lib/services/audit"
import { isPlaceholderEmail } from "@/lib/emails/recipient-policy"
import { requireAuthorization } from "@/lib/services/authorization"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { requireOrgContext } from "@/lib/services/context"
import { ensureFrozenSigningSource } from "@/lib/services/esign-execution"
import { getOrgBranding } from "@/lib/services/estimate-portal"
import { validateDocumentUpload } from "@/lib/files/content-policy"
import { createFileRecord } from "@/lib/services/files"
import { readHomePricingScope } from "@/lib/services/home-pricing-scope"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { NotificationService } from "@/lib/services/notifications"
import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { requirePermission } from "@/lib/services/permissions"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { buildOrgScopedPath, uploadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { NotificationType } from "@/lib/types/notifications"
import {
  inPersonSelectionApprovalSchema,
  portalSelectionApprovalSchema,
  portalSelectionDeclineSchema,
  resendSelectionApprovalSchema,
  sendSelectionApprovalSchema,
  signedCopyUploadSchema,
  voidSelectionApprovalSchema,
  type InPersonSelectionApprovalInput,
  type ResendSelectionApprovalInput,
  type SendSelectionApprovalInput,
  type SignedCopyUploadInput,
  type VoidSelectionApprovalInput,
} from "@/lib/validation/design-studio"

/**
 * A buyer approves a group's selections exactly as they were sent.
 *
 * Every rule that makes the approval binding is in the database
 * (20261013100000): `selection_terms` is the one reading of a group's terms
 * and their hash; sending freezes the lines; a change after sending voids the
 * request and its envelope; an approval re-reads the terms under the home's
 * selection lock and confirms each selection at the frozen price; decline,
 * void and expiry of the envelope reach the request by trigger. This service
 * authorizes the caller, checks the choices are still on sale and valid
 * together, renders and publishes the signing document, tells the buyer, and
 * tells the people running the home how it ended.
 */

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

const NOTIFY_RECIPIENT_CAP = 25
const APPROVAL_HISTORY_CAP = 200

export const SELECTION_APPROVAL_OUTCOME_JOB_TYPE = "notify_selection_approval_outcome"

/** The database's refusals are written for the person reading them. */
const REFUSALS = new Set([
  "SELECTION_TERMS_EMPTY",
  "SELECTION_TERMS_CHANGED",
  "SELECTION_TERMS_INCOMPLETE",
  "SELECTION_ALREADY_APPROVED",
  "SELECTION_LOCKED_CUTOFF",
  "SELECTION_APPROVAL_PENDING",
  "SELECTION_SIGNED_COPY_REQUIRED",
  "SELECTION_BUYER_EMAIL",
])

class SelectionApprovalRefusedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "SelectionApprovalRefusedError"
  }
}

function rpcError(error: { message: string; details?: string | null }, fallback: string): Error {
  if (error.details && REFUSALS.has(error.details)) return new SelectionApprovalRefusedError(error.message, error.details)
  return new Error(`${fallback}: ${error.message}`)
}

const approvalRowSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
  channel: z.enum(["esign", "portal", "in_person"]),
  status: z.enum(["sent", "approved", "declined", "expired", "voided"]),
  terms_hash: z.string(),
  total_cents: z.coerce.number(),
  sent_at: z.string(),
  expires_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  decline_reason: z.string().nullable(),
  void_reason: z.string().nullable(),
  sent_by: z.string().uuid().nullable(),
  envelope_id: z.string().uuid().nullable(),
})
type ApprovalRow = z.infer<typeof approvalRowSchema>

function toSummary(row: ApprovalRow): SelectionApprovalSummary {
  return {
    id: row.id,
    status: row.status,
    channel: row.channel,
    termsHash: row.terms_hash,
    totalCents: row.total_cents,
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    declineReason: row.decline_reason,
    voidReason: row.void_reason,
  }
}

const termsSchema = z.object({
  group_id: z.string().uuid().nullable(),
  terms_hash: z.string(),
  total_cents: z.coerce.number(),
  line_count: z.coerce.number(),
  complete: z.boolean(),
  confirmed: z.boolean(),
})

export interface GroupSelectionApproval {
  groupId: string | null
  groupName: string
  cutoffDate: string | null
  locked: boolean
  terms: SelectionTermsSummary
  state: SelectionApprovalState
  /** Why the state is what it is: the decline note, or why a request was voided. */
  reason: string | null
  latest: SelectionApprovalSummary | null
  /** Why a new request cannot go out now; null when it can. */
  blocker: string | null
  history: SelectionApprovalSummary[]
}

/** Every group on a home, its current terms and where its buyer approval stands. */
async function readHomeApprovals(db: SupabaseClient, orgId: string, projectId: string): Promise<GroupSelectionApproval[]> {
  const [termsResult, approvalsResult, groupsResult] = await Promise.all([
    db.rpc("selection_home_terms", { p_org_id: orgId, p_project_id: projectId }),
    db.from("selection_approvals").select("*").eq("org_id", orgId).eq("project_id", projectId).order("sent_at", { ascending: false }).limit(APPROVAL_HISTORY_CAP),
    db.from("project_selection_groups").select("group_id, cutoff_date, status, group:selection_groups(name, sort_order)").eq("org_id", orgId).eq("project_id", projectId),
  ])
  if (termsResult.error) throw new Error(`Failed to read the home's selections: ${termsResult.error.message}`)
  if (approvalsResult.error) throw new Error(`Failed to load selection approvals: ${approvalsResult.error.message}`)
  if (groupsResult.error) throw new Error(`Failed to load selection groups: ${groupsResult.error.message}`)
  const terms = z.array(termsSchema).parse(termsResult.data ?? [])
  const approvals = (approvalsResult.data ?? []).map((row) => approvalRowSchema.parse(row))
  const now = new Date()
  return terms
    .map((groupTerms) => {
      const instance = (groupsResult.data ?? []).find((row) => row.group_id === groupTerms.group_id)
      const group = Array.isArray(instance?.group) ? instance?.group[0] : instance?.group
      const history = approvals.filter((row) => row.group_id === groupTerms.group_id).map(toSummary)
      const latest = latestApproval(history)
      const { state, reason } = selectionApprovalState(latest, now)
      const summary: SelectionTermsSummary = {
        termsHash: groupTerms.terms_hash,
        totalCents: groupTerms.total_cents,
        lineCount: groupTerms.line_count,
        complete: groupTerms.complete,
        confirmed: groupTerms.confirmed,
      }
      const locked = instance?.status === "locked"
      return {
        groupId: groupTerms.group_id,
        groupName: (group?.name as string | undefined) ?? "Selections",
        cutoffDate: (instance?.cutoff_date as string | null | undefined) ?? null,
        locked,
        terms: summary,
        state,
        reason,
        latest,
        blocker: approvalBlocker(state, summary, locked),
        history,
        sortOrder: (group?.sort_order as number | undefined) ?? Number.MAX_SAFE_INTEGER,
      }
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.groupName.localeCompare(b.groupName))
    .map(({ sortOrder: _sortOrder, ...group }) => group)
}

async function authorizeHome(context: OrgContext, projectId: string, permission: "selections.read" | "selections.write") {
  await requirePermission(permission, context)
  await requireAuthorization({ permission, orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase, resourceType: "project", resourceId: projectId })
}

export async function listHomeSelectionApprovals(projectId: string): Promise<GroupSelectionApproval[]> {
  const context = await requireOrgContext()
  await authorizeHome(context, projectId, "selections.read")
  return readHomeApprovals(createServiceSupabaseClient(), context.orgId, projectId)
}

/** The buyer portal's read; the portal token was checked by the caller. */
export async function listPortalSelectionApprovals(orgId: string, projectId: string): Promise<GroupSelectionApproval[]> {
  return readHomeApprovals(createServiceSupabaseClient(), orgId, projectId)
}

/**
 * Before anything is approved or sent: every chosen option is still sold for
 * this home in its category, and the home's choices are valid together. (Once
 * sent, a withdrawn option still binds at the price the builder offered.)
 */
async function assertChoicesStillValid(db: SupabaseClient, orgId: string, projectId: string, groupId: string | null) {
  let query = db.from("project_selections").select("id, category_id, selected_option_id").eq("org_id", orgId).eq("project_id", projectId)
  query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null)
  const { data, error } = await query.limit(500)
  if (error) throw new Error(`Failed to load the selections: ${error.message}`)
  const chosen = (data ?? []).filter((row): row is { id: string; category_id: string; selected_option_id: string } => typeof row.selected_option_id === "string")
  if (chosen.length) {
    const { pricing } = await readHomePricingScope(db, orgId, projectId)
    const resolved = await resolveOptionPricing({ orgId, items: chosen.map((row) => ({ optionId: row.selected_option_id })), ...pricing })
    for (const [index, row] of chosen.entries()) {
      const price = resolved[index]
      if (!price?.available) throw new Error("This option is no longer available for this home. Choose an available option before confirming.")
      if (!price.categoryIds.includes(row.category_id)) throw new Error("This option belongs to a different selection category")
    }
  }
  await assertProjectConfiguration(orgId, projectId)
}

/**
 * An answer to a request that is still out binds at the terms that were sent:
 * the database verifies the hash, and an option withdrawn since is not a
 * reason to refuse. Only an approval with no live request behind it (a buyer
 * confirming on their own, a coordinator recording paper) checks the choices.
 */
async function assertChoicesUnlessRequested(
  db: SupabaseClient, orgId: string, projectId: string, groupId: string | null, channel: "portal" | "in_person", termsHash: string,
) {
  let query = db.from("selection_approvals").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("project_id", projectId).eq("status", "sent").eq("channel", channel).eq("terms_hash", termsHash)
  query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null)
  const { count, error } = await query
  if (error) throw new Error(`Failed to check for a request still out: ${error.message}`)
  if ((count ?? 0) > 0) return
  await assertChoicesStillValid(db, orgId, projectId, groupId)
}

async function loadApproval(db: SupabaseClient, orgId: string, approvalId: string): Promise<ApprovalRow> {
  const { data, error } = await db.from("selection_approvals").select("*").eq("org_id", orgId).eq("id", approvalId).maybeSingle()
  if (error) throw new Error(`Failed to load the approval: ${error.message}`)
  if (!data) throw new Error("Selection approval not found")
  return approvalRowSchema.parse(data)
}

async function homeFacts(db: SupabaseClient, orgId: string, projectId: string, groupId: string | null) {
  const [projectResult, groupResult, buyerResult] = await Promise.all([
    db.from("projects").select("name").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    groupId ? db.from("selection_groups").select("name").eq("org_id", orgId).eq("id", groupId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.rpc("selection_home_buyer", { p_org_id: orgId, p_project_id: projectId }),
  ])
  if (buyerResult.error) throw new Error(`Failed to load the home's buyer: ${buyerResult.error.message}`)
  const buyerId = typeof buyerResult.data === "string" ? buyerResult.data : null
  const { data: buyer } = buyerId
    ? await db.from("contacts").select("id, full_name, email").eq("org_id", orgId).eq("id", buyerId).maybeSingle()
    : { data: null }
  return {
    homeName: (projectResult.data?.name as string | undefined) ?? null,
    groupName: (groupResult.data?.name as string | undefined) ?? "Selections",
    buyer: buyer ? { id: buyer.id as string, name: (buyer.full_name as string | null) ?? null, email: (buyer.email as string | null) ?? null } : null,
  }
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

/** Renders the frozen lines, files the PDF on the home, and sends it to the buyer bound to the request. */
async function publishSigningDocument(context: OrgContext, db: SupabaseClient, approval: ApprovalRow): Promise<string> {
  const [facts, branding, linesResult] = await Promise.all([
    homeFacts(db, context.orgId, approval.project_id, approval.group_id),
    getOrgBranding(context.orgId, db),
    db.from("selection_approval_lines").select("selection_id, category_name, option_name, package_name, price_cents").eq("org_id", context.orgId).eq("approval_id", approval.id).order("category_name"),
  ])
  if (linesResult.error) throw new Error(`Failed to load the approval's lines: ${linesResult.error.message}`)
  if (!facts.buyer?.email || isPlaceholderEmail(facts.buyer.email)) throw new SelectionApprovalRefusedError("The home's buyer needs a real email address before selections can be sent for signature", "SELECTION_BUYER_EMAIL")
  const pdf = await renderSelectionApprovalPdf({
    orgName: branding.name, orgLogoUrl: branding.logoUrl, orgAddress: branding.address,
    homeName: facts.homeName, buyerName: facts.buyer.name, buyerEmail: facts.buyer.email, groupName: facts.groupName,
    sentAt: approval.sent_at, expiresAt: approval.expires_at, termsHash: approval.terms_hash, totalCents: approval.total_cents,
    lines: (linesResult.data ?? []).map((line) => ({
      selectionId: line.selection_id as string, categoryName: line.category_name as string,
      optionName: (line.option_name as string | null) ?? null, packageName: (line.package_name as string | null) ?? null, priceCents: line.price_cents as number,
    })),
  })
  const fileName = `selections-${facts.groupName}-${approval.terms_hash.slice(0, 8)}.pdf`.replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = buildOrgScopedPath(context.orgId, "projects", approval.project_id, "esign", "source", `${randomUUID()}_${fileName}`)
  await uploadFilesObject({ supabase: db, orgId: context.orgId, path: storagePath, bytes: pdf, contentType: "application/pdf", upsert: false })
  const file = await createFileRecord({
    project_id: approval.project_id, file_name: fileName, storage_path: storagePath, mime_type: "application/pdf", size_bytes: pdf.length,
    checksum: createHash("sha256").update(pdf).digest("hex"), visibility: "private", category: "contracts", folder_path: "/contracts", source: "generated",
  }, context.orgId, { authorizationPermission: "selections.write" })
  const title = `${facts.groupName} selections${facts.homeName ? ` — ${facts.homeName}` : ""}`
  const reserved = await db.rpc("reserve_selection_approval_document", { p_org_id: context.orgId, p_approval_id: approval.id, p_actor_id: context.userId, p_file_id: file.id, p_title: title })
  const documentId = z.string().uuid().safeParse(reserved.data)
  if (reserved.error || !documentId.success) throw new Error(`The signing document could not be filed: ${reserved.error?.message ?? "no document"}`)
  const source = await ensureFrozenSigningSource(context.orgId, documentId.data)
  const published = await db.rpc("publish_selection_approval_document", {
    p_org_id: context.orgId, p_approval_id: approval.id, p_actor_id: context.userId, p_source: source,
    p_subject: `Approve your ${facts.groupName.toLowerCase()} selections`, p_message: "Review each selection and its price, then sign to approve them.",
  })
  const envelopeId = z.string().uuid().safeParse(published.data)
  if (published.error) throw rpcError(published.error, "The signing document could not be sent")
  if (!envelopeId.success) throw new Error("The signing document was not sent")
  return envelopeId.data
}

type BuyerEmailOutcome = "sent" | "no_email" | "failed"

async function emailPortalRequest(
  context: OrgContext, db: SupabaseClient, approval: ApprovalRow, idempotencyKey: string,
): Promise<BuyerEmailOutcome> {
  const lines = await db.from("selection_approval_lines").select("selection_id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("approval_id", approval.id)
  const lineCount = lines.count ?? 0
  const facts = await homeFacts(db, context.orgId, approval.project_id, approval.group_id)
  // A reserved placeholder address can never receive the request; a resend cannot fix it.
  if (!facts.buyer?.email || isPlaceholderEmail(facts.buyer.email)) return "no_email"
  const [portal, org] = await Promise.all([
    ensurePortalLink({ supabase: db, orgId: context.orgId, projectId: approval.project_id, portalType: "client", contactId: facts.buyer.id, createdBy: context.userId, capabilities: { can_submit_selections: true }, fallbackPath: "/" }),
    db.from("orgs").select("name, slug, logo_url").eq("id", context.orgId).maybeSingle(),
  ])
  const html = await renderEmailTemplate(SelectionApprovalRequestEmail({
    orgName: org.data?.name ?? null, orgLogoUrl: org.data?.logo_url ?? null, recipientName: facts.buyer.name, homeName: facts.homeName,
    groupName: facts.groupName, totalText: formatMoney(approval.total_cents), lineCount,
    respondByText: approval.expires_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(Date.parse(approval.expires_at) - 1)) : null,
    actionHref: `${portal}/selections`,
  }))
  const delivered = await sendEmail({
    to: [facts.buyer.email], subject: `Please approve your ${facts.groupName.toLowerCase()} selections`, html, from: getOrgSenderEmail(org.data?.slug, org.data?.name),
    idempotencyKey,
  })
  return delivered ? "sent" : "failed"
}

export async function sendSelectionApproval(raw: SendSelectionApprovalInput): Promise<{ approvalId: string; envelopeId: string | null; buyerEmail: BuyerEmailOutcome }> {
  const input = sendSelectionApprovalSchema.parse(raw)
  const context = await requireOrgContext()
  await authorizeHome(context, input.projectId, "selections.write")
  const db = createServiceSupabaseClient()
  await assertChoicesStillValid(db, context.orgId, input.projectId, input.groupId)
  const sent = await db.rpc("send_selection_approval", {
    p_org_id: context.orgId, p_project_id: input.projectId, p_group_id: input.groupId, p_channel: input.channel,
    p_expected_terms_hash: input.termsHash, p_actor_id: context.userId,
  })
  if (sent.error) throw rpcError(sent.error, "Failed to send the selections for approval")
  const approval = approvalRowSchema.parse(sent.data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "selection_approval", entityId: approval.id, after: { project_id: approval.project_id, group_id: approval.group_id, channel: approval.channel, terms_hash: approval.terms_hash, total_cents: approval.total_cents, expires_at: approval.expires_at } })

  if (input.channel === "esign") {
    try {
      return { approvalId: approval.id, envelopeId: await publishSigningDocument(context, db, approval), buyerEmail: "sent" }
    } catch (error) {
      // A request the buyer can never answer would block the group; withdraw it and say why.
      await db.rpc("void_selection_approval", { p_org_id: context.orgId, p_approval_id: approval.id, p_actor_id: context.userId, p_reason: "The signing document could not be sent" })
      throw error
    }
  }
  // The request stands either way; the coordinator is told whether the buyer's email went out.
  return { approvalId: approval.id, envelopeId: null, buyerEmail: await emailPortalRequest(context, db, approval, `selection-approval-request:${approval.id}`).catch(() => "failed" as const) }
}

/** Mails the buyer a portal request again; each attempt is its own send, so a failed one can be retried. */
export async function resendSelectionApprovalRequest(raw: ResendSelectionApprovalInput): Promise<{ approvalId: string; buyerEmail: BuyerEmailOutcome }> {
  const input = resendSelectionApprovalSchema.parse(raw)
  const context = await requireOrgContext()
  const db = createServiceSupabaseClient()
  const approval = await loadApproval(db, context.orgId, input.approvalId)
  await authorizeHome(context, approval.project_id, "selections.write")
  if (approval.channel !== "portal" || approval.status !== "sent") throw new Error("Only a portal request still waiting on the buyer can be mailed again")
  if (approval.expires_at && Date.parse(approval.expires_at) <= Date.now()) throw new Error("This request has passed its deadline")
  const buyerEmail = await emailPortalRequest(context, db, approval, `selection-approval-request:${approval.id}:${randomUUID()}`).catch(() => "failed" as const)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "selection_approval", entityId: approval.id, after: { resent: true, buyer_email: buyerEmail } })
  return { approvalId: approval.id, buyerEmail }
}

export async function voidSelectionApproval(raw: VoidSelectionApprovalInput): Promise<{ approvalId: string }> {
  const input = voidSelectionApprovalSchema.parse(raw)
  const context = await requireOrgContext()
  const db = createServiceSupabaseClient()
  const approval = await loadApproval(db, context.orgId, input.approvalId)
  await authorizeHome(context, approval.project_id, "selections.write")
  const { error } = await db.rpc("void_selection_approval", { p_org_id: context.orgId, p_approval_id: approval.id, p_actor_id: context.userId, p_reason: input.reason })
  if (error) throw rpcError(error, "Failed to void the request")
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "selection_approval", entityId: approval.id, before: { status: approval.status }, after: { status: "voided", void_reason: input.reason } })
  return { approvalId: approval.id }
}

/**
 * Files the buyer's signed paper copy on the home, as the coordinator who is
 * about to record it. Authorized on `selections.write` (the desk role that
 * records paper approvals does not hold `docs.upload`); the database accepts
 * only a fresh contracts-category upload by the recording user as evidence.
 */
export async function uploadSelectionSignedCopy(raw: SignedCopyUploadInput): Promise<{ fileId: string }> {
  const input = signedCopyUploadSchema.parse(raw)
  const context = await requireOrgContext()
  await authorizeHome(context, input.projectId, "selections.write")
  const { contentType, sizeBytes } = validateDocumentUpload({ fileName: input.file.name, contentType: input.file.type, sizeBytes: input.file.size })
  if (contentType !== "application/pdf" && !contentType.startsWith("image/")) throw new Error("Attach the signed copy as a PDF or a photo")
  const bytes = Buffer.from(await input.file.arrayBuffer())
  const fileName = input.file.name.trim().replace(/[^a-zA-Z0-9._-]/g, "_")
  const storagePath = buildOrgScopedPath(context.orgId, "projects", input.projectId, "selections", "signed-copies", `${randomUUID()}_${fileName}`)
  await uploadFilesObject({ supabase: createServiceSupabaseClient(), orgId: context.orgId, path: storagePath, bytes, contentType, upsert: false })
  const file = await createFileRecord({
    project_id: input.projectId, file_name: fileName, storage_path: storagePath, mime_type: contentType, size_bytes: sizeBytes,
    checksum: createHash("sha256").update(bytes).digest("hex"), visibility: "private", category: "contracts", folder_path: "/contracts", source: "upload",
  }, context.orgId, { authorizationPermission: "selections.write" })
  return { fileId: file.id }
}

/** The coordinator records the buyer's signed paper copy, filed on the home. */
export async function recordInPersonSelectionApproval(raw: InPersonSelectionApprovalInput): Promise<{ approvalId: string }> {
  const input = inPersonSelectionApprovalSchema.parse(raw)
  const context = await requireOrgContext()
  await authorizeHome(context, input.projectId, "selections.write")
  const db = createServiceSupabaseClient()
  await assertChoicesUnlessRequested(db, context.orgId, input.projectId, input.groupId, "in_person", input.termsHash)
  const { data, error } = await db.rpc("approve_selection_terms", {
    p_org_id: context.orgId, p_project_id: input.projectId, p_group_id: input.groupId, p_channel: "in_person",
    p_terms_hash: input.termsHash, p_contact_id: null, p_user_id: context.userId, p_signed_copy_file_id: input.signedCopyFileId,
  })
  if (error) throw rpcError(error, "Failed to record the approval")
  const approval = approvalRowSchema.parse(data)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "selection_approval", entityId: approval.id, after: { status: "approved", channel: "in_person", signed_copy_file_id: input.signedCopyFileId, terms_hash: approval.terms_hash } })
  return { approvalId: approval.id }
}

/** The buyer approves in the portal what the portal showed them. The token was checked by the caller. */
export async function approveSelectionsFromPortal(input: { orgId: string; projectId: string; contactId: string; groupId: string | null; termsHash: string }): Promise<{ approvalId: string }> {
  const parsed = portalSelectionApprovalSchema.parse({ groupId: input.groupId, termsHash: input.termsHash })
  const db = createServiceSupabaseClient()
  await assertChoicesUnlessRequested(db, input.orgId, input.projectId, parsed.groupId, "portal", parsed.termsHash)
  const { data, error } = await db.rpc("approve_selection_terms", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_group_id: parsed.groupId, p_channel: "portal",
    p_terms_hash: parsed.termsHash, p_contact_id: input.contactId, p_user_id: null, p_signed_copy_file_id: null,
  })
  if (error) throw rpcError(error, "Your approval could not be recorded")
  const approval = approvalRowSchema.parse(data)
  await recordAudit({ orgId: input.orgId, actorId: undefined, action: "update", entityType: "selection_approval", entityId: approval.id, after: { status: "approved", channel: "portal", contact_id: input.contactId, terms_hash: approval.terms_hash } })
  return { approvalId: approval.id }
}

export async function declineSelectionsFromPortal(input: { orgId: string; projectId: string; contactId: string; approvalId: string; reason?: string }): Promise<{ approvalId: string }> {
  const parsed = portalSelectionDeclineSchema.parse({ approvalId: input.approvalId, reason: input.reason })
  const db = createServiceSupabaseClient()
  const approval = await loadApproval(db, input.orgId, parsed.approvalId)
  if (approval.project_id !== input.projectId) throw new Error("Selection approval not found")
  const { error } = await db.rpc("decline_selection_approval", { p_org_id: input.orgId, p_approval_id: approval.id, p_contact_id: input.contactId, p_reason: parsed.reason ?? null })
  if (error) throw rpcError(error, "Your answer could not be recorded")
  await recordAudit({ orgId: input.orgId, actorId: undefined, action: "update", entityType: "selection_approval", entityId: approval.id, before: { status: approval.status }, after: { status: "declined", contact_id: input.contactId, decline_reason: parsed.reason ?? null } })
  return { approvalId: approval.id }
}

const envelopeOutcomeSchema = z.object({
  outcome: z.enum(["approved", "declined", "expired", "voided", "sent"]),
  idempotent: z.boolean().optional(),
  project_id: z.string().uuid(),
  group_id: z.string().uuid().nullable(),
})

/**
 * The buyer signed. The approval lands only for the terms the envelope
 * carried; a signature after the deadline, or on terms that changed, ends the
 * job (it would end the same way on every retry). A change voids the envelope
 * in the same transaction, so a signature can only meet changed terms in a
 * race the signing lock already settles.
 */
export async function executeSelectionApprovalFromEnvelope(input: {
  orgId: string
  approvalId: string
  envelopeId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}): Promise<{ outcome: SelectionApprovalStatus; idempotent: boolean }> {
  const db = createServiceSupabaseClient()
  const { data, error } = await db.rpc("approve_selection_approval_from_envelope", {
    p_org_id: input.orgId, p_approval_id: input.approvalId, p_envelope_id: input.envelopeId,
    p_evidence: { executed_file_id: input.executedFileId, signer_name: input.signerName ?? null, signer_email: input.signerEmail ?? null, signer_ip: input.signerIp ?? null },
  })
  if (error) throw new Error(`Failed to record the signed selections: ${error.message}`)
  const result = envelopeOutcomeSchema.parse(data)
  if (result.outcome === "approved" && !result.idempotent) {
    await recordAudit({ orgId: input.orgId, actorId: undefined, action: "update", entityType: "selection_approval", entityId: input.approvalId, after: { status: "approved", channel: "esign", envelope_id: input.envelopeId, executed_file_id: input.executedFileId, signer_email: input.signerEmail ?? null } })
  }
  return { outcome: result.outcome, idempotent: Boolean(result.idempotent) }
}

const outcomeJobSchema = z.object({
  approval_id: z.string().uuid(),
  status: z.enum(["approved", "declined", "expired"]),
})

const OUTCOME_COPY: Record<"approved" | "declined" | "expired", { type: NotificationType; title: string; verb: string }> = {
  approved: { type: "selection_approval_approved", title: "Selections approved", verb: "were approved by the buyer" },
  declined: { type: "selection_approval_declined", title: "Selections declined", verb: "were declined by the buyer" },
  expired: { type: "selection_approval_expired", title: "Selection approval expired", verb: "reached their deadline without an answer" },
}

/**
 * Who sent the request, and everyone who runs design studio sessions on the
 * home (within their division and project scope), hear how it ended.
 */
export async function notifySelectionApprovalOutcome(orgId: string, rawPayload: unknown): Promise<{ notified: number }> {
  const job = outcomeJobSchema.parse(rawPayload)
  const db = createServiceSupabaseClient()
  const approval = await loadApproval(db, orgId, job.approval_id)
  const [facts, holdersResult] = await Promise.all([
    homeFacts(db, orgId, approval.project_id, approval.group_id),
    db.rpc("project_permission_holders", { p_org_id: orgId, p_project_id: approval.project_id, p_permission: "design_studio.manage" }),
  ])
  if (holdersResult.error) throw new Error(`Failed to resolve who runs this home: ${holdersResult.error.message}`)
  const holders = z.array(z.string().uuid()).parse(holdersResult.data ?? [])
  const recipients = Array.from(new Set([...(approval.sent_by ? [approval.sent_by] : []), ...holders])).slice(0, NOTIFY_RECIPIENT_CAP)
  const copy = OUTCOME_COPY[job.status]
  const reason = job.status === "declined" ? approval.decline_reason : null
  const notifications = new NotificationService()
  const results = await Promise.allSettled(recipients.map((userId) => notifications.createAndQueue({
    orgId, userId, type: copy.type, title: copy.title,
    message: `${facts.homeName ?? "A home"}: ${facts.groupName} ${copy.verb}.${reason ? ` "${reason}"` : ""}`,
    projectId: approval.project_id, entityType: "selection_approval", entityId: approval.id,
    metadata: { href: `/projects/${approval.project_id}/selections` },
  })))
  return { notified: results.filter((result) => result.status === "fulfilled").length }
}

/** Requests whose deadline passed without an answer; each one's outcome job is queued by the database. */
export async function expireSelectionApprovals(): Promise<{ expired: number }> {
  const { data, error } = await createServiceSupabaseClient().rpc("expire_selection_approvals", { p_limit: 500 })
  if (error) throw new Error(`Failed to expire selection approvals: ${error.message}`)
  return { expired: Array.isArray(data) ? data.length : 0 }
}

