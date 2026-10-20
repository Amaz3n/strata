import { z } from "zod"
import { resolveSigningRequestToken } from "@/lib/esign/signing-tokens"
import { assertElectronicSignatureConsent } from "@/lib/esign/consent"
import { createEstimateEvidenceManifest } from "@/lib/esign/estimate-evidence"
import { validateSignaturePng } from "@/lib/esign/field-values"
import { requireSigningAccess } from "@/lib/esign/access-code"
import { SignatureEmail } from "@/lib/emails/signature-email"
import { issueSigningLinkForRequest, deliverSigningInvitation } from "@/lib/services/signature-delivery"
import { authorizeEstimateDocumentWrite } from "./estimate-document-authorization"
import { assertEstimateIssuable } from "./estimate-issuance"
import { estimateProposal, proposalSectionKeySchema, proposalDefaultsFromSettings, proposalDocumentLabel, type ProposalDefaults, type ProposalDocument } from "@/lib/precon/proposal-documents"
import { normalizeEstimateCommercial, estimateBuilderFeeCents, estimateLineNotes, estimateDocumentTerms, estimateCommercialIssues, estimatePriceRange, type EstimateCommercial } from "@/lib/financials/estimate-commercial"
import { createHmac, createHash, randomBytes, randomUUID } from "crypto"

import {
  estimateLineAmountCents,
  resolveAcceptedOptions,
  validateOptionGroups,
  type AcceptedOptions,
} from "@/lib/financials/estimate-totals"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { EstimateEmail } from "@/lib/emails/estimate-email"
import { ENVELOPE_EVENT_TYPES, buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { renderEstimatePdf } from "@/lib/pdfs/estimate"
import type { QuoteSigner } from "@/lib/pdfs/quote-document"
import { generateExecutedPdf, type ESignAuditTrailItem } from "@/lib/pdfs/esign"
import { recordESignEvent } from "@/lib/services/esign-events"
import { buildOrgScopedPath, createFilesDownloadUrl, downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { PRICING_DISPLAY_MODES, type PricingDisplayMode } from "@/lib/validation/estimates"
import { formatLocalDate } from "@/lib/utils"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"
import { isDeductionGeometry } from "@/lib/drawings/measure"
import { loadWorkspaceSurface } from "@/lib/services/workspace-surface"
import { profileTerminology } from "@/lib/terminology"

export type EstimateDecision = "approved" | "rejected" | "changes_requested"

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

type EstimateSignatureInput = {
  signer_name: string
  signer_email?: string | null
  signature_text?: string | null
  signature_image?: string | null
  consent_accepted: boolean
}

function requireEstimateSecret() {
  const secret = process.env.ESTIMATE_SECRET ?? process.env.PROPOSAL_SECRET
  if (!secret) {
    throw new Error("Missing ESTIMATE_SECRET (or PROPOSAL_SECRET) environment variable")
  }
  return secret
}

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) {
    throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  }
  return secret
}

function hashToken(token: string) {
  return createHmac("sha256", requireEstimateSecret()).update(token).digest("hex")
}

function hashSigningToken(token: string) {
  return createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
}

function mintToken() {
  const token = randomBytes(32).toString("hex")
  return { token, tokenHash: hashToken(token) }
}

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? ""
}

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function buildOrgAddress(address: Record<string, any> | null | undefined): string | null {
  if (!address) return null
  const parts = [
    address.line1 ?? address.street ?? address.address1,
    address.line2 ?? address.address2,
    [address.city, address.state, address.postal_code ?? address.zip].filter(Boolean).join(", "),
    address.country,
  ].filter((p) => typeof p === "string" && p.trim().length > 0)
  return parts.length ? parts.join("\n") : null
}

export type OrgBranding = {
  name: string | null
  logoUrl: string | null
  address: string | null
  slug: string | null
  proposalTermsTemplate: string | null
  estimateTermsTemplate: string | null
  /** Hex accent color applied to client-facing estimate documents. */
  estimateAccentColor: string | null
  /** Display font family for estimate documents (CSS font-family keyword). */
  estimateFont: string | null
  /** Default cover note seeded into new estimates. */
  estimateIntroTemplate: string | null
  /** What every new deal proposal starts from. */
  proposalDefaults: ProposalDefaults
}

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/

/** Normalizes a stored accent color to a `#rrggbb` string, or null when unset/invalid. */
export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!HEX_COLOR.test(trimmed)) return null
  return trimmed.startsWith("#") ? trimmed.toLowerCase() : `#${trimmed.toLowerCase()}`
}

/**
 * Resolves an estimate's recipient name/email. Prefers the linked directory contact;
 * falls back to the prospect's primary prospect_contact for pre-won prospect estimates
 * (which intentionally have no directory contact yet).
 *
 * Requires the query to select:
 *   recipient:contacts(full_name, email), prospect:prospects(name, prospect_contacts(full_name, email, is_primary))
 */
export function resolveEstimateRecipient(estimate: any): { name: string | null; email: string | null } {
  const directory = (estimate?.recipient ?? null) as { full_name?: string | null; email?: string | null } | null
  if (directory?.email) {
    return { name: directory.full_name ?? null, email: directory.email }
  }
  // Ad-hoc recipient chosen at create time (stored on the estimate), e.g. a custom name/email.
  const override = ((estimate?.metadata as Record<string, any> | null)?.recipient ?? null) as {
    name?: string | null
    email?: string | null
  } | null
  if (override?.email) {
    return { name: override.name ?? null, email: override.email }
  }
  const prospectContacts = (estimate?.prospect?.prospect_contacts ?? []) as Array<{
    full_name?: string | null
    email?: string | null
    is_primary?: boolean | null
  }>
  const primary = prospectContacts.find((c) => c.is_primary) ?? prospectContacts[0]
  return {
    name: directory?.full_name ?? override?.name ?? primary?.full_name ?? null,
    email: directory?.email ?? override?.email ?? primary?.email ?? null,
  }
}

/** Loads org branding + document templates. Uses a service client so it works in public portals too. */
export async function getOrgBranding(orgId: string, client?: ServiceClient): Promise<OrgBranding> {
  const supabase = client ?? createServiceSupabaseClient()
  const [{ data: org }, { data: settingsRow }] = await Promise.all([
    supabase.from("orgs").select("name, logo_url, address, slug").eq("id", orgId).maybeSingle(),
    supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle(),
  ])

  const settings = (settingsRow?.settings as Record<string, any> | null) ?? {}
  return {
    name: org?.name ?? null,
    logoUrl: org?.logo_url ?? null,
    address: buildOrgAddress(org?.address as Record<string, any> | null),
    slug: org?.slug ?? null,
    proposalTermsTemplate:
      (typeof settings.proposal_terms_template === "string" && settings.proposal_terms_template) || null,
    estimateTermsTemplate:
      (typeof settings.estimate_terms_template === "string" && settings.estimate_terms_template) || null,
    estimateAccentColor: normalizeAccentColor(settings.estimate_accent_color),
    estimateFont: (typeof settings.estimate_font === "string" && settings.estimate_font) || null,
    estimateIntroTemplate:
      (typeof settings.estimate_intro_template === "string" && settings.estimate_intro_template) || null,
    proposalDefaults: proposalDefaultsFromSettings(settings),
  }
}

async function resolveActorName(supabase: ServiceClient, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const { data } = await supabase.from("app_users").select("full_name, email").eq("id", userId).maybeSingle()
  return data?.full_name ?? data?.email ?? null
}

