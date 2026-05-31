import { createHmac, randomBytes } from "crypto"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { EstimateEmail } from "@/lib/emails/estimate-email"
import { SignatureEmail } from "@/lib/emails/signature-email"
import { ENVELOPE_EVENT_TYPES, buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { renderEstimatePdf } from "@/lib/pdfs/estimate"
import { generateExecutedPdf, type ESignAuditTrailItem } from "@/lib/pdfs/esign"
import { recordESignEvent } from "@/lib/services/esign-events"
import { buildOrgScopedPath, downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { formatLocalDate } from "@/lib/utils"

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
 * Rotating the token invalidates any previously shared link.
 */
export async function getEstimateShareLink({ estimateId, orgId }: { estimateId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { token, tokenHash } = mintToken()

  const { data, error } = await supabase
    .from("estimates")
    .update({ token_hash: tokenHash })
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to generate review link: ${error?.message ?? "estimate not found"}`)
  }

  return { token, url: `${appUrl()}/e/${token}` }
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
      "id, org_id, prospect_id, title, status, total_cents, valid_until, version_group_id, recipient_contact_id, metadata, project:projects(name), prospect:prospects(name, prospect_contacts(full_name, email, is_primary)), recipient:contacts(full_name, email)",
    )
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (error || !estimate) {
    throw new Error(`Estimate not found: ${error?.message ?? "missing"}`)
  }

  const recipient = resolveEstimateRecipient(estimate)
  const recipientEmail = recipient.email?.trim()
  if (!recipientEmail) {
    throw new Error("Add a client contact with an email address before sending this estimate.")
  }

  const { token, tokenHash } = mintToken()
  const reviewUrl = `${appUrl()}/e/${token}`

  const { error: updateError } = await supabase
    .from("estimates")
    .update({ token_hash: tokenHash, status: "sent", sent_at: new Date().toISOString() })
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)

  if (updateError) {
    throw new Error(`Failed to mark estimate as sent: ${updateError.message}`)
  }

  const branding = await getOrgBranding(resolvedOrgId, supabase)
  const html = await renderEmailTemplate(
    EstimateEmail({
      estimateTitle: estimate.title,
      reviewLink: reviewUrl,
      orgName: branding.name,
      orgLogoUrl: branding.logoUrl,
      recipientName: recipient.name ?? null,
      projectName: (estimate as any).project?.name ?? (estimate as any).prospect?.name ?? null,
      totalLabel: formatMoney(estimate.total_cents),
      validUntil: estimate.valid_until
        ? formatLocalDate(estimate.valid_until, "MMMM d, yyyy")
        : null,
      message: message ?? null,
    }),
  )

  const emailSent = await sendEmail({
    to: [recipientEmail],
    subject: `${branding.name ?? "Your builder"} sent you an estimate: ${estimate.title}`,
    html,
    from: getOrgSenderEmail(branding.slug, branding.name),
  })

  await addComment(supabase, {
    orgId: resolvedOrgId,
    estimateId,
    versionGroupId: (estimate as any).version_group_id ?? null,
    authorType: "builder",
    authorUserId: userId,
    authorName: await resolveActorName(supabase, userId),
    kind: "sent",
    body: message ?? null,
    metadata: { recipient_email: recipientEmail, email_sent: emailSent },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_sent",
    entityType: "estimate",
    entityId: estimateId,
    payload: { title: estimate.title, recipient_email: recipientEmail, email_sent: emailSent },
  })

  if ((estimate as any).prospect_id) {
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
}

export async function listEstimateComments(estimateId: string, orgId?: string): Promise<EstimateCommentDto[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("estimate_comments")
    .select("id, author_type, author_name, author_email, kind, body, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("estimate_id", estimateId)
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to list estimate comments", error.message)
    return []
  }
  return (data ?? []) as EstimateCommentDto[]
}

// ---------------------------------------------------------------------------
// Public portal actions (token-based, service client)
// ---------------------------------------------------------------------------

export type EstimatePortalData = {
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
  responded_at: string | null
  decision_note: string | null
  client_signed_at: string | null
  builder_signed_at: string | null
  executed_at: string | null
  executed_file_id: string | null
  signature_document_id: string | null
  signature_data: Record<string, any> | null
  is_current_version: boolean
  items: EstimatePortalLine[]
  comments: EstimateCommentDto[]
}

export type EstimatePortalLine = {
  id: string
  item_type: string
  description: string
  quantity: number | null
  unit: string | null
  unit_cost_cents: number | null
  markup_pct: number | null
  notes: string | null
}

function mapEstimatePortalData(estimate: any, comments: EstimateCommentDto[]): EstimatePortalData {
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
      notes: typeof it.metadata?.notes === "string" ? it.metadata.notes : null,
    }))

  return {
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
    terms: typeof metadata.terms === "string" ? metadata.terms : null,
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

/** Loads an estimate for the public portal by raw token, stamping first-view time. */
export async function loadEstimateByToken(token: string): Promise<EstimatePortalData | null> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(token)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `id, org_id, title, status, version, total_cents, subtotal_cents, tax_cents, valid_until, created_at, metadata,
       responded_at, decision_note, is_current_version, client_signed_at, builder_signed_at, executed_at,
       executed_file_id, signature_document_id, signature_data,
       items:estimate_items(id, item_type, description, quantity, unit, unit_cost_cents, markup_pct, sort_order, metadata),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       org:orgs(name, logo_url),
       recipient:contacts(full_name, email)`,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) {
    throw new Error(`Database error: ${error.message}`)
  }
  if (!estimate) return null

  if (estimate.status === "sent") {
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

  const { data: comments } = await supabase
    .from("estimate_comments")
    .select("id, author_type, author_name, author_email, kind, body, created_at")
    .eq("org_id", estimate.org_id)
    .eq("estimate_id", estimate.id)
    .order("created_at", { ascending: true })

  return mapEstimatePortalData(estimate, (comments ?? []) as EstimateCommentDto[])
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
      `id, org_id, title, status, version, total_cents, subtotal_cents, tax_cents, valid_until, created_at, metadata,
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

  const { data: comments } = await supabase
    .from("estimate_comments")
    .select("id, author_type, author_name, author_email, kind, body, created_at")
    .eq("org_id", estimate.org_id)
    .eq("estimate_id", estimate.id)
    .order("created_at", { ascending: true })

  return mapEstimatePortalData(estimate, (comments ?? []) as EstimateCommentDto[])
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
      `id, org_id, title, status, metadata, subtotal_cents, tax_cents, total_cents, valid_until,
       executed_file_id,
       client_signed_at, builder_signed_at, executed_at, signature_data,
       items:estimate_items(*),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       recipient:contacts(full_name, email)`,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) return null

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

  const branding = await getOrgBranding(estimate.org_id, supabase)
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
          {
            role: "Client",
            name: clientSigner.signer_name ?? pdfRecipient.name ?? null,
            signedAt: clientSigner.signed_at ?? (estimate as any).client_signed_at ?? null,
            signatureImage: clientSigner.signature_image ?? null,
          },
          {
            role: branding.name ?? "Builder",
            name: builderSigner.signer_name ?? null,
            signedAt: builderSigner.signed_at ?? (estimate as any).builder_signed_at ?? null,
            signatureImage: builderSigner.signature_image ?? null,
          },
        ]
      : undefined

  const pdf = await renderEstimatePdf({
    orgName: branding.name ?? undefined,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    estimateTitle: estimate.title,
    recipientName: pdfRecipient.name ?? undefined,
    recipientEmail: pdfRecipient.email ?? null,
    projectName: (estimate as any).project?.name ?? (estimate as any).prospect?.name ?? null,
    summary: typeof metadata.summary === "string" ? metadata.summary : null,
    terms: typeof metadata.terms === "string" ? metadata.terms : null,
    subtotalCents: estimate.subtotal_cents,
    taxCents: estimate.tax_cents,
    totalCents: estimate.total_cents,
    validUntil: estimate.valid_until,
    documentLabel: signers ? ((estimate as any).executed_at ? "Executed Estimate" : "Client-Signed Estimate") : undefined,
    signers,
    lines: items,
  })

  return { pdf, fileName: `estimate-${estimate.id}.pdf` }
}

function estimateLinesToQuoteLines(lines: any[]) {
  return [...(lines ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((line) => ({
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
}: {
  supabase: ServiceClient
  orgId: string
  userId: string | null
  estimate: any
  signatureData: Record<string, any>
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

    const basePdf = await renderEstimatePdf({
      orgName: branding.name ?? undefined,
      orgLogoUrl: branding.logoUrl,
      orgAddress: branding.address,
      documentLabel: "Executed Estimate",
      estimateTitle: estimate.title,
      recipientName: executedRecipient.name ?? clientSigner.signer_name ?? undefined,
      recipientEmail: executedRecipient.email ?? clientSigner.signer_email ?? null,
      projectName: estimate.project?.name ?? estimate.prospect?.name ?? null,
      summary: typeof metadata.summary === "string" ? metadata.summary : null,
      terms: typeof metadata.terms === "string" ? metadata.terms : branding.estimateTermsTemplate,
      subtotalCents: estimate.subtotal_cents,
      taxCents: estimate.tax_cents,
      totalCents: estimate.total_cents,
      validUntil: estimate.valid_until,
      signers: [
        {
          role: "Client",
          name: clientSigner.signer_name ?? estimate.recipient?.full_name ?? null,
          signedAt: clientSigner.signed_at ?? estimate.client_signed_at ?? null,
          signatureImage: clientSigner.signature_image ?? null,
        },
        {
          role: branding.name ?? "Builder",
          name: builderSigner.signer_name ?? null,
          signedAt: builderSigner.signed_at ?? estimate.builder_signed_at ?? null,
          signatureImage: builderSigner.signature_image ?? null,
        },
      ],
      lines: estimateLinesToQuoteLines(estimate.items ?? []),
    })

    // Append the e-sign certificate page (audit trail) so the executed estimate
    // carries the same evidence as documents run through the signing engine.
    // Best-effort: if certificate generation fails, fall back to the base PDF so
    // execution still produces a valid (cert-less) executed file.
    let pdf = basePdf
    try {
      pdf = Buffer.from(
        await generateExecutedPdf({
          pdfBytes: basePdf,
          fields: [],
          values: {},
          auditTrail: buildEstimateAuditTrail(estimate, signatureData),
        }),
      )
    } catch (certError) {
      console.error(
        `[generateExecutedEstimateArtifact] Failed to append signature certificate for estimate ${estimate.id}; using base PDF:`,
        certError,
      )
    }

    const storagePath = buildOrgScopedPath(
      orgId,
      contextType,
      contextId,
      "executed-estimates",
      `${Date.now()}_${fileName}`,
    )

    await uploadFilesObject({
      supabase,
      orgId,
      path: storagePath,
      bytes: pdf,
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
        size_bytes: pdf.length,
        visibility: "private",
        category: "contracts",
        folder_path: "Contracts",
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
}) {
  const html = await renderEmailTemplate(
    SignatureEmail({
      documentTitle: input.estimate.title,
      signingLink: input.signingUrl,
      recipientName: input.signerName,
      orgName: input.branding.name ?? null,
      orgLogoUrl: input.branding.logoUrl ?? null,
      eventLabel: "Estimate Countersignature",
      headline: "Client signed estimate",
      bodyText: `${input.estimate.title} has been signed by the client and is ready for your countersignature.`,
      detailLabel: "Next Action",
      detailText: "Review the client-signed estimate and sign electronically to fully execute it.",
      buttonText: "Review and Sign",
      previewText: `Countersign estimate: ${input.estimate.title}`,
    }),
  )

  return sendEmail({
    to: [input.signerEmail],
    subject: `Countersign estimate: ${input.estimate.title}`,
    html,
    from: getOrgSenderEmail(input.branding.slug, input.branding.name),
  })
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

      const signingToken = randomBytes(32).toString("hex")
      const signingUrl = buildUnifiedSigningUrl(signingToken)
      const nowIso = new Date().toISOString()
      const { error: refreshError } = await supabase
        .from("document_signing_requests")
        .update({
          token_hash: hashSigningToken(signingToken),
          status: existingRequest.status === "draft" ? "sent" : existingRequest.status,
          sent_at: nowIso,
        })
        .eq("org_id", orgId)
        .eq("id", existingRequest.id)

      if (refreshError) {
        throw new Error(`Failed to refresh builder signing request: ${refreshError.message}`)
      }

      const signerEmail = String(existingRequest.sent_to_email)
      const signerName = existingRecipient?.name?.trim() || existingRecipient?.email?.trim() || signerEmail
      const emailSent = await sendBuilderEstimateSigningEmail({
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

  const sourcePdf = await renderEstimatePdf({
    orgName: branding.name ?? undefined,
    orgLogoUrl: branding.logoUrl,
    orgAddress: branding.address,
    documentLabel: "Client-Signed Estimate",
    estimateTitle: estimate.title,
    recipientName: estimate.recipient?.full_name ?? clientSigner.signer_name ?? undefined,
    recipientEmail: estimate.recipient?.email ?? clientSigner.signer_email ?? null,
    projectName: estimate.project?.name ?? estimate.prospect?.name ?? null,
    summary: typeof metadata.summary === "string" ? metadata.summary : null,
    terms: typeof metadata.terms === "string" ? metadata.terms : branding.estimateTermsTemplate,
    subtotalCents: estimate.subtotal_cents,
    taxCents: estimate.tax_cents,
    totalCents: estimate.total_cents,
    validUntil: estimate.valid_until,
    signers: [
      {
        role: "Client",
        name: clientSigner.signer_name ?? estimate.recipient?.full_name ?? null,
        signedAt: clientSigner.signed_at ?? estimate.client_signed_at ?? null,
        signatureImage: clientSigner.signature_image ?? null,
      },
      { role: branding.name ?? "Builder", name: signer.name },
    ],
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
      folder_path: "Contracts",
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

export async function countersignEstimate({
  estimateId,
  signerName,
  orgId,
}: {
  estimateId: string
  signerName?: string | null
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      `*, items:estimate_items(*),
       project:projects(name),
       prospect:prospects(name, prospect_contacts(full_name, email, is_primary)),
       recipient:contacts(full_name, email)`,
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", estimateId)
    .maybeSingle()

  if (error || !estimate) {
    throw new Error("Estimate not found")
  }

  if (estimate.executed_at || estimate.status === "executed") {
    throw new Error("This estimate is already executed.")
  }

  if (!estimate.client_signed_at && estimate.status !== "client_signed") {
    throw new Error("Client signature is required before builder countersignature.")
  }

  const actorName = signerName?.trim() || (await resolveActorName(supabase, userId)) || "Builder"
  const nowIso = new Date().toISOString()
  const signatureData = {
    ...(((estimate as any).signature_data as Record<string, any> | null) ?? {}),
    builder: {
      signer_name: actorName,
      signed_at: nowIso,
      source: "builder_countersign",
      user_id: userId,
    },
  }

  const artifact = await generateExecutedEstimateArtifact({
    supabase,
    orgId: resolvedOrgId,
    userId,
    estimate,
    signatureData,
  })

  const metadata = {
    ...(((estimate as any).metadata as Record<string, any> | null) ?? {}),
    estimate_execution: {
      countersigned_at: nowIso,
      artifact_skipped_reason: "skippedReason" in artifact ? artifact.skippedReason : null,
    },
  }

  const update: Record<string, any> = {
    status: "executed",
    builder_signed_at: nowIso,
    executed_at: nowIso,
    signature_data: signatureData,
    metadata,
    updated_at: nowIso,
  }

  if ("fileId" in artifact) {
    update.executed_file_id = artifact.fileId
    update.signature_document_id = artifact.documentId
  }

  const { data: updated, error: updateError } = await supabase
    .from("estimates")
    .update(update)
    .eq("org_id", resolvedOrgId)
    .eq("id", estimateId)
    .select("*")
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to countersign estimate: ${updateError?.message}`)
  }

  if ((estimate as any).prospect_id) {
    await supabase
      .from("prospects")
      .update({ status: "executed", updated_at: nowIso })
      .eq("org_id", resolvedOrgId)
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
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_executed",
    entityType: "estimate",
    entityId: estimateId,
    payload: {
      title: estimate.title,
      signer_name: actorName,
      executed_file_id: "fileId" in artifact ? artifact.fileId : null,
      signature_document_id: "fileId" in artifact ? artifact.documentId : null,
      artifact_skipped_reason: "skippedReason" in artifact ? artifact.skippedReason : null,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "estimate",
    entityId: estimateId,
    before: { status: estimate.status, signature_data: estimate.signature_data },
    after: updated,
  })

  return {
    estimate: updated,
    executedFileId: "fileId" in artifact ? artifact.fileId : null,
    signatureDocumentId: "fileId" in artifact ? artifact.documentId : null,
    artifactSkippedReason: "skippedReason" in artifact ? artifact.skippedReason : null,
  }
}

export async function getEstimateBuilderSigningLink({
  estimateId,
  orgId,
}: {
  estimateId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select("id, org_id, title, status, client_signed_at, signature_data, signature_document_id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", estimateId)
    .maybeSingle()

  if (estimateError || !estimate) {
    throw new Error(`Estimate not found: ${estimateError?.message ?? "missing"}`)
  }
  if (estimate.status !== "client_signed") {
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

  const token = randomBytes(32).toString("hex")
  const nowIso = new Date().toISOString()
  const { error: updateError } = await supabase
    .from("document_signing_requests")
    .update({
      token_hash: hashSigningToken(token),
      status: request.status === "draft" ? "sent" : request.status,
      sent_at: nowIso,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", request.id)

  if (updateError) {
    throw new Error(`Failed to issue builder signing link: ${updateError.message}`)
  }

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
      estimate,
      branding,
      signerName,
      signerEmail,
      signingUrl: buildUnifiedSigningUrl(token),
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
    url: buildUnifiedSigningUrl(token),
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
 * client requests changes or declines from the portal. Creates an in-app notification
 * and queues the matching email — mirroring the countersign nudge the builder gets when
 * a client approves. Best-effort: a notification failure never blocks the client decision.
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
  if (!builderUserId) return

  const isChanges = decision === "changes_requested"
  const action = isChanges ? "requested changes to" : "declined"
  const title = isChanges ? `Changes requested: ${estimate.title}` : `Estimate declined: ${estimate.title}`
  const message = note
    ? `${clientName} ${action} "${estimate.title}":\n${note}`
    : `${clientName} ${action} "${estimate.title}".`

  try {
    await new NotificationService().createAndQueue({
      orgId,
      userId: builderUserId,
      type: isChanges ? "estimate_changes_requested" : "estimate_declined",
      title,
      message,
      entityType: "estimate",
      entityId: estimate.id,
      metadata: { prospect_id: estimate.prospect_id ?? null, decision, client_name: clientName },
    })
  } catch (error) {
    console.error("[estimate-portal] Failed to notify builder of client response:", error)
  }
}

/** Client submits a decision (approve / reject / request changes) from the portal. No e-signature. */
export async function submitEstimateDecision(input: {
  token: string
  decision: EstimateDecision
  note?: string | null
  signature?: EstimateSignatureInput | null
  ip?: string | null
}): Promise<{ status: string }> {
  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(input.token)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      "id, org_id, prospect_id, title, status, valid_until, version_group_id, is_current_version, signature_data, created_by, recipient:contacts(full_name, email), prospect:prospects(name, owner_user_id)",
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) throw new Error("This estimate link is no longer valid.")

  // The link is sent to a known contact, so attribute the decision to them.
  const recipient = (estimate as any).recipient as { full_name?: string; email?: string } | null
  const name = recipient?.full_name?.trim() || "Client"
  const email = recipient?.email?.trim() || null

  if (!estimate.is_current_version) {
    throw new Error("A newer version of this estimate is available. Please use the latest link.")
  }
  if (["client_signed", "executed", "converted_to_project"].includes(estimate.status)) {
    throw new Error("This estimate has already been signed.")
  }
  if (estimate.valid_until && new Date(estimate.valid_until) < new Date()) {
    throw new Error("This estimate has expired. Please contact your builder for an updated copy.")
  }

  const nowIso = new Date().toISOString()
  const existingSignatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
  const update: Record<string, any> = {
    status: input.decision === "approved" ? "client_signed" : input.decision,
    responded_at: nowIso,
    decision_note: input.note?.trim() || null,
    client_decision_name: name,
    client_decision_email: email,
  }
  if (input.decision === "approved") {
    const signature = input.signature
    const signerName = signature?.signer_name?.trim()
    if (!signature?.consent_accepted || !signerName) {
      throw new Error("Please sign and accept the estimate before approving.")
    }
    update.approved_at = nowIso
    update.client_signed_at = nowIso
    update.signature_data = {
      ...existingSignatureData,
      client: {
        signer_name: signerName,
        signer_email: signature.signer_email?.trim() || email,
        signature_text: signature.signature_text?.trim() || signerName,
        signature_image: signature.signature_image || null,
        consent_accepted: true,
        signed_at: nowIso,
        signer_ip: input.ip ?? null,
        source: "estimate_portal",
      },
    }
  }

  const { error: updateError } = await supabase
    .from("estimates")
    .update(update)
    .eq("id", estimate.id)
    .eq("org_id", estimate.org_id)

  if (updateError) {
    throw new Error(`Failed to record decision: ${updateError.message}`)
  }

  let builderSigningResult:
    | { documentId: string; envelopeId: string; signingRequestId: string; signingUrl: string; signerEmail: string }
    | null = null

  // Route the builder countersignature through the same unified e-sign backend
  // used by the Signatures workspace.
  if (input.decision === "approved") {
    builderSigningResult = await issueBuilderEstimateSigningEnvelope({
      supabase,
      orgId: estimate.org_id,
      estimateId: estimate.id,
      signatureData: update.signature_data as Record<string, any>,
    })
  }

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
    eventType: input.decision === "approved" ? "estimate_client_signed" : `estimate_${input.decision}`,
    entityType: "estimate",
    entityId: estimate.id,
    payload: { title: estimate.title, decision: input.decision, by: name },
  })

  if (input.decision === "approved" && (estimate as any).prospect_id) {
    await supabase
      .from("prospects")
      .update({ status: "client_approved", updated_at: nowIso })
      .eq("org_id", estimate.org_id)
      .eq("id", (estimate as any).prospect_id)
      .in("status", ["pricing", "estimate_sent", "changes_requested"])
  }

  // Reflect a change request on the prospect row so the pipeline no longer shows
  // "Estimate sent" once the client has come back with edits.
  if (input.decision === "changes_requested" && (estimate as any).prospect_id) {
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
    after: { status: update.status, decided_by: name, decided_at: nowIso },
    source: "client_portal",
  })

  return { status: update.status }
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
}) {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, org_id, prospect_id, status, title, signature_data, metadata")
    .eq("org_id", input.orgId)
    .eq("id", input.estimateId)
    .maybeSingle()

  if (error || !estimate) {
    throw new Error(`Failed to load estimate for execution sync: ${error?.message ?? "missing"}`)
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
    .select("*")
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark estimate executed: ${updateError?.message}`)
  }

  if ((estimate as any).prospect_id) {
    await supabase
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
  const signerName = input.signerName.trim()
  const signerEmail = input.signerEmail?.trim()
  if (!signerName) throw new Error("Signer name is required")
  if (!signerEmail) throw new Error("Signer email is required")
  if (!input.signatureImage) throw new Error("Signature is required")
  if (!input.consentText?.trim()) throw new Error("Consent text is required")

  const supabase = createServiceSupabaseClient()
  const tokenHash = hashSigningToken(input.token)
  const now = new Date()
  const nowIso = now.toISOString()

  const { data: signingRequest, error } = await supabase
    .from("document_signing_requests")
    .select(
      `*,
       document:documents(id, org_id, project_id, prospect_id, title, document_type, source_file_id, executed_file_id, source_entity_type, source_entity_id, created_by, metadata)`,
    )
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error || !signingRequest || !signingRequest.document) {
    throw new Error(`Signing request not found: ${error?.message ?? "Invalid link"}`)
  }
  if (signingRequest.expires_at && new Date(signingRequest.expires_at) < now) {
    throw new Error("Signing link has expired")
  }
  if (signingRequest.status === "signed") {
    throw new Error("This estimate has already been signed.")
  }
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
  if (estimate.status !== "client_signed") {
    throw new Error("Builder signing is only available after the client signs.")
  }

  const envelopeId = signingRequest.envelope_id ?? signingRequest.group_id ?? signingRequest.id
  const signerRole = signingRequest.signer_role ?? "builder"
  const existingSignatureData = ((estimate as any).signature_data as Record<string, any> | null) ?? {}
  const signatureData = {
    ...existingSignatureData,
    builder: {
      signer_name: signerName,
      signer_email: signerEmail,
      signature_text: input.signatureText?.trim() || signerName,
      signature_image: input.signatureImage,
      consent_text: input.consentText.trim(),
      consent_accepted: true,
      signed_at: nowIso,
      signer_ip: input.signerIp ?? null,
      source: "estimate_builder_portal",
      document_id: signingRequest.document_id,
      envelope_id: envelopeId,
    },
  }

  const artifact = await generateExecutedEstimateArtifact({
    supabase,
    orgId: signingRequest.org_id,
    userId: signingRequest.created_by ?? document.created_by ?? null,
    estimate,
    signatureData,
  })
  if (!("fileId" in artifact)) {
    throw new Error(artifact.skippedReason)
  }

  const { error: insertError } = await supabase.from("document_signatures").insert({
    org_id: signingRequest.org_id,
    signing_request_id: signingRequest.id,
    document_id: signingRequest.document_id,
    revision: signingRequest.revision,
    signer_name: signerName,
    signer_email: signerEmail,
    signer_ip: input.signerIp ?? null,
    consent_text: input.consentText.trim(),
    values: {
      estimate_builder_name: signerName,
      estimate_builder_email: signerEmail,
      estimate_builder_signature: input.signatureImage,
      estimate_builder_signed_at: nowIso,
    },
    audit_data: {
      consent_version: "esign-consent-2026-05-24",
      consent_presented_at: nowIso,
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

  const { error: requestUpdateError } = await supabase
    .from("document_signing_requests")
    .update({
      status: "signed",
      signed_at: nowIso,
      used_count: (signingRequest.used_count ?? 0) + 1,
    })
    .eq("id", signingRequest.id)

  if (requestUpdateError) {
    throw new Error(`Failed to update signing request: ${requestUpdateError.message}`)
  }

  await supabase
    .from("documents")
    .update({ status: "signed", executed_file_id: artifact.fileId, updated_at: nowIso })
    .eq("id", signingRequest.document_id)

  await supabase
    .from("envelopes")
    .update({ status: "executed", executed_at: nowIso, updated_at: nowIso })
    .eq("org_id", signingRequest.org_id)
    .eq("id", envelopeId)

  await recordESignEvent({
    supabase,
    orgId: signingRequest.org_id,
    eventType: ENVELOPE_EVENT_TYPES.recipientSigned,
    envelopeId,
    documentId: signingRequest.document_id,
    payload: {
      signing_request_id: signingRequest.id,
      signer_role: signerRole,
      signer_name: signerName,
      signer_email_on_request: signingRequest.sent_to_email ?? null,
      submitted_signer_email: signerEmail,
      signer_ip: input.signerIp ?? null,
      consent_text: input.consentText.trim(),
      consent_version: "esign-consent-2026-05-24",
      signed_at: nowIso,
      source: "estimate_native_builder_signing",
    },
  })

  await recordESignEvent({
    supabase,
    orgId: signingRequest.org_id,
    eventType: ENVELOPE_EVENT_TYPES.executed,
    envelopeId,
    documentId: signingRequest.document_id,
    payload: {
      executed_file_id: artifact.fileId,
      executed_at: nowIso,
      estimate_id: estimateId,
      source: "estimate_native_builder_signing",
    },
  })

  const updated = await executeEstimateFromEnvelopeExecution({
    orgId: signingRequest.org_id,
    estimateId,
    documentId: signingRequest.document_id,
    envelopeId,
    executedFileId: artifact.fileId,
    signerName,
    signerEmail,
    signerIp: input.signerIp ?? null,
    signatureImage: input.signatureImage,
    signatureText: input.signatureText?.trim() || signerName,
    consentText: input.consentText.trim(),
  })

  return { success: true, estimate: updated, executedFileId: artifact.fileId }
}

/** Client posts a comment from the portal (e.g. alongside a "request changes"). */
export async function addClientEstimateComment(input: {
  token: string
  name: string
  email?: string | null
  body: string
}) {
  const name = input.name.trim()
  const body = input.body.trim()
  if (!name) throw new Error("Please enter your name.")
  if (!body) throw new Error("Comment cannot be empty.")

  const supabase = createServiceSupabaseClient()
  const tokenHash = hashToken(input.token)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select("id, org_id, version_group_id, is_current_version")
    .eq("token_hash", tokenHash)
    .maybeSingle()

  if (error) throw new Error(`Database error: ${error.message}`)
  if (!estimate) throw new Error("This estimate link is no longer valid.")

  await addComment(supabase, {
    orgId: estimate.org_id,
    estimateId: estimate.id,
    versionGroupId: estimate.version_group_id ?? null,
    authorType: "client",
    authorName: name,
    authorEmail: input.email?.trim() || null,
    kind: "comment",
    body,
  })

  await recordEvent({
    orgId: estimate.org_id,
    eventType: "estimate_comment_added",
    entityType: "estimate",
    entityId: estimate.id,
    payload: { author_type: "client" },
  })
}