async function addComment(
  supabase: ServiceClient,
  input: {
    orgId: string
    estimateId: string
    versionGroupId: string | null
    authorType: "builder" | "client"
    authorUserId?: string | null
    authorName?: string | null
    authorEmail?: string | null
    kind: string
    body?: string | null
    metadata?: Record<string, any>
  },
) {
  const { error } = await supabase.from("estimate_comments").insert({
    org_id: input.orgId,
    estimate_id: input.estimateId,
    version_group_id: input.versionGroupId,
    author_type: input.authorType,
    author_user_id: input.authorUserId ?? null,
    author_name: input.authorName ?? null,
    author_email: input.authorEmail ?? null,
    kind: input.kind,
    body: input.body ?? null,
    metadata: input.metadata ?? {},
  })
  if (error) {
    throw new Error(`Failed to record estimate comment: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Builder-side actions (authenticated, RLS-scoped client)
// ---------------------------------------------------------------------------

/**
 * Mints a fresh portal token for an estimate and returns the shareable review URL.
 * Existing links remain valid unless the caller explicitly requests replacement.
 */
export async function getEstimateShareLink({ estimateId, orgId, revokeExisting = false }: { estimateId: string; orgId?: string; revokeExisting?: boolean }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data: estimate, error } = await supabase.from("estimates")
    .select("id, org_id, status, sent_at, updated_at, is_current_version, client_signed_at, executed_at, total_cents, metadata, prospect_id, items:estimate_items(id,metadata)")
    .eq("org_id", resolvedOrgId).eq("id", estimateId).single()
  if (error || !estimate) throw new Error("Estimate not found")
  const { service } = await assertEstimateIssuable(estimate, resolvedOrgId)
  const { token, tokenHash } = mintToken()
  const issued = await service.rpc("issue_estimate_review_link", {
    p_org_id: resolvedOrgId, p_estimate_id: estimateId, p_token_hash: tokenHash,
    p_expected_updated_at: estimate.updated_at, p_revoke_existing: revokeExisting,
  })
  if (issued.error) throw new Error(issued.error.message)
  return { token, url: `${appUrl()}/e/${token}` }
}

const NO_ESTIMATE = "00000000-0000-0000-0000-000000000000"

type ReviewLink = {
  estimateId: string
  /** Whose link this is when the document has several signers; null is the primary client's. */
  signer: { name: string; email: string } | null
}

/**
 * Existing legacy links and separately issued review capabilities remain valid
 * until explicitly revoked. A deal's link always opens the newest version the
 * client was sent, whichever document it was first sent with.
 */
async function reviewLinkForToken(supabase: ServiceClient, tokenHash: string): Promise<ReviewLink> {
  const legacy = await supabase.from("estimates").select("id").eq("token_hash", tokenHash).maybeSingle()
  if (legacy.error) throw new Error("Unable to verify this review link.")
  if (legacy.data) return { estimateId: await latestSentVersion(supabase, legacy.data.id), signer: null }
  let link = await supabase.from("estimate_review_links").select("estimate_id, signer_name, signer_email").eq("token_hash", tokenHash).maybeSingle()
  // Signer columns arrive with a pending migration; links issued before it are the primary client's.
  if (link.error?.code === "42703")
    link = await supabase.from("estimate_review_links").select("estimate_id").eq("token_hash", tokenHash).maybeSingle()
  if (link.error) throw new Error("Unable to verify this review link.")
  if (!link.data) return { estimateId: NO_ESTIMATE, signer: null }
  const signer = z.object({ signer_name: z.string(), signer_email: z.string() }).safeParse(link.data)
  return {
    estimateId: await latestSentVersion(supabase, link.data.estimate_id),
    signer: signer.success ? { name: signer.data.signer_name, email: signer.data.signer_email } : null,
  }
}

async function estimateIdForReviewToken(supabase: ServiceClient, tokenHash: string): Promise<string> {
  return (await reviewLinkForToken(supabase, tokenHash)).estimateId
}

/** A deal's budget and agreement are one conversation with the client: the link follows the newest version sent. */
async function latestSentVersion(supabase: ServiceClient, estimateId: string): Promise<string> {
  const { data, error } = await supabase.from("estimates").select("org_id, prospect_id, metadata").eq("id", estimateId).maybeSingle()
  if (error) throw new Error("Unable to verify this review link.")
  if (!data?.prospect_id || normalizeEstimateCommercial(data.metadata).purpose === "preconstruction_agreement") return estimateId
  const latest = await supabase.from("estimates").select("id")
    .eq("org_id", data.org_id).eq("prospect_id", data.prospect_id)
    .not("sent_at", "is", null)
    .in("metadata->precon->>purpose", ["budget", "construction_agreement"])
    .order("sent_at", { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw new Error("Unable to verify this review link.")
  return latest.data?.id ?? estimateId
}

/** Who has signed so far, by lowercased email. Each signer's signature is kept under signature_data.signers. */
function signedEmails(signatureData: unknown): Set<string> {
  const parsed = z.object({ signers: z.record(z.string(), z.object({ signed_at: z.string() }).passthrough()) }).safeParse(signatureData)
  return new Set(parsed.success ? Object.keys(parsed.data.signers) : [])
}

/**
 * Sends the estimate to its recipient contact: rotates the token, marks the
 * estimate "sent", emails a review link, and records the activity.
 */
export async function sendEstimate({
  estimateId,
  message,
  orgId,
}: {
  estimateId: string
  message?: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      "id, org_id, prospect_id, title, status, sent_at, updated_at, is_current_version, client_signed_at, executed_at, total_cents, valid_until, version_group_id, recipient_contact_id, metadata, signature_data, items:estimate_items(id,metadata), project:projects(name), prospect:prospects(name, prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)",
    )
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !estimate) {
    throw new Error(`Estimate not found: ${error?.message ?? "missing"}`)
  }

  const { service } = await assertEstimateIssuable(estimate, resolvedOrgId)
  const recipient = resolveEstimateRecipient(estimate)
  const recipientEmail = recipient.email?.trim()
  if (!recipientEmail) {
    throw new Error("Add a client contact with an email address before sending this estimate.")
  }
  const proposal = estimateProposal(estimate.metadata)
  const isBudget = normalizeEstimateCommercial(estimate.metadata).purpose === "budget"
  // Each signer gets a link of their own; anyone who already signed is not asked again.
  const signed = signedEmails(estimate.signature_data)
  const recipients = proposal?.signers.length
    ? proposal.signers.filter((signer) => !signed.has(signer.email.toLowerCase()))
    : [{ name: recipient.name ?? "", email: recipientEmail }]
  if (!recipients.length) throw new Error("Everyone has signed this document.")
  const primaryEmail = (proposal?.signers[0]?.email ?? recipientEmail).toLowerCase()

  const links = recipients.map((person) => ({ person, ...mintToken() }))
  const { error: issueError } = await service.rpc("issue_estimate_review_link", {
    p_org_id: resolvedOrgId, p_estimate_id: estimateId, p_token_hash: links[0].tokenHash,
    p_expected_updated_at: estimate.updated_at, p_revoke_existing: false,
  })
  if (issueError) throw new Error(`Failed to issue document: ${issueError.message}`)
  // A link with no signer is the primary client's; every other signer's link says whose it is.
  const signerLinks = links.filter(({ person }) => person.email.toLowerCase() !== primaryEmail)
  if (signerLinks.length) {
    const firstIsSigner = links[0].person.email.toLowerCase() !== primaryEmail
    const [named, inserted] = await Promise.all([
      firstIsSigner
        ? service.from("estimate_review_links").update({ signer_name: links[0].person.name, signer_email: links[0].person.email })
            .eq("org_id", resolvedOrgId).eq("token_hash", links[0].tokenHash)
        : Promise.resolve({ error: null }),
      service.from("estimate_review_links").insert(
        signerLinks.filter((link) => link !== links[0]).map((link) => ({
          org_id: resolvedOrgId, estimate_id: estimateId, token_hash: link.tokenHash,
          signer_name: link.person.name, signer_email: link.person.email,
        })),
      ),
    ])
    const linkError = named.error ?? inserted.error
    if (linkError) throw new Error(`The document was issued, but a signer's link was not: ${linkError.message}`)
  }

  const [branding, surface] = await Promise.all([getOrgBranding(resolvedOrgId, supabase), loadWorkspaceSurface(resolvedOrgId)])
  const projectLabel = profileTerminology(surface.profile).project
  const range = estimatePriceRange(estimate.metadata)
  const documentName = proposal ? proposalDocumentLabel(normalizeEstimateCommercial(estimate.metadata)) : null
  const delivered = await Promise.all(
    links.map(async ({ person, token }) => {
      const html = await renderEmailTemplate(
        EstimateEmail({
          documentKind: isBudget ? "proposal" : "agreement",
          documentName,
          actionLabel: proposal ? (isBudget ? "Review the proposal" : "Review and sign") : null,
          persistentLink: Boolean(proposal),
          estimateTitle: estimate.title,
          reviewLink: `${appUrl()}/e/${token}`,
          orgName: branding.name,
          orgLogoUrl: branding.logoUrl,
          recipientName: person.name || null,
          projectName: (estimate as any).project?.name ?? (estimate as any).prospect?.name ?? null,
          projectLabel,
          totalLabel: range ? `${formatMoney(range.lowCents)} – ${formatMoney(range.highCents)}` : formatMoney(estimate.total_cents),
          validUntil: estimate.valid_until
            ? formatLocalDate(estimate.valid_until, "MMMM d, yyyy")
            : null,
          message: message ?? null,
        }),
      )
      return sendEmail({
        to: [person.email],
        subject: documentName
          ? `Your ${documentName.toLowerCase()} from ${branding.name ?? "your builder"}: ${estimate.title}`
          : `${branding.name ?? "Your builder"} sent you ${isBudget ? "a proposal" : "an agreement"}: ${estimate.title}`,
        html,
        from: getOrgSenderEmail(branding.slug, branding.name),
      })
    }),
  )
  const emailSent = delivered.every(Boolean)
  const reviewUrl = `${appUrl()}/e/${links[0].token}`
  const token = links[0].token

  await addComment(supabase, {
    orgId: resolvedOrgId,
    estimateId,
    versionGroupId: (estimate as any).version_group_id ?? null,
    authorType: "builder",
    authorUserId: userId,
    authorName: await resolveActorName(supabase, userId),
    kind: "sent",
    body: message ?? null,
    metadata: { recipient_email: links.map(({ person }) => person.email).join(", "), email_sent: emailSent },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_sent",
    entityType: "estimate",
    entityId: estimateId,
    payload: { title: estimate.title, recipient_email: links.map(({ person }) => person.email).join(", "), email_sent: emailSent },
  })

  // A budget out for review puts the deal with the client just as an agreement does.
  if ((estimate as any).prospect_id && normalizeEstimateCommercial(estimate.metadata).purpose !== "preconstruction_agreement") {
    await supabase
      .from("prospects")
      .update({ status: "estimate_sent", updated_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("id", (estimate as any).prospect_id)
      .in("status", ["pricing", "qualified", "contacted", "new"])
  }

  return { url: reviewUrl, token, emailSent }
}

/** Builder posts a reply into the estimate thread. */
export async function addBuilderEstimateComment({
  estimateId,
  body,
  orgId,
}: {
  estimateId: string
  body: string
  orgId?: string
}) {
  const trimmed = body.trim()
  if (!trimmed) throw new Error("Comment cannot be empty")

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, version_group_id")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !estimate) {
    throw new Error("Estimate not found")
  }

  await addComment(supabase, {
    orgId: resolvedOrgId,
    estimateId,
    versionGroupId: estimate.version_group_id ?? null,
    authorType: "builder",
    authorUserId: userId,
    authorName: await resolveActorName(supabase, userId),
    kind: "comment",
    body: trimmed,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_comment_added",
    entityType: "estimate",
    entityId: estimateId,
    payload: { author_type: "builder" },
  })
}

export type EstimateCommentDto = {
  id: string
  author_type: string
  author_name: string | null
  author_email: string | null
  kind: string
  body: string | null
  created_at: string
  /** The document section a client asked about; null for a general comment. */
  section: string | null
  /** The comment a builder's answer replies to. */
  reply_to: string | null
}

const COMMENT_COLUMNS = "id, author_type, author_name, author_email, kind, body, created_at, metadata"

function mapComments(rows: any[] | null): EstimateCommentDto[] {
  return (rows ?? []).map((row) => ({
    id: row.id,
    author_type: row.author_type,
    author_name: row.author_name ?? null,
    author_email: row.author_email ?? null,
    kind: row.kind,
    body: row.body ?? null,
    created_at: row.created_at,
    section: typeof row.metadata?.section === "string" ? row.metadata.section : null,
    reply_to: typeof row.metadata?.reply_to === "string" ? row.metadata.reply_to : null,
  }))
}

export async function listEstimateComments(estimateId: string, orgId?: string): Promise<EstimateCommentDto[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("estimate_comments")
    .select(COMMENT_COLUMNS)
    .eq("org_id", resolvedOrgId)
    .eq("estimate_id", estimateId)
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to list estimate comments", error.message)
    return []
  }
  return mapComments(data)
}

// ---------------------------------------------------------------------------
// Public portal actions (token-based, service client)
// ---------------------------------------------------------------------------

export type EstimatePortalData = {
  precon?: EstimateCommercial
  id: string
  org_id: string
  title: string
  status: string
  version: number
  total_cents: number | null
  subtotal_cents: number | null
  tax_cents: number | null
  issued_at: string | null
  valid_until: string | null
  summary: string | null
  terms: string | null
  recipient_name: string | null
  recipient_email: string | null
  project_name: string | null
  org_name: string | null
  org_logo_url: string | null
  org_address: string | null
  responded_at: string | null
  decision_note: string | null
  client_signed_at: string | null
  builder_signed_at: string | null
  executed_at: string | null
  executed_file_id: string | null
  signature_document_id: string | null
  signature_data: Record<string, any> | null
  is_current_version: boolean
  /** Cover note shown above the line items. */
  intro: string | null
  /** Percent tax rate applied to the base subtotal and accepted add-ons. */
  tax_rate: number
  /** Percent contingency carried on the base subtotal (already in total_cents). */
  contingency_percent: number
  /** Scope qualifications: what the price includes / excludes. */
  inclusions: string | null
  exclusions: string | null
  /** How much pricing breakdown the client sees. */
  pricing_display: PricingDisplayMode
  /** Hex accent color for the document chrome. */
  accent_color: string | null
  /** CSS font-family for the document body. */
  font_family: string | null
  /** Resolved, signed gallery photo URLs. */
  photos: EstimatePhotoView[]
  /** Recorded once the client signs: which add-ons they accepted + the final total. */
  accepted_options: AcceptedOptions | null
  /** A budget is presented as a range until the price is firm. */
  price_range: { lowCents: number; highCents: number } | null
  /** What the builder needs the client to decide before signing. */
  questions: EstimateQuestion[]
  items: EstimatePortalLine[]
  comments: EstimateCommentDto[]
  /** A deal proposal's sections; null for documents that predate proposals. */
  proposal: ProposalDocument | null
  /** Agreement signatures so far, by lowercased signer email, and the builder's countersignature. */
  signatures: { signed: Record<string, string>; builder: { name: string; signedAt: string | null } }
  /** Whose link this is; null is the primary client's. */
  viewer: { name: string; email: string } | null
  /** Every version the client was sent, newest first, for reading earlier ones. */
  versions: Array<{ id: string; label: string; version: number; sent_at: string }>
}

export type EstimateQuestion = { id: string; question: string; answer: string | null }

export type EstimatePhotoView = {
  id: string
  url: string
  caption: string | null
}

export type { AcceptedOptions } from "@/lib/financials/estimate-totals"

export type EstimatePortalLine = {
  id: string
  item_type: string
  description: string
  quantity: number | null
  unit: string | null
  unit_cost_cents: number | null
  markup_pct: number | null
  notes: string | null
  /** Client-selectable upgrade/add-on, excluded from the base total. */
  is_optional: boolean
  /** Allowance line: included in the total as a placeholder budget. */
  is_allowance: boolean
  /** Mutually-exclusive alternates group label (optional add-ons only). */
  option_group: string | null
  /**
   * Set when this quantity was measured off the plans AND the builder made the
   * condition client-visible. Drives the portal's "show me on the plans" link.
   */
  takeoff_condition_id: string | null
  /** Computed extended amount (qty × unit + markup). */
  amount_cents: number | null
}

const lineAmountCents = estimateLineAmountCents

function normalizePricingDisplay(value: unknown): PricingDisplayMode {
  return typeof value === "string" && (PRICING_DISPLAY_MODES as readonly string[]).includes(value)
    ? (value as PricingDisplayMode)
    : "itemized"
}

/** Resolves persisted photo storage paths to short-lived signed URLs for portal display. */
async function resolveEstimatePhotos(
  supabase: ServiceClient,
  orgId: string,
  metadata: Record<string, any> | null,
): Promise<EstimatePhotoView[]> {
  const photos = Array.isArray(metadata?.photos) ? (metadata!.photos as any[]) : []
  if (photos.length === 0) return []
  const resolved = await Promise.all(
    photos.map(async (photo, idx): Promise<EstimatePhotoView | null> => {
      const path = typeof photo?.path === "string" ? photo.path : null
      if (!path) return null
      try {
        const { downloadUrl } = await createFilesDownloadUrl({ supabase, orgId, path, expiresIn: 3600 })
        return { id: `${idx}`, url: downloadUrl, caption: typeof photo.caption === "string" ? photo.caption : null }
      } catch (error) {
        console.error(`[resolveEstimatePhotos] Failed to sign photo ${path}:`, error)
        return null
      }
    }),
  )
  return resolved.filter((p): p is EstimatePhotoView => p !== null)
}

type PortalExtras = {
  questions?: EstimateQuestion[]
  photos?: EstimatePhotoView[]
  accentColor?: string | null
  fontFamily?: string | null
  orgAddress?: string | null
  viewer?: { name: string; email: string } | null
  versions?: EstimatePortalData["versions"]
}

/** The versions a deal's client was sent; beyond this they are reading history, not deciding. */
const PORTAL_VERSIONS_SHOWN = 20

/** A deal's comments follow the client across versions; other estimates keep their own thread. */
async function loadPortalComments(supabase: ServiceClient, estimate: { id: string; org_id: string; prospect_id: string | null }) {
  const query = estimate.prospect_id
    ? supabase.from("estimate_comments").select(`${COMMENT_COLUMNS}, estimate:estimates!inner(prospect_id)`)
        .eq("org_id", estimate.org_id).eq("estimate.prospect_id", estimate.prospect_id).eq("kind", "comment")
    : supabase.from("estimate_comments").select(COMMENT_COLUMNS).eq("org_id", estimate.org_id).eq("estimate_id", estimate.id)
  const { data, error } = await query.order("created_at", { ascending: true }).limit(500)
  if (error) throw new Error(`Unable to load comments: ${error.message}`)
  return mapComments(data)
}

async function loadPortalVersions(supabase: ServiceClient, estimate: { org_id: string; prospect_id: string | null }) {
  if (!estimate.prospect_id) return []
  const { data, error } = await supabase.from("estimates").select("id, version, sent_at, metadata")
    .eq("org_id", estimate.org_id).eq("prospect_id", estimate.prospect_id)
    .not("sent_at", "is", null)
    .in("metadata->precon->>purpose", ["budget", "construction_agreement"])
    .order("sent_at", { ascending: false }).limit(PORTAL_VERSIONS_SHOWN)
  if (error) throw new Error(`Unable to load earlier versions: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    label: proposalDocumentLabel(normalizeEstimateCommercial(row.metadata)),
    version: row.version as number,
    sent_at: row.sent_at as string,
  }))
}

function mapEstimatePortalData(
  estimate: any,
  comments: EstimateCommentDto[],
  extras: PortalExtras = {},
): EstimatePortalData {
  const metadata = (estimate.metadata as Record<string, any> | null) ?? {}
  const items: EstimatePortalLine[] = [...((estimate as any).items ?? [])]
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((it: any) => ({
      id: it.id,
      item_type: it.item_type ?? "line",
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unit_cost_cents: it.unit_cost_cents,
      markup_pct: it.markup_pct,
      notes: estimateLineNotes(it.metadata),
      is_optional: it.metadata?.is_optional === true,
      is_allowance: it.metadata?.is_allowance === true,
      option_group: typeof it.metadata?.option_group === "string" ? it.metadata.option_group : null,
      // Only a live link is exposed: a detached line's condition no longer
      // exists, so offering "show me" would open onto nothing.
      takeoff_condition_id:
        it.metadata?.takeoff?.detached === true
          ? null
          : (it.metadata?.takeoff?.condition_id as string | undefined) ?? null,
      amount_cents: lineAmountCents(it),
    }))

  const builderFee = estimateBuilderFeeCents(metadata)
  if (builderFee) items.push({ id: `${estimate.id}-builder-fee`, item_type: "line", description: "Fixed builder fee", quantity: 1, unit: null, unit_cost_cents: builderFee, markup_pct: 0, amount_cents: builderFee, notes: null, is_optional: false, is_allowance: false, option_group: null, takeoff_condition_id: null })

  const acceptedOptions = (metadata.accepted_options as AcceptedOptions | null) ?? null
  const signatureData = (estimate.signature_data as Record<string, any> | null) ?? {}
  const signed: Record<string, string> = {}
  for (const [email, signature] of Object.entries((signatureData.signers ?? {}) as Record<string, { signed_at?: unknown }>))
    if (typeof signature?.signed_at === "string") signed[email] = signature.signed_at

  return {
    proposal: estimateProposal(metadata),
    signatures: {
      signed,
      builder: {
        name: typeof signatureData.builder?.signer_name === "string" ? signatureData.builder.signer_name : "",
        signedAt: (estimate as any).builder_signed_at ?? null,
      },
    },
    viewer: extras.viewer ?? null,
    versions: extras.versions ?? [],
    precon: normalizeEstimateCommercial(metadata),
    intro: typeof metadata.intro === "string" ? metadata.intro : null,
    tax_rate: Number(metadata.tax_rate ?? 0) || 0,
    contingency_percent: Number(metadata.contingency_percent ?? 0) || 0,
    inclusions: typeof metadata.inclusions === "string" ? metadata.inclusions : null,
    exclusions: typeof metadata.exclusions === "string" ? metadata.exclusions : null,
    pricing_display: normalizePricingDisplay(metadata.display?.pricing),
    accent_color: extras.accentColor ?? null,
    font_family: extras.fontFamily ?? null,
    org_address: extras.orgAddress ?? null,
    photos: extras.photos ?? [],
    accepted_options: acceptedOptions,
    price_range: estimatePriceRange(metadata),
    questions: extras.questions ?? [],
    id: estimate.id,
    org_id: estimate.org_id,
    title: estimate.title,
    status: estimate.status,
    version: estimate.version,
    total_cents: estimate.total_cents,
    subtotal_cents: estimate.subtotal_cents,
    tax_cents: estimate.tax_cents,
    issued_at: (estimate as any).created_at ?? null,
    valid_until: estimate.valid_until,
    summary: typeof metadata.summary === "string" ? metadata.summary : null,
    terms: estimateDocumentTerms(metadata),
    recipient_name: resolveEstimateRecipient(estimate).name,
    recipient_email: resolveEstimateRecipient(estimate).email,
    project_name: (estimate as any).project?.name ?? (estimate as any).prospect?.name ?? null,
    org_name: (estimate as any).org?.name ?? null,
    org_logo_url: (estimate as any).org?.logo_url ?? null,
    responded_at: estimate.responded_at,
    decision_note: estimate.decision_note,
    client_signed_at: (estimate as any).client_signed_at ?? null,
    builder_signed_at: (estimate as any).builder_signed_at ?? null,
    executed_at: (estimate as any).executed_at ?? null,
    executed_file_id: (estimate as any).executed_file_id ?? null,
    signature_document_id: (estimate as any).signature_document_id ?? null,
    signature_data: ((estimate as any).signature_data as Record<string, any> | null) ?? null,
    is_current_version: estimate.is_current_version ?? true,
    items,
    comments,
  }
}

/** The deal's client questions, as the client sees them. Waived questions are the builder's to drop. */
async function loadEstimateQuestions(
  supabase: ServiceClient,
  orgId: string,
  prospectId: string | null,
): Promise<EstimateQuestion[]> {
  if (!prospectId) return []
  const { data, error } = await supabase
    .from("precon_decisions")
    .select("id, title, status, resolution")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .eq("kind", "client_decision")
    .neq("status", "waived")
    .order("created_at", { ascending: true })
    .limit(50)
  if (error) throw new Error(`Unable to load questions: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    question: row.title as string,
    answer: row.status === "resolved" ? ((row.resolution as string) || null) : null,
  }))
}

/**
 * The client answers a builder's question from the review link. The answer
 * resolves the question for the builder, so a firm price can go out for signature.
 */
export async function answerEstimateQuestion(input: { token: string; questionId: string; answer: string }) {
  const answer = z.string().trim().min(3, "Write a short answer.").max(2000).parse(input.answer)
  const questionId = z.string().uuid().parse(input.questionId)
  const supabase = createServiceSupabaseClient()
  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, org_id, prospect_id, status, is_current_version, version_group_id, metadata, prospect:prospects(prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)")
    .eq("id", await estimateIdForReviewToken(supabase, hashToken(input.token)))
    .maybeSingle()
  if (error) throw new Error("Unable to verify this review link.")
  if (!estimate?.prospect_id || estimate.status !== "sent" || estimate.is_current_version === false)
    throw new Error("This document is no longer open for answers.")
  const { data: question, error: questionError } = await supabase
    .from("precon_decisions")
    .select("id, title, version")
    .eq("org_id", estimate.org_id)
    .eq("prospect_id", estimate.prospect_id)
    .eq("id", questionId)
    .eq("kind", "client_decision")
    .eq("status", "open")
    .maybeSingle()
  if (questionError) throw new Error("Unable to load this question.")
  if (!question) throw new Error("This question was already answered.")
  const { data: updated, error: updateError } = await supabase
    .from("precon_decisions")
    .update({ status: "resolved", resolution: answer, version: question.version + 1 })
    .eq("org_id", estimate.org_id)
    .eq("id", question.id)
    .eq("version", question.version)
    .select("id")
    .maybeSingle()
  if (updateError) throw new Error("Unable to save your answer.")
  if (!updated) throw new Error("This question changed. Reload the page and try again.")
  const recipient = resolveEstimateRecipient(estimate)
  await addComment(supabase, {
    orgId: estimate.org_id,
    estimateId: estimate.id,
    versionGroupId: (estimate as any).version_group_id ?? null,
    authorType: "client",
    authorName: recipient.name,
    authorEmail: recipient.email,
    kind: "comment",
    body: `${question.title}\n${answer}`,
    metadata: { question_id: question.id },
  })
  await recordEvent({
    orgId: estimate.org_id,
    eventType: "precon_question_answered",
    entityType: "prospect",
    entityId: estimate.prospect_id,
    payload: { question_id: question.id, title: question.title, estimate_id: estimate.id },
  })
  return { id: question.id }
}

/**
 * Loads an estimate for the public portal by raw token, stamping first-view time.
 * A deal's link opens its newest version; `versionId` reads an earlier one the
 * same client was sent.
 */
export async function loadEstimateByToken(token: string, versionId?: string | null): Promise<EstimatePortalData | null> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)
  const link = await reviewLinkForToken(supabase, tokenHash)
  let estimateId = link.estimateId
  if (versionId && versionId !== estimateId && z.string().uuid().safeParse(versionId).success) {
    const [latest, earlier] = await Promise.all([
      supabase.from("estimates").select("org_id, prospect_id").eq("id", estimateId).maybeSingle(),
      supabase.from("estimates").select("id, org_id, prospect_id, sent_at").eq("id", versionId).maybeSingle(),
    ])
    if (latest.error || earlier.error) throw new Error("Unable to load this version.")
    const sameDeal = latest.data?.prospect_id && earlier.data?.sent_at &&
      earlier.data.org_id === latest.data.org_id && earlier.data.prospect_id === latest.data.prospect_id
    if (sameDeal) estimateId = versionId
  }

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `id, org_id, prospect_id, title, status, version, total_cents, subtotal_cents, tax_cents, valid_until, created_at, metadata,
       responded_at, decision_note, is_current_version, client_signed_at, builder_signed_at, executed_at,
       executed_file_id, signature_document_id, signature_data,
       items:estimate_items(id, item_type, description, quantity, unit, unit_cost_cents, markup_pct, sort_order, metadata),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       org:orgs(name, logo_url),
       recipient:contacts(full_name, email)`,
    )
    .eq("id", estimateId)
    .maybeSingle()

  if (error) {
    throw new Error(`Database error: ${error.message}`)
  }
  if (!estimate) return null

  if (estimate.status === "sent" && estimateId === link.estimateId) {
    const { data: updated } = await supabase
      .from("estimates")
      .update({ viewed_at: new Date().toISOString() })
      .eq("id", estimate.id)
      .is("viewed_at", null)
      .select("id")
      .maybeSingle()

    if (updated) {
      await recordEvent({
        orgId: estimate.org_id,
        eventType: "estimate_viewed",
        entityType: "estimate",
        entityId: estimate.id,
        payload: { title: estimate.title },
      })
    }
  }

  const [comments, branding, photos, questions, versions] = await Promise.all([
    loadPortalComments(supabase, estimate),
    getOrgBranding(estimate.org_id, supabase),
    resolveEstimatePhotos(supabase, estimate.org_id, estimate.metadata as Record<string, any> | null),
    loadEstimateQuestions(supabase, estimate.org_id, estimate.prospect_id ?? null),
    loadPortalVersions(supabase, estimate),
  ])

  return mapEstimatePortalData(estimate, comments, {
    viewer: link.signer,
    versions,
    questions,
    photos,
    accentColor: branding.estimateAccentColor,
    fontFamily: branding.estimateFont,
    orgAddress: branding.address,
  })
}

export async function loadEstimateByIdForPortal(input: {
  supabase?: ServiceClient
  orgId: string
  estimateId: string
}): Promise<EstimatePortalData | null> {
  const supabase = input.supabase ?? createServiceSupabaseClient()
  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `id, org_id, prospect_id, title, status, version, total_cents, subtotal_cents, tax_cents, valid_until, created_at, metadata,
       responded_at, decision_note, is_current_version, client_signed_at, builder_signed_at, executed_at,
       executed_file_id, signature_document_id, signature_data,
       items:estimate_items(id, item_type, description, quantity, unit, unit_cost_cents, markup_pct, sort_order, metadata),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       org:orgs(name, logo_url),
       recipient:contacts(full_name, email)`,
    )
    .eq("org_id", input.orgId)
    .eq("id", input.estimateId)
    .maybeSingle()

  if (error) {
    throw new Error(`Database error: ${error.message}`)
  }
  if (!estimate) return null

  const [{ data: comments }, branding, photos, questions] = await Promise.all([
    supabase
      .from("estimate_comments")
      .select(COMMENT_COLUMNS)
      .eq("org_id", estimate.org_id)
      .eq("estimate_id", estimate.id)
      .order("created_at", { ascending: true }),
    getOrgBranding(estimate.org_id, supabase),
    resolveEstimatePhotos(supabase, estimate.org_id, estimate.metadata as Record<string, any> | null),
    loadEstimateQuestions(supabase, estimate.org_id, estimate.prospect_id ?? null),
  ])

  return mapEstimatePortalData(estimate, mapComments(comments), {
    questions,
    photos,
    accentColor: branding.estimateAccentColor,
    fontFamily: branding.estimateFont,
    orgAddress: branding.address,
  })
}

/** Renders the estimate PDF for the public portal, resolved by raw token. Returns null if not found. */
export async function renderEstimatePdfByToken(
  token: string,
): Promise<{ pdf: Buffer; fileName: string } | null> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `id, org_id, prospect_id, title, status, metadata, subtotal_cents, tax_cents, total_cents, valid_until, created_at,
       executed_file_id,
       client_signed_at, builder_signed_at, executed_at, signature_data,
       items:estimate_items(*),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       recipient:contacts(full_name, email)`,
    )
    .eq("id", await estimateIdForReviewToken(supabase, tokenHash))
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) return null
  return renderEstimateDocumentPdf(supabase, estimate)
}

/**
 * The client's document as a PDF: the executed file once there is one, else
 * rendered from the record. The builder's export and the client's download are
 * this one function, so they can never disagree.
 */
export async function renderEstimateDocumentPdf(
  supabase: ServiceClient,
  estimate: any,
): Promise<{ pdf: Buffer; fileName: string }> {
  if ((estimate as any).executed_file_id) {
    try {
      const { data: file, error: fileError } = await supabase
        .from("files")
        .select("storage_path, file_name")
        .eq("org_id", estimate.org_id)
        .eq("id", (estimate as any).executed_file_id)
        .maybeSingle()

      if (fileError) throw new Error(fileError.message)
      if (file?.storage_path) {
        const bytes = await downloadFilesObject({ supabase, orgId: estimate.org_id, path: file.storage_path })
        return { pdf: Buffer.from(bytes), fileName: file.file_name ?? `estimate-${estimate.id}.pdf` }
      }
    } catch (error) {
      // The stored executed file is unavailable (missing row, blank path, or a
      // storage read error). Fall back to re-rendering the signed estimate so the
      // portal download never hard-fails after execution.
      console.error(
        `[renderEstimatePdfByToken] Could not serve executed file for estimate ${estimate.id}; falling back to live render:`,
        error,
      )
    }
  }

  const [branding, questions] = await Promise.all([
    getOrgBranding(estimate.org_id, supabase),
    loadEstimateQuestions(supabase, estimate.org_id, (estimate as any).prospect_id ?? null),
  ])
  const metadata = (estimate.metadata as Record<string, any> | null) ?? {}
  const items = [...((estimate as any).items ?? [])].sort(
    (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  )

  const signatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
  const clientSigner = signatureData.client ?? {}
  const builderSigner = signatureData.builder ?? {}
  const pdfRecipient = resolveEstimateRecipient(estimate)
  const signers =
    (estimate as any).client_signed_at || (estimate as any).builder_signed_at
      ? [
          ...clientSignerBlocks(metadata, signatureData, {
            name: clientSigner.signer_name ?? pdfRecipient.name ?? null,
            signedAt: (estimate as any).client_signed_at ?? null,
          }),
          {
            role: branding.name ?? "Builder",
            name: builderSigner.signer_name ?? null,
            signedAt: builderSigner.signed_at ?? (estimate as any).builder_signed_at ?? null,
            signatureImage: builderSigner.signature_image ?? null,
          },
        ]
      : undefined

  const acceptedOptions = (metadata.accepted_options as AcceptedOptions | null) ?? null
  const isSigned = Boolean((estimate as any).client_signed_at || (estimate as any).builder_signed_at)
  const hasAcceptedScope = isSigned || (estimate.status === "approved" && normalizeEstimateCommercial(metadata).purpose === "budget")
  const totalForPdf = hasAcceptedScope && acceptedOptions ? acceptedOptions.accepted_total_cents : estimate.total_cents
  const taxForPdf =
    hasAcceptedScope && acceptedOptions
      ? (estimate.tax_cents ?? 0) + (acceptedOptions.optional_tax_cents ?? 0)
      : estimate.tax_cents

  const pdf = await renderEstimatePdf({
    orgName: branding.name ?? undefined,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    accentColor: branding.estimateAccentColor,
    fontFamily: branding.estimateFont,
    builderFeeCents: estimateBuilderFeeCents(metadata),
    estimateTitle: estimate.title,
    recipientName: pdfRecipient.name ?? undefined,
    recipientEmail: pdfRecipient.email ?? null,
    projectName: (estimate as any).project?.name ?? (estimate as any).prospect?.name ?? null,
    issuedAt: (estimate as any).created_at ?? null,
    intro: typeof metadata.intro === "string" ? metadata.intro : null,
    summary: typeof metadata.summary === "string" ? metadata.summary : null,
    terms: estimateDocumentTerms(metadata, branding.estimateTermsTemplate),
    pricingDisplay: normalizePricingDisplay(metadata.display?.pricing),
    acceptedOptionalIds: acceptedOptions?.ids ?? null,
    hideUnacceptedOptionals: hasAcceptedScope,
    totalRange: estimatePriceRange(metadata),
    subtotalCents: estimate.subtotal_cents,
    taxCents: taxForPdf,
    totalCents: totalForPdf,
    contingencyCents: (estimate.total_cents ?? 0) - (estimate.subtotal_cents ?? 0) - (estimate.tax_cents ?? 0),
    contingencyPercent: Number(metadata.contingency_percent ?? 0) || 0,
    inclusions: typeof metadata.inclusions === "string" ? metadata.inclusions : null,
    exclusions: typeof metadata.exclusions === "string" ? metadata.exclusions : null,
    validUntil: estimate.valid_until,
    documentLabel: signers ? ((estimate as any).executed_at ? "Executed agreement" : "Client-signed agreement") : proposalDocumentLabel(normalizeEstimateCommercial(estimate.metadata)),
    signers,
    proposal: estimateProposal(metadata),
    questions,
    lines: items,
  })

  return { pdf, fileName: `estimate-${estimate.id}.pdf` }
}

/**
 * The client's signature lines: one per signer when the agreement has several
 * (in the order they were asked to sign), otherwise the one client.
 */
function clientSignerBlocks(
  metadata: Record<string, any>,
  signatureData: Record<string, any>,
  fallback: { name: string | null; signedAt: string | null },
): QuoteSigner[] {
  const signed = (signatureData.signers ?? {}) as Record<string, Record<string, any>>
  const signers = estimateProposal(metadata)?.signers ?? []
  if (signers.length)
    return signers.map((person) => {
      const signature = signed[person.email.toLowerCase()] ?? {}
      return {
        role: "Client",
        name: signature.signer_name ?? person.name,
        signedAt: signature.signed_at ?? null,
        signatureImage: signature.signature_image ?? null,
      }
    })
  const client = signatureData.client ?? {}
  return [{
    role: "Client",
    name: client.signer_name ?? fallback.name,
    signedAt: client.signed_at ?? fallback.signedAt,
    signatureImage: client.signature_image ?? null,
  }]
}

function estimateLinesToQuoteLines(lines: any[]) {
  return [...(lines ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_cost_cents: line.unit_cost_cents,
      markup_pct: line.markup_pct,
      item_type: line.item_type,
      metadata: line.metadata,
    }))
}

function safePdfName(value: string) {
  return value.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 160) || "executed-estimate.pdf"
}

/**
 * Builds the audit-evidence rows appended as an "Electronic Signature Certificate"
 * page on the executed estimate — the same certificate the unified e-sign engine
 * produces, so a countersigned estimate carries equivalent evidence.
 */
function buildEstimateAuditTrail(estimate: any, signatureData: Record<string, any>): ESignAuditTrailItem[] {
  const client = signatureData.client ?? {}
  const builder = signatureData.builder ?? {}
  const fmt = (value?: string | null) =>
    value ? new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : null

  return [
    { label: "Document", value: estimate.title ?? null },
    { label: "Estimate version", value: `v${estimate.version ?? 1}` },
    { label: "Document ID", value: estimate.id ?? null },
    { label: "Client signer", value: client.signer_name ?? estimate.recipient?.full_name ?? null },
    { label: "Client email", value: client.signer_email ?? estimate.recipient?.email ?? null },
    { label: "Client signed at", value: fmt(client.signed_at ?? estimate.client_signed_at) },
    { label: "Client IP address", value: client.signer_ip ?? null },
    { label: "Client consent", value: client.consent_accepted ? "Accepted" : null },
    // Every other signer of a multi-signer agreement carries the same evidence.
    ...Object.values((signatureData.signers ?? {}) as Record<string, Record<string, any>>)
      .filter((signer) => signer.signer_email !== client.signer_email)
      .flatMap((signer) => [
        { label: "Signer", value: signer.signer_name ?? null },
        { label: "Signer email", value: signer.signer_email ?? null },
        { label: "Signer signed at", value: fmt(signer.signed_at) },
        { label: "Signer IP address", value: signer.signer_ip ?? null },
        { label: "Signer consent", value: signer.consent_accepted ? "Accepted" : null },
      ]),
    { label: "Builder signer", value: builder.signer_name ?? null },
    { label: "Builder email", value: builder.signer_email ?? null },
    { label: "Builder signed at", value: fmt(builder.signed_at ?? estimate.builder_signed_at) },
    { label: "Builder IP address", value: builder.signer_ip ?? null },
    { label: "Executed at", value: fmt(estimate.executed_at ?? new Date().toISOString()) },
  ]
}

async function generateExecutedEstimateArtifact({
  supabase,
  orgId,
  userId,
  estimate,
  signatureData,
  execution,
}: {
  supabase: ServiceClient
  orgId: string
  userId: string | null
  estimate: any
  signatureData: Record<string, any>
  execution?: { envelopeId: string; documentId: string; revision: number; fileId: string; leaseToken: string; sourcePath: string; sourceHash?: string }
}): Promise<{ fileId: string; documentId: string } | { skippedReason: string }> {
  const projectId = (estimate.project_id as string | null) ?? null
  const prospectId = (estimate.prospect_id as string | null) ?? null
  const contextType = projectId ? "projects" : prospectId ? "prospects" : "estimates"
  const contextId = projectId ?? prospectId ?? estimate.id

  try {
    const branding = await getOrgBranding(orgId, supabase)
    const metadata = (estimate.metadata as Record<string, any> | null) ?? {}
    const clientSigner = signatureData.client ?? {}
    const builderSigner = signatureData.builder ?? {}
    const executedRecipient = resolveEstimateRecipient(estimate)
    const fileName = safePdfName(`executed-estimate-${estimate.title ?? estimate.id}.pdf`)

    const executedAccepted = (metadata.accepted_options as AcceptedOptions | null) ?? null
    let frozenSourceHash: string | undefined
    const nativeBase = async () => {
      const source = await downloadFilesObject({ supabase, orgId, path: execution!.sourcePath })
      frozenSourceHash = createHash("sha256").update(source).digest("hex")
      if (execution!.sourceHash && frozenSourceHash !== execution!.sourceHash) throw new Error("Estimate source no longer matches the issued agreement")
      const { PDFDocument } = await import("pdf-lib")
      const pdf = await PDFDocument.load(source)
      const page = pdf.addPage([612, 792])
      page.drawText("Builder electronic signature", { x: 48, y: 736, size: 18 })
      const image = await pdf.embedPng(builderSigner.signature_image)
      const scale = Math.min(420 / image.width, 160 / image.height)
      page.drawImage(image, { x: 48, y: 510, width: image.width * scale, height: image.height * scale })
      page.drawText("Signer identity, consent and time follow in the completion certificate.", { x: 48, y: 480, size: 11 })
      return Buffer.from(await pdf.save())
    }
    const basePdf = execution ? await nativeBase() : await renderEstimatePdf({
      orgName: branding.name ?? undefined,
      orgLogoUrl: branding.logoUrl,
      orgAddress: branding.address,
      accentColor: branding.estimateAccentColor,
      fontFamily: branding.estimateFont,
      documentLabel: "Executed agreement",
      builderFeeCents: estimateBuilderFeeCents(metadata),
      estimateTitle: estimate.title,
      recipientName: executedRecipient.name ?? clientSigner.signer_name ?? undefined,
      recipientEmail: executedRecipient.email ?? clientSigner.signer_email ?? null,
      projectName: estimate.project?.name ?? estimate.prospect?.name ?? null,
      issuedAt: (estimate as any).created_at ?? null,
      intro: typeof metadata.intro === "string" ? metadata.intro : null,
      summary: typeof metadata.summary === "string" ? metadata.summary : null,
      terms: estimateDocumentTerms(metadata, branding.estimateTermsTemplate),
      pricingDisplay: normalizePricingDisplay(metadata.display?.pricing),
      acceptedOptionalIds: executedAccepted?.ids ?? null,
      hideUnacceptedOptionals: true,
      subtotalCents: estimate.subtotal_cents,
      taxCents: executedAccepted
        ? (estimate.tax_cents ?? 0) + (executedAccepted.optional_tax_cents ?? 0)
        : estimate.tax_cents,
      totalCents: executedAccepted ? executedAccepted.accepted_total_cents : estimate.total_cents,
      contingencyCents: (estimate.total_cents ?? 0) - (estimate.subtotal_cents ?? 0) - (estimate.tax_cents ?? 0),
      contingencyPercent: Number(metadata.contingency_percent ?? 0) || 0,
      inclusions: typeof metadata.inclusions === "string" ? metadata.inclusions : null,
      exclusions: typeof metadata.exclusions === "string" ? metadata.exclusions : null,
      validUntil: estimate.valid_until,
      signers: [
        ...clientSignerBlocks(metadata, signatureData, {
          name: clientSigner.signer_name ?? estimate.recipient?.full_name ?? null,
          signedAt: estimate.client_signed_at ?? null,
        }),
        {
          role: branding.name ?? "Builder",
          name: builderSigner.signer_name ?? null,
          signedAt: builderSigner.signed_at ?? estimate.builder_signed_at ?? null,
          signatureImage: builderSigner.signature_image ?? null,
        },
      ],
      proposal: estimateProposal(metadata),
      lines: estimateLinesToQuoteLines(estimate.items ?? []),
    })

    // Evidence is part of the executed artifact. Rendering failure is retryable.
    const pdf = Buffer.from(await generateExecutedPdf({
      pdfBytes: basePdf, fields: [], values: {},
      auditTrail: buildEstimateAuditTrail(estimate, signatureData),
    }))

    const storagePath = buildOrgScopedPath(
      orgId,
      contextType,
      contextId,
      "executed-estimates",
      execution ? `${execution.fileId}.pdf` : `${Date.now()}_${fileName}`,
    )

    await uploadFilesObject({
      supabase,
      orgId,
      path: storagePath,
      bytes: pdf,
      contentType: "application/pdf",
      upsert: Boolean(execution),
    })

    if (execution) {
      const sourceHash = frozenSourceHash ?? createHash("sha256").update(basePdf).digest("hex")
      const executedHash = createHash("sha256").update(pdf).digest("hex")
      const evidenceManifest = createEstimateEvidenceManifest({ documentId: execution.documentId,
        envelopeId: execution.envelopeId, revision: execution.revision, sourceHash, executedHash,
        builder: builderSigner, earlierClient: clientSigner })
      const { data: fileId, error } = await supabase.rpc("complete_esign_execution", {
        p_org_id: orgId, p_envelope_id: execution.envelopeId, p_lease_token: execution.leaseToken,
        p_artifact: { file_name: fileName, storage_path: storagePath, size_bytes: pdf.length,
          metadata: { estimate_id: estimate.id, source_sha256: sourceHash, executed_sha256: executedHash,
            evidence_manifest: evidenceManifest, audit_certificate: "appended_to_executed_pdf" },
          signer: { signer_name: builderSigner.signer_name, signer_email: builderSigner.signer_email,
            signer_ip: builderSigner.signer_ip, signed_at: builderSigner.signed_at,
            signature_image: builderSigner.signature_image, consent_text: builderSigner.consent_text } },
      })
      if (error || !fileId) throw new Error(`Could not publish executed estimate: ${error?.message ?? "missing file"}`)
      return { fileId, documentId: execution.documentId }
    }

    const { data: file, error: fileError } = await supabase
      .from("files")
      .insert({
        org_id: orgId,
        project_id: projectId,
        prospect_id: prospectId,
        file_name: fileName,
        storage_path: storagePath,
        mime_type: "application/pdf",
        size_bytes: pdf.length,
        visibility: "private",
        category: "contracts",
        folder_path: "/contracts",
        source: "generated",
        uploaded_by: userId,
        tags: ["estimate", "executed"],
        metadata: {
          estimate_id: estimate.id,
          generated_from: "estimate_execution",
        },
      })
      .select("id")
      .single()

    if (fileError || !file) {
      throw new Error(`Failed to create executed estimate file record: ${fileError?.message}`)
    }

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .insert({
        org_id: orgId,
        project_id: projectId,
        prospect_id: prospectId,
        document_type: "estimate",
        title: `Executed ${estimate.title}`,
        status: "signed",
        source_file_id: file.id,
        executed_file_id: file.id,
        source_entity_type: "estimate",
        source_entity_id: estimate.id,
        metadata: {
          estimate_id: estimate.id,
          generated_from: "estimate_execution",
          signature_data: signatureData,
        },
        created_by: userId,
      })
      .select("id")
      .single()

    if (documentError || !document) {
      throw new Error(`Failed to create executed estimate document record: ${documentError?.message}`)
    }

    await supabase.from("file_links").insert({
      org_id: orgId,
      file_id: file.id,
      project_id: projectId,
      prospect_id: prospectId,
      entity_type: "estimate",
      entity_id: estimate.id,
      created_by: userId,
      link_role: "executed_estimate",
    })

    return { fileId: file.id as string, documentId: document.id as string }
  } catch (error) {
    return { skippedReason: (error as Error)?.message ?? "Failed to generate executed estimate PDF." }
  }
}

type EstimateBuilderSignerMode = "estimate_creator" | "prospect_owner" | "specific_user"

async function resolveEstimateBuilderSigner(input: {
  supabase: ServiceClient
  orgId: string
  estimate: any
}): Promise<{ userId: string; name: string; email: string; mode: EstimateBuilderSignerMode }> {
  const { supabase, orgId, estimate } = input
  const { data: settingsRow } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  const settings = (settingsRow?.settings as Record<string, any> | null) ?? {}
  const rawMode = settings.estimate_builder_signer_mode
  const mode: EstimateBuilderSignerMode =
    rawMode === "prospect_owner" || rawMode === "specific_user" ? rawMode : "estimate_creator"

  const candidates: Array<{ userId?: string | null; mode: EstimateBuilderSignerMode }> = []
  if (mode === "specific_user") {
    candidates.push({ userId: settings.estimate_builder_signer_user_id as string | null | undefined, mode })
  }
  if (mode === "prospect_owner") {
    candidates.push({ userId: estimate.prospect?.owner_user_id ?? null, mode })
  }
  candidates.push({ userId: estimate.created_by ?? null, mode: "estimate_creator" })
  candidates.push({ userId: estimate.prospect?.owner_user_id ?? null, mode: "prospect_owner" })

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const userId = candidate.userId?.trim()
    if (!userId || seen.has(userId)) continue
    seen.add(userId)

    const [{ data: user }, { data: membership }] = await Promise.all([
      supabase.from("app_users").select("id, email, full_name").eq("id", userId).maybeSingle(),
      supabase
        .from("memberships")
        .select("id, status")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .in("status", ["active", "invited"])
        .maybeSingle(),
    ])

    const email = typeof user?.email === "string" ? user.email.trim() : ""
    if (membership?.id && email) {
      return {
        userId,
        email,
        name: user?.full_name?.trim() || email,
        mode: candidate.mode,
      }
    }
  }

  throw new Error("Choose an estimate builder signer in Settings > Organization before client-signed estimates can be countersigned.")
}

async function sendBuilderEstimateSigningEmail(input: {
  estimate: any
  branding: OrgBranding
  signerName: string
  signerEmail: string
  signingUrl: string
  orgId: string
  requestId: string
  envelopeId: string
}) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.rpc("queue_esign_recipients", { p_org_id: input.orgId, p_envelope_id: input.envelopeId })
  if (error) throw new Error(`Could not queue builder signing invitation: ${error.message}`)
  try {
    await deliverSigningInvitation({ orgId: input.orgId, requestId: input.requestId })
    return true
  } catch {
    // The outbox owns retries; the client signature remains durable.
    return false
  }
}

async function issueBuilderEstimateSigningEnvelope(input: {
  supabase: ServiceClient
  orgId: string
  estimateId: string
  signatureData: Record<string, any>
}): Promise<{ documentId: string; envelopeId: string; signingRequestId: string; signingUrl: string; signerEmail: string; emailSent: boolean }> {
  const { supabase, orgId, estimateId, signatureData } = input

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `*, items:estimate_items(*),
       project:projects(name),
       prospect:prospects(name, owner_user_id),
       recipient:contacts(full_name, email)`,
    )
    .eq("org_id", orgId)
    .eq("id", estimateId)
    .maybeSingle()

  if (error || !estimate) {
    throw new Error(`Estimate not found for signing envelope: ${error?.message ?? "missing"}`)
  }

  if (estimate.status !== "client_signed" || !estimate.is_current_version || normalizeEstimateCommercial(estimate.metadata).purpose === "budget") {
    throw new Error("This agreement is no longer awaiting builder signature.")
  }
  const branding = await getOrgBranding(orgId, supabase)
  const metadata = (estimate.metadata as Record<string, any> | null) ?? {}

  const { data: existingEnvelope } = await supabase
    .from("envelopes")
    .select("id, status, document_id")
    .eq("org_id", orgId)
    .eq("source_entity_type", "estimate")
    .eq("source_entity_id", estimateId)
    .in("status", ["draft", "sent", "partially_signed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingEnvelope?.id) {
    const { data: existingRequest } = await supabase
      .from("document_signing_requests")
      .select("id, sent_to_email, status, envelope_recipient_id")
      .eq("org_id", orgId)
      .eq("envelope_id", existingEnvelope.id)
      .neq("status", "signed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingRequest?.id && existingRequest.sent_to_email) {
      const { data: existingRecipient } = existingRequest.envelope_recipient_id
        ? await supabase
            .from("envelope_recipients")
            .select("name, email")
            .eq("org_id", orgId)
            .eq("id", existingRequest.envelope_recipient_id)
            .maybeSingle()
        : { data: null }

      const { url: signingUrl } = await issueSigningLinkForRequest(supabase, { orgId, requestId: existingRequest.id, markSent: true })
      const nowIso = new Date().toISOString()

      const signerEmail = String(existingRequest.sent_to_email)
      const signerName = existingRecipient?.name?.trim() || existingRecipient?.email?.trim() || signerEmail
      const emailSent = await sendBuilderEstimateSigningEmail({
        orgId, requestId: existingRequest.id, envelopeId: existingEnvelope.id,
        estimate,
        branding,
        signerName,
        signerEmail,
        signingUrl,
      })

      await supabase
        .from("estimates")
        .update({
          metadata: {
            ...metadata,
            estimate_execution: {
              ...(typeof metadata.estimate_execution === "object" && metadata.estimate_execution ? metadata.estimate_execution : {}),
              builder_signing_document_id: existingEnvelope.document_id,
              builder_signing_envelope_id: existingEnvelope.id,
              builder_signing_request_id: existingRequest.id,
              builder_signer_email: signerEmail,
              builder_signing_sent_at: nowIso,
              builder_signing_email_sent: emailSent,
            },
          },
          updated_at: nowIso,
        })
        .eq("org_id", orgId)
        .eq("id", estimate.id)

      return {
        documentId: existingEnvelope.document_id as string,
        envelopeId: existingEnvelope.id as string,
        signingRequestId: existingRequest.id as string,
        signingUrl,
        signerEmail,
        emailSent,
      }
    }
  }

  const signer = await resolveEstimateBuilderSigner({ supabase, orgId, estimate })
  const clientSigner = signatureData.client ?? {}
  const nowIso = new Date().toISOString()
  const fileName = safePdfName(`estimate-${estimate.title ?? estimate.id}-builder-signature.pdf`)
  const projectId = (estimate.project_id as string | null) ?? null
  const prospectId = (estimate.prospect_id as string | null) ?? null
  const contextType = projectId ? "projects" : prospectId ? "prospects" : "estimates"
  const contextId = projectId ?? prospectId ?? estimate.id

  const builderAccepted = (metadata.accepted_options as AcceptedOptions | null) ?? null
  const sourcePdf = await renderEstimatePdf({
    orgName: branding.name ?? undefined,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    accentColor: branding.estimateAccentColor,
    fontFamily: branding.estimateFont,
    documentLabel: "Client-signed agreement",
    builderFeeCents: estimateBuilderFeeCents(metadata),
    estimateTitle: estimate.title,
    recipientName: estimate.recipient?.full_name ?? clientSigner.signer_name ?? undefined,
    recipientEmail: estimate.recipient?.email ?? clientSigner.signer_email ?? null,
    projectName: estimate.project?.name ?? estimate.prospect?.name ?? null,
    issuedAt: (estimate as any).created_at ?? null,
    intro: typeof metadata.intro === "string" ? metadata.intro : null,
    summary: typeof metadata.summary === "string" ? metadata.summary : null,
    terms: estimateDocumentTerms(metadata, branding.estimateTermsTemplate),
    pricingDisplay: normalizePricingDisplay(metadata.display?.pricing),
    acceptedOptionalIds: builderAccepted?.ids ?? null,
    hideUnacceptedOptionals: true,
    subtotalCents: estimate.subtotal_cents,
    taxCents: builderAccepted
      ? (estimate.tax_cents ?? 0) + (builderAccepted.optional_tax_cents ?? 0)
      : estimate.tax_cents,
    totalCents: builderAccepted ? builderAccepted.accepted_total_cents : estimate.total_cents,
    contingencyCents: (estimate.total_cents ?? 0) - (estimate.subtotal_cents ?? 0) - (estimate.tax_cents ?? 0),
    contingencyPercent: Number(metadata.contingency_percent ?? 0) || 0,
    inclusions: typeof metadata.inclusions === "string" ? metadata.inclusions : null,
    exclusions: typeof metadata.exclusions === "string" ? metadata.exclusions : null,
    validUntil: estimate.valid_until,
    signers: [
      ...clientSignerBlocks(metadata, signatureData, {
        name: clientSigner.signer_name ?? estimate.recipient?.full_name ?? null,
        signedAt: estimate.client_signed_at ?? null,
      }),
      { role: branding.name ?? "Builder", name: signer.name },
    ],
    proposal: estimateProposal(metadata),
    lines: estimateLinesToQuoteLines(estimate.items ?? []),
  })

  const storagePath = buildOrgScopedPath(
    orgId,
    contextType,
    contextId,
    "esign",
    "estimate-builder-signature",
    `${Date.now()}_${fileName}`,
  )

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes: sourcePdf,
    contentType: "application/pdf",
    upsert: false,
  })

  const { data: file, error: fileError } = await supabase
    .from("files")
    .insert({
      org_id: orgId,
      project_id: projectId,
      prospect_id: prospectId,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: sourcePdf.length,
      visibility: "private",
      category: "contracts",
      folder_path: "/contracts",
      source: "generated",
      uploaded_by: estimate.created_by ?? null,
      tags: ["estimate", "client-signed", "builder-signature"],
      metadata: { estimate_id: estimate.id, generated_from: "estimate_client_signature" },
    })
    .select("id")
    .single()

  if (fileError || !file) {
    throw new Error(`Failed to create estimate signing source file: ${fileError?.message}`)
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .insert({
      org_id: orgId,
      project_id: projectId,
      prospect_id: prospectId,
      document_type: "estimate",
      title: `Countersign ${estimate.title}`,
      status: "sent",
      source_file_id: file.id,
      source_entity_type: "estimate",
      source_entity_id: estimate.id,
      metadata: {
        estimate_id: estimate.id,
        completion_event: "estimate.executed",
        unified_esign_phase: "2026-02-07.phase0",
        estimate_signature_data: signatureData,
        esign_source: { storage_path: storagePath, sha256: createHash("sha256").update(sourcePdf).digest("hex"), file_id: file.id },
        envelope_recipients: [
          {
            type: "internal_user",
            user_id: signer.userId,
            name: signer.name,
            email: signer.email,
            role: "signer",
            signer_role: "builder",
            sequence: 1,
            required: true,
          },
        ],
      },
      created_by: estimate.created_by ?? null,
    })
    .select("id")
    .single()

  if (documentError || !document) {
    throw new Error(`Failed to create estimate signing document: ${documentError?.message}`)
  }

  const { data: envelope, error: envelopeError } = await supabase
    .from("envelopes")
    .insert({
      org_id: orgId,
      project_id: projectId,
      prospect_id: prospectId,
      document_id: document.id,
      document_revision: 1,
      source_entity_type: "estimate",
      source_entity_id: estimate.id,
      status: "sent",
      sent_at: nowIso,
      metadata: {
        estimate_id: estimate.id,
        completion_event: "estimate.executed",
        unified_esign_phase: "2026-02-07.phase0",
      },
      created_by: estimate.created_by ?? null,
    })
    .select("id")
    .single()

  if (envelopeError || !envelope) {
    throw new Error(`Failed to create estimate builder signing envelope: ${envelopeError?.message}`)
  }

  const { data: recipient, error: recipientError } = await supabase
    .from("envelope_recipients")
    .insert({
      org_id: orgId,
      envelope_id: envelope.id,
      recipient_type: "internal_user",
      user_id: signer.userId,
      name: signer.name,
      email: signer.email,
      role: "signer",
      signer_role: "builder",
      sequence: 1,
      required: true,
      metadata: { estimate_builder_signer_mode: signer.mode },
    })
    .select("id")
    .single()

  if (recipientError || !recipient) {
    throw new Error(`Failed to create estimate builder signing recipient: ${recipientError?.message}`)
  }

  const signingToken = randomBytes(32).toString("hex")
  const signingUrl = buildUnifiedSigningUrl(signingToken)
  const { data: request, error: requestError } = await supabase
    .from("document_signing_requests")
    .insert({
      org_id: orgId,
      document_id: document.id,
      revision: 1,
      token_hash: hashSigningToken(signingToken),
      status: "sent",
      sent_to_email: signer.email,
      max_uses: 1,
      signer_role: "builder",
      sequence: 1,
      required: true,
      group_id: envelope.id,
      envelope_id: envelope.id,
      envelope_recipient_id: recipient.id,
      created_by: estimate.created_by ?? null,
      sent_at: nowIso,
    })
    .select("id")
    .single()

  if (requestError || !request) {
    throw new Error(`Failed to create estimate builder signing request: ${requestError?.message}`)
  }

  await supabase
    .from("estimates")
    .update({
      signature_document_id: document.id,
      metadata: {
        ...metadata,
        estimate_execution: {
          ...(typeof metadata.estimate_execution === "object" && metadata.estimate_execution ? metadata.estimate_execution : {}),
          builder_signing_document_id: document.id,
          builder_signing_envelope_id: envelope.id,
          builder_signing_request_id: request.id,
          builder_signer_user_id: signer.userId,
          builder_signer_email: signer.email,
          builder_signer_mode: signer.mode,
          builder_signing_sent_at: nowIso,
        },
      },
      updated_at: nowIso,
    })
    .eq("org_id", orgId)
    .eq("id", estimate.id)

  await Promise.all([
    recordESignEvent({
      supabase,
      orgId,
      actorId: estimate.created_by ?? undefined,
      eventType: ENVELOPE_EVENT_TYPES.created,
      envelopeId: envelope.id,
      documentId: document.id,
      payload: { source: "estimate.client_signature", estimate_id: estimate.id },
    }),
    recordESignEvent({
      supabase,
      orgId,
      actorId: estimate.created_by ?? undefined,
      eventType: ENVELOPE_EVENT_TYPES.sent,
      envelopeId: envelope.id,
      documentId: document.id,
      payload: { source: "estimate.client_signature", estimate_id: estimate.id, signer_email: signer.email },
    }),
  ])

  const emailSent = await sendBuilderEstimateSigningEmail({
    orgId, requestId: request.id, envelopeId: envelope.id,
    estimate,
    branding,
    signerName: signer.name,
    signerEmail: signer.email,
    signingUrl,
  })

  await supabase
    .from("estimates")
    .update({
      metadata: {
        ...metadata,
        estimate_execution: {
          ...(typeof metadata.estimate_execution === "object" && metadata.estimate_execution ? metadata.estimate_execution : {}),
          builder_signing_document_id: document.id,
          builder_signing_envelope_id: envelope.id,
          builder_signing_request_id: request.id,
          builder_signer_user_id: signer.userId,
          builder_signer_email: signer.email,
          builder_signer_mode: signer.mode,
          builder_signing_sent_at: nowIso,
          builder_signing_email_sent: emailSent,
          builder_signing_email_sent_at: new Date().toISOString(),
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
    .eq("id", estimate.id)

  return {
    documentId: document.id as string,
    envelopeId: envelope.id as string,
    signingRequestId: request.id as string,
    signingUrl,
    signerEmail: signer.email,
    emailSent,
  }
}

/** Kept for existing server-action callers; signatures require explicit signer consent. */
export async function countersignEstimate(_input: {
  estimateId: string
  signerName?: string | null
  orgId?: string
}): Promise<{ estimate: any; executedFileId: string | null; signatureDocumentId: string | null; artifactSkippedReason: string | null }> {
  throw new Error("Open builder signing to review the issued agreement, accept electronic signature consent, and sign. Direct countersigning is no longer supported.")
}

export async function getEstimateBuilderSigningLink({
  estimateId,
  orgId,
}: {
  estimateId: string
  orgId?: string
}) {
  const { service: supabase, orgId: resolvedOrgId, userId } = await authorizeEstimateDocumentWrite(estimateId, orgId)

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select("id, org_id, title, status, is_current_version, client_signed_at, signature_data, signature_document_id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", estimateId)
    .maybeSingle()

  if (estimateError || !estimate) {
    throw new Error(`Estimate not found: ${estimateError?.message ?? "missing"}`)
  }
  if (estimate.status !== "client_signed" || !estimate.is_current_version) {
    throw new Error("Builder signing is only available after the client signs.")
  }

  const metadata = ((estimate as any).metadata as Record<string, any> | null) ?? {}
  const executionMetadata = (metadata.estimate_execution as Record<string, any> | null) ?? {}
  const documentId = (estimate as any).signature_document_id ?? executionMetadata.builder_signing_document_id
  const envelopeId = executionMetadata.builder_signing_envelope_id

  async function createBuilderSigningRequest() {
    const signatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
    const result = await issueBuilderEstimateSigningEnvelope({
      supabase,
      orgId: resolvedOrgId,
      estimateId,
      signatureData,
    })

    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "estimate_builder_signing_link_issued",
      entityType: "estimate",
      entityId: estimateId,
      actorId: userId,
      payload: {
        signing_request_id: result.signingRequestId,
        sent_to_email: result.signerEmail,
        email_sent: result.emailSent,
        repaired_missing_request: true,
      },
    })

    return {
      url: result.signingUrl,
      signingRequestId: result.signingRequestId,
      signerEmail: result.signerEmail,
    }
  }

  let requestQuery = supabase
    .from("document_signing_requests")
    .select("id, sent_to_email, status, envelope_recipient_id")
    .eq("org_id", resolvedOrgId)
    .neq("status", "signed")
    .order("created_at", { ascending: false })
    .limit(1)

  if (envelopeId) {
    requestQuery = requestQuery.eq("envelope_id", envelopeId)
  } else if (documentId) {
    requestQuery = requestQuery.eq("document_id", documentId)
  } else {
    return createBuilderSigningRequest()
  }

  const { data: request, error: requestError } = await requestQuery.maybeSingle()
  if (requestError || !request) {
    if (requestError) {
      throw new Error(`Builder signing request lookup failed: ${requestError.message}`)
    }
    return createBuilderSigningRequest()
  }
  if (request.status === "voided" || request.status === "expired") {
    throw new Error("Builder signing request is no longer active.")
  }

  const { url: signingUrl } = await issueSigningLinkForRequest(supabase, { orgId: resolvedOrgId, requestId: request.id, markSent: true })
  const nowIso = new Date().toISOString()

  let emailSent: boolean | null = null
  if (request.sent_to_email) {
    const branding = await getOrgBranding(resolvedOrgId, supabase)
    const { data: recipient } = request.envelope_recipient_id
      ? await supabase
          .from("envelope_recipients")
          .select("name, email")
          .eq("org_id", resolvedOrgId)
          .eq("id", request.envelope_recipient_id)
          .maybeSingle()
      : { data: null }
    const signerEmail = String(request.sent_to_email)
    const signerName = recipient?.name?.trim() || recipient?.email?.trim() || signerEmail
    emailSent = await sendBuilderEstimateSigningEmail({
      orgId: resolvedOrgId, requestId: request.id, envelopeId,
      estimate,
      branding,
      signerName,
      signerEmail,
      signingUrl: signingUrl,
    })

    const currentMetadata = ((estimate as any).metadata as Record<string, any> | null) ?? {}
    await supabase
      .from("estimates")
      .update({
        metadata: {
          ...currentMetadata,
          estimate_execution: {
            ...(typeof currentMetadata.estimate_execution === "object" && currentMetadata.estimate_execution
              ? currentMetadata.estimate_execution
              : {}),
            builder_signing_email_sent: emailSent,
            builder_signing_email_sent_at: nowIso,
          },
        },
        updated_at: nowIso,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", estimateId)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_builder_signing_link_issued",
    entityType: "estimate",
    entityId: estimateId,
    actorId: userId,
    payload: { signing_request_id: request.id, sent_to_email: request.sent_to_email, email_sent: emailSent },
  })

  return {
    url: signingUrl,
    signingRequestId: request.id as string,
    signerEmail: (request.sent_to_email as string | null) ?? null,
  }
}

const DECISION_KIND: Record<EstimateDecision, string> = {
  approved: "approval",
  rejected: "rejection",
  changes_requested: "changes_requested",
}

/**
 * Notifies the builder (estimate creator, falling back to the prospect owner) when a
 * client requests changes or declines from the portal. Sends the email **synchronously**
 * at submission time — mirroring the countersign nudge the builder gets on approval — so
 * there is no outbox-queue delay; the in-app bell notification is recorded directly.
 * Best-effort: a notification failure never blocks the client decision.
 */
async function notifyBuilderOfClientResponse(input: {
  supabase: ServiceClient
  orgId: string
  estimate: any
  decision: Exclude<EstimateDecision, "approved">
  clientName: string
  note: string | null
}) {
  const { supabase, orgId, estimate, decision, clientName, note } = input
  const builderUserId =
    (typeof estimate.created_by === "string" && estimate.created_by) ||
    (typeof estimate.prospect?.owner_user_id === "string" && estimate.prospect.owner_user_id) ||
    null
  if (!builderUserId) {
    console.error("[estimate-portal] No builder to notify for estimate", estimate.id)
    return
  }

  const isChanges = decision === "changes_requested"
  const action = isChanges ? "requested changes to" : "declined"
  const title = isChanges ? `Changes requested: ${estimate.title}` : `Estimate declined: ${estimate.title}`
  const message = note
    ? `${clientName} ${action} "${estimate.title}":\n${note}`
    : `${clientName} ${action} "${estimate.title}".`

  // In-app bell notification (recorded directly — the email is sent synchronously below
  // rather than through the outbox, to avoid queue delay).
  try {
    await supabase.from("notifications").insert({
      org_id: orgId,
      user_id: builderUserId,
      notification_type: isChanges ? "estimate_changes_requested" : "estimate_declined",
      payload: {
        title,
        message,
        entity_type: "estimate",
        entity_id: estimate.id,
        prospect_id: estimate.prospect_id ?? null,
        decision,
        client_name: clientName,
      },
    })
  } catch (error) {
    console.error("[estimate-portal] Failed to record builder notification:", error)
  }

  // Synchronous email to the builder.
  try {
    const { data: builder } = await supabase
      .from("app_users")
      .select("email, full_name")
      .eq("id", builderUserId)
      .maybeSingle()

    const builderEmail = builder?.email?.trim()
    if (!builderEmail) {
      console.error("[estimate-portal] Builder has no email; skipping change-request email for estimate", estimate.id)
      return
    }

    const [branding, surface] = await Promise.all([getOrgBranding(orgId, supabase), loadWorkspaceSurface(orgId)])
    const ctaLink = estimate.prospect_id ? `${appUrl()}/pipeline/${estimate.prospect_id}` : `${appUrl()}/estimates`
    const html = await renderEmailTemplate(
      SignatureEmail({
        documentTitle: estimate.title,
        signingLink: ctaLink,
        orgName: branding.name ?? null,
        orgLogoUrl: branding.logoUrl ?? null,
        recipientName: builder?.full_name ?? null,
        projectName: estimate.prospect?.name ?? null,
        projectLabel: profileTerminology(surface.profile).project,
        eventLabel: "Estimate Update",
        headline: isChanges ? "Client requested changes" : "Client declined estimate",
        bodyText: `${clientName} reviewed "${estimate.title}" and ${action} it.`,
        detailLabel: isChanges ? "Requested changes" : "Note",
        detailText:
          note ?? (isChanges ? "Open the estimate to review and send a revised version." : "No reason was provided."),
        buttonText: isChanges ? "Review & revise" : "Open in Arc",
        previewText: title,
      }),
    )

    await sendEmail({
      to: [builderEmail],
      subject: title,
      html,
      from: getOrgSenderEmail(branding.slug, branding.name),
    })
  } catch (error) {
    console.error("[estimate-portal] Failed to send builder change-request email:", error)
  }
}

/** Client submits a decision (approve / reject / request changes) from the portal. No e-signature. */
export async function submitEstimateDecision(input: {
  token: string
  decision: EstimateDecision
  note?: string | null
  signature?: EstimateSignatureInput | null
  /** Ids of optional add-on line items the client chose to accept. */
  selected_optional_ids?: string[] | null
  ip?: string | null
}): Promise<{ status: string; waitingOn: string[] }> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(input.token)
  const link = await reviewLinkForToken(supabase, tokenHash)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      "id, org_id, prospect_id, title, status, valid_until, version_group_id, is_current_version, signature_data, metadata, total_cents, created_by, updated_at, items:estimate_items(id, item_type, quantity, unit_cost_cents, markup_pct, metadata), recipient:contacts(full_name, email), prospect:prospects(name, owner_user_id)",
    )
    .eq("id", link.estimateId)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) throw new Error("This estimate link is no longer valid.")

  // The link is sent to a known person, so attribute the decision to them.
  const recipient = resolveEstimateRecipient(estimate)
  const proposal = estimateProposal(estimate.metadata)
  const signer = link.signer ?? proposal?.signers[0] ?? null
  const name = signer?.name.trim() || recipient.name?.trim() || "Client"
  const email = signer?.email.trim() || recipient.email?.trim() || null

  if (!estimate.is_current_version) {
    throw new Error("A newer version of this estimate is available. Please use the latest link.")
  }
  if (["approved", "client_signed", "executed", "converted_to_project"].includes(estimate.status)) {
    throw new Error("This estimate has already been signed.")
  }
  if (estimate.valid_until && new Date(estimate.valid_until) < new Date()) {
    throw new Error("This estimate has expired. Please contact your builder for an updated copy.")
  }

  const isBudget = normalizeEstimateCommercial(estimate.metadata).purpose === "budget"
  const nowIso = new Date().toISOString()
  const existingSignatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
  // An agreement with several signers is client-signed only once the last of them signs.
  const signers = !isBudget ? proposal?.signers ?? [] : []
  const alreadySigned = signedEmails(existingSignatureData)
  if (input.decision === "approved" && email && alreadySigned.has(email.toLowerCase()))
    throw new Error("You already signed this agreement.")
  const waitingOn =
    input.decision === "approved"
      ? signers.filter((person) => person.email.toLowerCase() !== email?.toLowerCase() && !alreadySigned.has(person.email.toLowerCase()))
      : []
  const update: Record<string, any> = {
    status: input.decision === "approved" ? (isBudget ? "approved" : "client_signed") : input.decision,
    responded_at: nowIso,
    decision_note: input.note?.trim() || null,
    client_decision_name: name,
    client_decision_email: email,
  }
  if (input.decision === "approved") {
    const signature = input.signature
    const signerName = signature?.signer_name?.trim()
    if (!isBudget && (!signature?.consent_accepted || !signerName)) {
      throw new Error("Please sign and accept the estimate before approving.")
    }
    // The builder's questions are answered on this page, and a signature settles them.
    if (!isBudget) {
      const questions = await loadEstimateQuestions(supabase, estimate.org_id, (estimate as any).prospect_id ?? null)
      if (questions.some((question) => !question.answer))
        throw new Error("Answer the questions in the document before signing.")
    }

    // Alternates in the same option group are mutually exclusive; reject the
    // selection server-side rather than trusting the portal UI.
    const groupError = validateOptionGroups((estimate as any).items ?? [], input.selected_optional_ids ?? [])
    if (groupError) {
      throw new Error(groupError)
    }

    // Authoritatively resolve which optional add-ons the client accepted and the
    // resulting total, recomputed server-side from the persisted line items.
    const taxRate = Number(((estimate as any).metadata as Record<string, any> | null)?.tax_rate ?? 0) || 0
    const accepted = resolveAcceptedOptions(
      (estimate as any).items ?? [],
      (estimate as any).total_cents ?? 0,
      input.selected_optional_ids ?? [],
      taxRate,
    )
    if (!isBudget && estimate.metadata?.precon) {
      const issues = estimateCommercialIssues(normalizeEstimateCommercial(estimate.metadata), { totalCents: accepted.accepted_total_cents, hasAllowances: estimate.items?.some((item: any) => item.metadata?.is_allowance) })
      if (issues.length) throw new Error(issues.join(" "))
    }
    const existingMetadata = ((estimate as any).metadata as Record<string, any> | null) ?? {}
    // Every signer signs the same choices: once one has signed, the options are settled.
    const settled = existingMetadata.accepted_options as AcceptedOptions | undefined
    if (alreadySigned.size && settled && [...settled.ids].sort().join() !== [...accepted.ids].sort().join())
      throw new Error("Another signer already signed with these options. Ask for changes to change them.")
    update.metadata = { ...existingMetadata, accepted_options: accepted }

    if (!isBudget && signature && signers.length) {
      update.signature_data = {
        ...existingSignatureData,
        signers: {
          ...(existingSignatureData.signers ?? {}),
          [(email ?? signerName ?? "").toLowerCase()]: {
            signer_name: signerName,
            signer_email: email,
            signature_text: signature.signature_text?.trim() || signerName,
            signature_image: signature.signature_image || null,
            consent_accepted: true,
            signed_at: nowIso,
            signer_ip: input.ip ?? null,
            accepted_total_cents: accepted.accepted_total_cents,
            source: "estimate_portal",
          },
        },
      }
    }
    if (waitingOn.length) {
      // Recorded, but not yet the client's signature: the others still sign on their own links.
      delete update.status
      delete update.responded_at
      delete update.client_decision_name
      delete update.client_decision_email
    } else update.approved_at = nowIso

    if (!isBudget && signature && !waitingOn.length) {
    const primary = signers[0] ? (update.signature_data ?? existingSignatureData).signers?.[signers[0].email.toLowerCase()] : null
    await resolveEstimateBuilderSigner({ supabase, orgId: estimate.org_id, estimate })
    update.client_signed_at = nowIso
    update.signature_data = {
      ...existingSignatureData,
      ...(update.signature_data ?? {}),
      client: primary ?? {
        signer_name: signerName,
        signer_email: signature.signer_email?.trim() || email,
        signature_text: signature.signature_text?.trim() || signerName,
        signature_image: signature.signature_image || null,
        consent_accepted: true,
        signed_at: nowIso,
        signer_ip: input.ip ?? null,
        accepted_total_cents: accepted.accepted_total_cents,
        source: "estimate_portal",
      },
    }
    }
  }

  // Precondition on status so a concurrent decision (double-click, two tabs)
  // can't re-sign or overwrite an already-recorded outcome.
  let guarded = supabase
    .from("estimates")
    .update(signers.length ? { ...update, updated_at: nowIso } : update)
    .eq("id", estimate.id)
    .eq("org_id", estimate.org_id)
    .not("status", "in", '("approved","client_signed","executed","converted_to_project")')
    .eq("is_current_version", true)
  // Two signers signing at once must not overwrite each other's signature.
  if (signers.length) guarded = guarded.eq("updated_at", estimate.updated_at)
  const { data: updatedRows, error: updateError } = await guarded.select("id")

  if (updateError) {
    throw new Error(`Failed to record decision: ${updateError.message}`)
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error(signers.length ? "This agreement just changed. Reload the page and try again." : "This estimate has already been signed.")
  }

  let builderSigningResult:
    | { documentId: string; envelopeId: string; signingRequestId: string; signingUrl: string; signerEmail: string }
    | null = null

  // Route the builder countersignature through the same unified e-sign backend
  // used by the Signatures workspace.
  if (input.decision === "approved" && !isBudget && !waitingOn.length) {
    try {
    builderSigningResult = await issueBuilderEstimateSigningEnvelope({
      supabase,
      orgId: estimate.org_id,
      estimateId: estimate.id,
      signatureData: update.signature_data as Record<string, any>,
    })
    } catch (deliveryError) {
      // The client signature is durable. Builder signing can be recovered from
      // Open builder signing, which idempotently creates the missing envelope.
      console.error("Estimate signed; builder signing delivery requires retry", { estimateId: estimate.id, deliveryError })
    }
  }

  try {
  await addComment(supabase, {
    orgId: estimate.org_id,
    estimateId: estimate.id,
    versionGroupId: estimate.version_group_id ?? null,
    authorType: "client",
    authorName: name,
    authorEmail: email,
    kind: DECISION_KIND[input.decision],
    body: input.note?.trim() || null,
    metadata: {
      ip: input.ip ?? null,
      builder_signing_document_id: builderSigningResult?.documentId ?? null,
      builder_signing_envelope_id: builderSigningResult?.envelopeId ?? null,
      builder_signing_request_id: builderSigningResult?.signingRequestId ?? null,
      builder_signer_email: builderSigningResult?.signerEmail ?? null,
    },
  })

  await recordEvent({
    orgId: estimate.org_id,
    eventType: input.decision === "approved" ? (isBudget ? "estimate_budget_approved" : waitingOn.length ? "estimate_signer_signed" : "estimate_client_signed") : `estimate_${input.decision}`,
    entityType: "estimate",
    entityId: estimate.id,
    payload: { title: estimate.title, decision: input.decision, by: name },
  })

  if (input.decision === "approved" && !waitingOn.length && normalizeEstimateCommercial(estimate.metadata).purpose === "construction_agreement" && (estimate as any).prospect_id) {
    await supabase
      .from("prospects")
      .update({ status: "client_approved", updated_at: nowIso })
      .eq("org_id", estimate.org_id)
      .eq("id", (estimate as any).prospect_id)
      .in("status", ["pricing", "estimate_sent", "changes_requested"])
  }

  // Reflect a change request on the prospect row so the pipeline no longer shows
  // "Estimate sent" once the client has come back with edits.
  if (input.decision === "changes_requested" && (estimate as any).prospect_id && normalizeEstimateCommercial(estimate.metadata).purpose !== "preconstruction_agreement") {
    await supabase
      .from("prospects")
      .update({ status: "changes_requested", updated_at: nowIso })
      .eq("org_id", estimate.org_id)
      .eq("id", (estimate as any).prospect_id)
      .in("status", ["pricing", "estimate_sent"])
  }

  // Notify the builder when the client requests changes or declines — parity with the
  // countersign nudge they receive on approval.
  if (input.decision === "changes_requested" || input.decision === "rejected") {
    await notifyBuilderOfClientResponse({
      supabase,
      orgId: estimate.org_id,
      estimate,
      decision: input.decision,
      clientName: name,
      note: input.note?.trim() || null,
    })
  }

  await recordAudit({
    orgId: estimate.org_id,
    action: "update",
    entityType: "estimate",
    entityId: estimate.id,
    after: { status: update.status ?? estimate.status, decided_by: name, decided_at: nowIso },
    source: "client_portal",
  })

  } catch (activityError) {
    console.error("Estimate decision saved; activity notification failed", { estimateId: estimate.id, activityError })
  }

  return { status: update.status ?? estimate.status, waitingOn: waitingOn.map((person) => person.name) }
}

export async function executeEstimateFromEnvelopeExecution(input: {
  orgId: string
  estimateId: string
  documentId: string
  envelopeId: string
  executedFileId: string
  signerName: string
  signerEmail: string
  signerIp?: string | null
  signatureImage?: string | null
  signatureText?: string | null
  consentText?: string | null
  signedAt?: string
}) {
  const supabase = createServiceSupabaseClient()

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, org_id, prospect_id, status, title, executed_at, signature_data, metadata, is_current_version, signature_document_id")
    .eq("org_id", input.orgId)
    .eq("id", input.estimateId)
    .maybeSingle()

  if (error || !estimate) {
    throw new Error(`Failed to load estimate for execution sync: ${error?.message ?? "missing"}`)
  }

  const nowIso = input.signedAt ?? estimate.executed_at ?? new Date().toISOString()
  if (estimate.status === "executed" && estimate.signature_document_id === input.documentId && estimate.metadata?.estimate_execution?.effects_completed === true) return estimate
  if (!["client_signed", "executed"].includes(estimate.status) || !estimate.is_current_version ||
      estimate.signature_document_id !== input.documentId || normalizeEstimateCommercial(estimate.metadata).purpose === "budget") {
    throw new Error("This signing request no longer belongs to the current construction agreement.")
  }

  const existingSignatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
  const existingMetadata = ((estimate as any).metadata as Record<string, any> | null) ?? {}
  const signatureData = {
    ...existingSignatureData,
    builder: {
      signer_name: input.signerName,
      signer_email: input.signerEmail,
      signed_at: nowIso,
      signer_ip: input.signerIp ?? null,
      signature_image: input.signatureImage ?? null,
      signature_text: input.signatureText ?? input.signerName,
      consent_text: input.consentText ?? null,
      source: "unified_esign",
      document_id: input.documentId,
      envelope_id: input.envelopeId,
    },
  }

  const metadata = {
    ...existingMetadata,
    estimate_execution: {
      ...(typeof existingMetadata.estimate_execution === "object" && existingMetadata.estimate_execution
        ? existingMetadata.estimate_execution
        : {}),
      countersigned_at: nowIso,
      executed_file_id: input.executedFileId,
      signature_document_id: input.documentId,
      envelope_id: input.envelopeId,
      source: "unified_esign",
    },
  }

  const { data: updated, error: updateError } = await supabase
    .from("estimates")
    .update({
      status: "executed",
      builder_signed_at: nowIso,
      executed_at: nowIso,
      executed_file_id: input.executedFileId,
      signature_document_id: input.documentId,
      signature_data: signatureData,
      metadata,
      updated_at: nowIso,
    })
    .eq("org_id", input.orgId)
    .eq("id", input.estimateId)
    .in("status", ["client_signed", "executed"])
    .eq("is_current_version", true)
    .select("*")
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark estimate executed: ${updateError?.message}`)
  }

  if ((estimate as any).prospect_id && normalizeEstimateCommercial(estimate.metadata).purpose === "construction_agreement") {
    const { error: prospectError } = await supabase
      .from("prospects")
      .update({ status: "executed", updated_at: nowIso })
      .eq("org_id", input.orgId)
      .eq("id", (estimate as any).prospect_id)
      .in("status", [
        "new",
        "contacted",
        "qualified",
        "pricing",
        "estimate_sent",
        "changes_requested",
        "client_approved",
      ])
    if (prospectError) throw new Error(`Could not synchronize executed estimate: ${prospectError.message}`)
  }

  await recordEvent({
    orgId: input.orgId,
    eventType: "estimate_executed",
    entityType: "estimate",
    entityId: input.estimateId,
    payload: {
      title: estimate.title,
      signer_name: input.signerName,
      signer_email: input.signerEmail,
      executed_file_id: input.executedFileId,
      signature_document_id: input.documentId,
      envelope_id: input.envelopeId,
      source: "unified_esign",
    },
  })

  await recordAudit({
    orgId: input.orgId,
    action: "update",
    entityType: "estimate",
    entityId: input.estimateId,
    before: { status: estimate.status, signature_data: existingSignatureData },
    after: updated,
    source: "unified_esign",
  })

  const { error: completionError } = await supabase.from("estimates")
    .update({ metadata: { ...metadata, estimate_execution: { ...metadata.estimate_execution, effects_completed: true } } })
    .eq("org_id", input.orgId).eq("id", input.estimateId)
  if (completionError) throw new Error(`Could not complete estimate execution effects: ${completionError.message}`)
  return updated
}

export async function submitEstimateBuilderSignatureBySigningToken(input: {
  token: string
  signerName: string
  signerEmail?: string | null
  signatureText?: string | null
  signatureImage?: string | null
  consentText: string
  signerIp?: string | null
}) {
  if (!input.token) throw new Error("Missing signing token")
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashSigningToken(input.token)
  const now = new Date()
  const nowIso = now.toISOString()

  const { data: resolvedRequest, error } = await resolveSigningRequestToken(supabase, input.token,
    `*, document:documents(id, org_id, project_id, prospect_id, title, document_type, source_file_id, executed_file_id, source_entity_type, source_entity_id, created_by, metadata)`)
  const signingRequest = resolvedRequest as any

  if (error || !signingRequest || !signingRequest.document) {
    throw new Error(`Signing request not found: ${error?.message ?? "Invalid link"}`)
  }
  await requireSigningAccess(signingRequest)
  const finishAccepted = async () => {
    try { return { ...(await finalizeEstimateBuilderSignature({ orgId: signingRequest.org_id, requestId: signingRequest.id })), processing: false } }
    catch { return { success: true, processing: true, estimate: null, executedFileId: null } }
  }
  if (signingRequest.status === "signed") return finishAccepted()
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) throw new Error("Signing link has expired")
  const signerName = input.signerName.trim()
  const signerEmail = input.signerEmail?.trim()
  if (!signerName) throw new Error("Signer name is required")
  if (!signerEmail) throw new Error("Signer email is required")
  const signatureImage = await validateSignaturePng(input.signatureImage)
  assertElectronicSignatureConsent(input.consentText)
  if (signerName.length > 300 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) throw new Error("Enter a valid signer name and email")

  if (signingRequest.status === "voided" || signingRequest.status === "expired") {
    throw new Error("Signing request is no longer valid")
  }
  if (signingRequest.used_count >= signingRequest.max_uses) {
    throw new Error("Signing link has already been used")
  }

  const document = signingRequest.document as any
  const estimateId =
    document.source_entity_type === "estimate"
      ? document.source_entity_id
      : (document.metadata?.estimate_id as string | undefined)
  if (!estimateId) {
    throw new Error("This signing request is not attached to an estimate.")
  }

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select(
      `*, items:estimate_items(*),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       recipient:contacts(full_name, email)`,
    )
    .eq("org_id", signingRequest.org_id)
    .eq("id", estimateId)
    .maybeSingle()

  if (estimateError || !estimate) {
    throw new Error(`Estimate not found: ${estimateError?.message ?? "missing"}`)
  }
  if (estimate.status === "executed" || estimate.executed_at) {
    throw new Error("This estimate is already executed.")
  }
  if (estimate.status !== "client_signed" || !estimate.is_current_version || normalizeEstimateCommercial(estimate.metadata).purpose === "budget") {
    throw new Error("Builder signing is only available after the client signs.")
  }

  const envelopeId = signingRequest.envelope_id ?? signingRequest.group_id ?? signingRequest.id
  const signerRole = signingRequest.signer_role ?? "builder"
  const { data: sourceFile, error: sourceError } = await supabase.from("files").select("storage_path")
    .eq("org_id", signingRequest.org_id).eq("id", document.source_file_id).single()
  if (sourceError || !sourceFile) throw new Error("Issued agreement source is unavailable")
  const sourceBytes = await downloadFilesObject({ supabase, orgId: signingRequest.org_id,
    path: document.metadata?.esign_source?.storage_path ?? sourceFile.storage_path })
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex")
  if (document.metadata?.esign_source?.sha256 && document.metadata.esign_source.sha256 !== sourceHash) throw new Error("Issued agreement source changed")
  await generateExecutedPdf({ pdfBytes: sourceBytes, fields: [], values: {}, auditTrail: [
    { label: "Builder", value: signerName }, { label: "Email", value: signerEmail }, { label: "Consent", value: input.consentText },
  ] })
  const { error: insertError } = await supabase.rpc("record_document_signature_atomic", {
    p_user_agent: null,
    p_signed_at: nowIso,
    p_org_id: signingRequest.org_id,
    p_signing_request_id: signingRequest.id,
    p_document_id: signingRequest.document_id,
    p_revision: signingRequest.revision,
    p_signer_name: signerName,
    p_signer_email: signerEmail,
    p_signer_ip: input.signerIp ?? null,
    p_consent_text: input.consentText.trim(),
    p_values: {
      estimate_builder_name: signerName,
      estimate_builder_email: signerEmail,
      estimate_builder_signature: signatureImage,
      estimate_builder_signed_at: nowIso,
    },
    p_audit_data: {
      consent_version: "esign-consent-2026-05-24",
      consent_accepted_at: nowIso,
      signed_at: nowIso,
      signer_role: signerRole,
      signer_email_on_request: signingRequest.sent_to_email ?? null,
      submitted_signer_email: signerEmail,
      ip_address: input.signerIp ?? null,
      token_hash_prefix: tokenHash.slice(0, 16),
      document_id: signingRequest.document_id,
      document_revision: signingRequest.revision,
      envelope_id: envelopeId,
      estimate_id: estimateId,
      source: "estimate_native_builder_signing",
    },
  })

  if (insertError) {
    throw new Error(`Failed to record signature: ${insertError.message}`)
  }

  return finishAccepted()
}

/** Resume only from durable signature evidence, never from retried browser input. */
export async function finalizeEstimateBuilderSignature(input: { orgId: string; requestId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: request, error: requestError } = await supabase.from("document_signing_requests")
    .select("*, document:documents(*)").eq("org_id", input.orgId).eq("id", input.requestId).single()
  if (requestError || !request || request.status !== "signed") throw new Error("Recorded estimate signature not found")
  const { data: signature, error: signatureError } = await supabase.from("document_signatures")
    .select("*").eq("org_id", input.orgId).eq("signing_request_id", request.id).single()
  if (signatureError || !signature || signature.audit_data?.source !== "estimate_native_builder_signing") {
    throw new Error("Estimate signature evidence not found")
  }
  const document = request.document as any
  const estimateId = document.source_entity_type === "estimate" ? document.source_entity_id : document.metadata?.estimate_id
  const { data: estimate, error: estimateError } = await supabase.from("estimates")
    .select("*, items:estimate_items(*), project:projects(name), prospect:prospects(name, prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)")
    .eq("org_id", input.orgId).eq("id", estimateId).single()
  if (estimateError || !estimate) throw new Error("Estimate for recorded signature not found")
  if (estimate.signature_document_id !== document.id || !estimate.is_current_version || !["client_signed", "executed"].includes(estimate.status)) {
    throw new Error("Recorded signature no longer belongs to the current agreement")
  }
  const signedAt = signature.created_at
  const signatureData = { ...(estimate.signature_data ?? {}),
    client: document.metadata?.estimate_signature_data?.client ?? estimate.signature_data?.client ?? {}, builder: {
    signature_id: signature.id, user_agent: signature.user_agent, consent_version: signature.audit_data?.consent_version,
    signer_name: signature.signer_name, signer_email: signature.signer_email,
    signer_ip: signature.signer_ip, signature_image: signature.values?.estimate_builder_signature,
    signature_text: signature.signer_name, consent_text: signature.consent_text, consent_accepted: true,
    signed_at: signedAt, source: "estimate_builder_portal", document_id: document.id, envelope_id: request.envelope_id,
  } }
  let executedFileId = document.executed_file_id as string | null
  if (!executedFileId) {
    const leaseToken = randomUUID()
    const { data: execution, error: claimError } = await supabase.rpc("claim_esign_execution", {
      p_org_id: input.orgId, p_envelope_id: request.envelope_id, p_lease_token: leaseToken,
    })
    if (claimError || !execution) throw new Error(claimError?.message ?? "Estimate execution is not ready")
    const { data: sourceFile, error: sourceError } = await supabase.from("files").select("storage_path")
      .eq("org_id", input.orgId).eq("id", document.source_file_id).single()
    if (sourceError || !sourceFile) throw new Error("Issued estimate source is unavailable")
    const artifact = await generateExecutedEstimateArtifact({ supabase, orgId: input.orgId,
      userId: request.created_by ?? document.created_by ?? null, estimate, signatureData,
      execution: { envelopeId: request.envelope_id, documentId: document.id, revision: request.revision, fileId: execution.file_id, leaseToken,
        sourcePath: document.metadata?.esign_source?.storage_path ?? sourceFile.storage_path,
        sourceHash: document.metadata?.esign_source?.sha256 } })
    if (!("fileId" in artifact)) throw new Error(artifact.skippedReason)
    executedFileId = artifact.fileId
  }
  const updated = await executeEstimateFromEnvelopeExecution({ orgId: input.orgId, estimateId,
    documentId: document.id, envelopeId: request.envelope_id, executedFileId,
    signerName: signature.signer_name, signerEmail: signature.signer_email,
    signerIp: signature.signer_ip, signatureImage: signature.values?.estimate_builder_signature,
    consentText: signature.consent_text, signedAt })
  return { success: true, estimate: updated, executedFileId }
}

/** Client posts a comment from the portal (e.g. alongside a "request changes"). */
export async function addClientEstimateComment(input: {
  token: string
  name?: string | null
  email?: string | null
  body: string
  /** The document section the client is asking about. */
  section?: string | null
}) {
  const body = z.string().trim().min(1, "Comment cannot be empty.").max(4000).parse(input.body)
  const section = proposalSectionKeySchema.nullable().catch(null).parse(input.section ?? null)

  const supabase = createServiceSupabaseClient()
  const link = await reviewLinkForToken(supabase, hashToken(input.token))

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, org_id, version_group_id, is_current_version, metadata, prospect:prospects(prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)")
    .eq("id", link.estimateId)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) throw new Error("This estimate link is no longer valid.")

  // The link belongs to a known person; a typed name only stands in when it does not say.
  const recipient = link.signer ?? estimateProposal(estimate.metadata)?.signers[0] ?? resolveEstimateRecipient(estimate)
  const name = recipient.name?.trim() || input.name?.trim()
  if (!name) throw new Error("Please enter your name.")

  await addComment(supabase, {
    orgId: estimate.org_id,
    estimateId: estimate.id,
    versionGroupId: estimate.version_group_id ?? null,
    authorType: "client",
    authorName: name,
    authorEmail: recipient.email?.trim() || input.email?.trim() || null,
    kind: "comment",
    body,
    metadata: section ? { section } : {},
  })

  await recordEvent({
    orgId: estimate.org_id,
    eventType: "estimate_comment_added",
    entityType: "estimate",
    entityId: estimate.id,
    payload: { author_type: "client" },
  })
}

// ---------------------------------------------------------------------------
// Takeoff evidence ("show me on the plans")
// ---------------------------------------------------------------------------

/**
 * The geometry behind one estimate line, for the client portal.
 *
 * This is the transparency play: a client taps a line and sees the exact plan
 * regions the number was measured from. Three things keep it safe:
 *
 *   1. The token resolves the estimate. A token from another org resolves to a
 *      different estimate (or nothing), so it can never reach this one's plans.
 *   2. The condition must actually be referenced by a line ON THIS ESTIMATE.
 *   3. The builder must have marked the CONDITION client-visible. Per-markup
 *      share flags are irrelevant here — the condition setting is the switch,
 *      so turning one off hides it everywhere at once.
 *
 * Only the condition's own geometry is returned. Other markups on the same
 * sheet — internal notes, other trades' measurements — never leave the server.
 */
export type TakeoffEvidenceSheet = {
  drawing_sheet_id: string
  sheet_number: string
  sheet_title: string | null
  image_url: string | null
  image_width: number | null
  image_height: number | null
  /** Geometry in normalized sheet coordinates, ready for the overlay. */
  shapes: Array<{
    id: string
    type: string
    points: Array<[number, number]>
    quantity: number | null
    /**
     * This area SUBTRACTS — a window out of a wall, a stairwell out of a slab.
     * Carried explicitly rather than inferred from a negative quantity, because
     * an area on an uncalibrated sheet has no quantity at all and would
     * otherwise render to a client as though it were being added.
     */
    deduction: boolean
  }>
}

export type TakeoffEvidence = {
  condition_id: string
  condition_name: string
  color: string
  uom: string
  total_quantity: number
  sheets: TakeoffEvidenceSheet[]
}

/** Sheets shown per line. Beyond this the client is scrolling, not verifying. */
const TAKEOFF_EVIDENCE_SHEET_CAP = 12

export async function loadTakeoffEvidenceByToken(
  token: string,
  conditionId: string,
): Promise<TakeoffEvidence | null> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)

  const { data: estimate } = await supabase
    .from("estimates")
    .select("id, org_id, items:estimate_items(id, metadata)")
    .eq("id", await estimateIdForReviewToken(supabase, tokenHash))
    .maybeSingle()

  if (!estimate) return null

  const referenced = ((estimate as any).items ?? []).some(
    (item: any) => item?.metadata?.takeoff?.condition_id === conditionId,
  )
  if (!referenced) return null

  const { data: condition } = await supabase
    .from("takeoff_conditions")
    .select("id, name, color, uom, waste_pct, share_with_clients, project_id")
    .eq("org_id", estimate.org_id)
    .eq("id", conditionId)
    .maybeSingle()

  if (!condition || condition.share_with_clients !== true) return null

  const { data: markups } = await supabase
    .from("drawing_markups")
    .select(
      "id, data, quantity, sheet_version_id, drawing_sheet_id, drawing_sheets!inner(id, sheet_number, sheet_title, project_id, current_revision_id)",
    )
    .eq("org_id", estimate.org_id)
    .eq("condition_id", conditionId)
    .eq("is_private", false)
    .limit(2000)

  if (!markups || markups.length === 0) return null

  // Only the current revision: a client must never be shown geometry measured
  // against a superseded sheet as if it were today's plan.
  const versionIds = Array.from(
    new Set(markups.map((row: any) => row.sheet_version_id).filter(Boolean)),
  ) as string[]

  const { data: versions } = versionIds.length
    ? await supabase
        .from("drawing_sheet_versions")
        .select("id, drawing_sheet_id, drawing_revision_id, full_path, full_url, image_width, image_height")
        .eq("org_id", estimate.org_id)
        .in("id", versionIds)
    : { data: [] as any[] }

  const versionById = new Map((versions ?? []).map((v: any) => [v.id as string, v]))
  const bySheet = new Map<string, TakeoffEvidenceSheet>()
  let total = 0

  for (const row of markups as any[]) {
    const sheet = row.drawing_sheets
    const version = row.sheet_version_id ? versionById.get(row.sheet_version_id) : null
    if (version && version.drawing_revision_id !== sheet?.current_revision_id) continue

    const points = Array.isArray(row.data?.points) ? row.data.points : []
    if (points.length === 0) continue

    const quantity = row.quantity === null || row.quantity === undefined ? null : Number(row.quantity)
    total += quantity ?? 0

    const existing = bySheet.get(row.drawing_sheet_id)
    const shape = {
      id: row.id as string,
      type: String(row.data?.type ?? ""),
      points,
      quantity,
      deduction: isDeductionGeometry({ type: String(row.data?.type ?? ""), points, style: row.data?.style ?? null }),
    }
    if (existing) {
      existing.shapes.push(shape)
    } else {
      bySheet.set(row.drawing_sheet_id, {
        drawing_sheet_id: row.drawing_sheet_id,
        sheet_number: sheet?.sheet_number ?? "—",
        sheet_title: sheet?.sheet_title ?? null,
        image_url: buildDrawingsImageUrl(version?.full_path) ?? version?.full_url ?? null,
        image_width: version?.image_width ?? null,
        image_height: version?.image_height ?? null,
        shapes: [shape],
      })
    }
  }

  if (bySheet.size === 0) return null

  const wasted = total * (1 + Number(condition.waste_pct ?? 0) / 100)

  return {
    condition_id: condition.id as string,
    condition_name: condition.name as string,
    color: condition.color as string,
    uom: condition.uom as string,
    total_quantity: Math.round(wasted * 100) / 100,
    sheets: Array.from(bySheet.values()).slice(0, TAKEOFF_EVIDENCE_SHEET_CAP),
  }
}
