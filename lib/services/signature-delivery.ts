import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createRecoverableSigningToken } from "@/lib/esign/signing-tokens"
import { createHash } from "node:crypto"
import { recordSigningEmailAccepted } from "@/lib/services/esign-delivery-events"
import { buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SignatureEmail } from "@/lib/emails/signature-email"
import {
  getOrgSenderEmail,
  renderEmailTemplate,
  sendEmail,
} from "@/lib/services/mailer"
export async function issueSigningLinkForRequest(
  supabase: SupabaseClient,
  params: { orgId: string; requestId: string; markSent: boolean; expectedEmail?: string },
) {
  const { data: request, error: loadError } = await supabase.from("document_signing_requests")
    .select("id, token_hash, status, sent_at, sent_to_email").eq("org_id", params.orgId).eq("id", params.requestId).single()
  if (loadError || !request) throw new Error("Signing request not found")
  if (params.expectedEmail && request.sent_to_email?.trim().toLowerCase() !== params.expectedEmail.trim().toLowerCase()) {
    throw new Error("The signing recipient changed. Reload the signatures page.")
  }
  if (!["draft", "sent", "viewed"].includes(request.status)) throw new Error("Signing request is no longer active")
  const token = createRecoverableSigningToken(request)
  const nowIso = new Date().toISOString()
  if (params.markSent && request.status === "draft") {
    const { error } = await createServiceSupabaseClient()
    .from("document_signing_requests")
    .update({ status: "sent", sent_at: nowIso })
    .eq("org_id", params.orgId)
    .eq("id", params.requestId)
    .eq("token_hash", request.token_hash)
    .eq("status", "draft")
    if (error) throw new Error(`Failed to issue signing link: ${error.message}`)
  }

  return {
    url: buildUnifiedSigningUrl(token),
    sentAt: nowIso,
  }
}

export async function sendSignerRequestEmail(input: {
  orgId: string
  toEmail: string
  documentTitle: string
  documentId?: string
  signingUrl: string
  recipientName?: string
  isReminder?: boolean
  idempotencyKey?: string
  subject?: string
  message?: string
  requestId?: string
  expectedTokenHash?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", input.orgId)
    .maybeSingle()
  let waiverContext: { projectName: string; invoiceNumber: string; amount: string; through: string; type: string; afterSignature: boolean } | null = null
  if (input.documentId) {
    const { data: document } = await supabase.from("documents").select("metadata").eq("org_id", input.orgId).eq("id", input.documentId).maybeSingle()
    if (document?.metadata?.invoice_lien_waiver_id) {
      const { data: waiver } = await supabase.from("invoice_lien_waivers").select("invoice_id,amount_cents,waiver_type,metadata").eq("org_id", input.orgId).eq("id", document.metadata.invoice_lien_waiver_id).maybeSingle()
      const values = waiver?.metadata?.workflow?.input
      if (waiver && values) {
        const { data: invoice } = await supabase.from("invoices").select("invoice_number,currency,metadata").eq("org_id", input.orgId).eq("id", waiver.invoice_id).maybeSingle()
        const { INVOICE_WAIVER_TYPE_LABELS } = await import("@/lib/types")
        waiverContext = { afterSignature: invoice?.metadata?.waiver_packet?.delivery_mode === "after_signature", projectName: values.project_name, invoiceNumber: invoice?.invoice_number ?? "",
          amount: new Intl.NumberFormat("en-US", { style: "currency", currency: invoice?.currency ?? "USD" }).format(waiver.amount_cents / 100),
          through: values.through_date ? new Date(`${values.through_date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "", type: INVOICE_WAIVER_TYPE_LABELS[waiver.waiver_type as keyof typeof INVOICE_WAIVER_TYPE_LABELS] ?? "Lien waiver" }
      }
    }
  }
  const subject = input.subject?.trim() || (input.isReminder
    ? `Reminder: Signature requested - ${input.documentTitle}`
    : waiverContext ? `Sign waiver · ${waiverContext.projectName || input.documentTitle}` : `Signature requested: ${input.documentTitle}`)
  const html = await renderEmailTemplate(
    SignatureEmail({
      documentTitle: input.documentTitle,
      signingLink: input.signingUrl,
      recipientName: input.recipientName,
      projectName: waiverContext?.projectName,
      details: waiverContext ? [{ label: "Invoice", value: waiverContext.invoiceNumber }, { label: "Amount covered", value: waiverContext.amount }, { label: "Work through", value: waiverContext.through }].filter(row => row.value) : undefined,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      eventLabel: input.isReminder ? "Signature Reminder" : "Signature Request",
      headline: input.isReminder
        ? "Signature still needed"
        : waiverContext ? "Review and sign the waiver" : "Document ready for signature",
      bodyText: input.message?.trim() || (input.isReminder
        ? "This is a reminder that your signature is still needed."
        : waiverContext?.afterSignature ? "Your signature is needed before the invoice and waiver can be sent to the customer." : "You have a document ready for signature."),
      detailLabel: waiverContext?.type ?? "Signature",
      detailText:
        "Open the document to review all pages, complete required fields, and sign electronically.",
      buttonText: "Review and Sign",
    }),
  )

  const delivered = await sendEmail({
    onAccepted: input.requestId && input.expectedTokenHash ? providerId => recordSigningEmailAccepted({ orgId: input.orgId,
      requestId: input.requestId!, expectedTokenHash: input.expectedTokenHash!, providerId, kind: input.isReminder ? "reminder" : "invitation" }) : undefined,
    idempotencyKey: input.idempotencyKey,
    to: [input.toEmail],
    subject,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
  if (!delivered) {
    if (input.requestId && input.expectedTokenHash) {
      const { error } = await supabase.from("document_signing_requests")
        .update({ delivery_status: "failed", delivery_error: "Email was not accepted. Delivery will be retried.", delivery_updated_at: new Date().toISOString() })
        .eq("org_id", input.orgId).eq("id", input.requestId).eq("token_hash", input.expectedTokenHash)
      if (error) throw new Error(`Signature delivery and failure recording failed: ${error.message}`)
    }
    throw new Error("Signature email was not delivered; retry the request")
  }
}

export async function deliverSigningInvitation(input: { orgId: string; requestId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: request, error } = await supabase.from("document_signing_requests")
    .select("*, documents(title), envelopes(status, expires_at, subject, message, metadata), envelope_recipients(name)")
    .eq("org_id", input.orgId).eq("id", input.requestId).single()
  if (error || !request) throw new Error("Signing invitation not found")
  if (!["sent", "viewed"].includes(request.status) || !["sent", "partially_signed"].includes(request.envelopes?.status) ||
      (request.expires_at && new Date(request.expires_at).getTime() <= Date.now()) ||
      (request.envelopes?.expires_at && new Date(request.envelopes.expires_at).getTime() <= Date.now())) return
  // Recipient and credential must come from one snapshot: correction revokes this link.
  const link = { url: buildUnifiedSigningUrl(createRecoverableSigningToken(request)) }
  await sendSignerRequestEmail({ orgId: input.orgId, toEmail: request.sent_to_email,
    requestId: request.id, expectedTokenHash: request.token_hash,
    documentTitle: request.documents?.title ?? "Document", documentId: request.document_id,
    signingUrl: link.url, recipientName: request.envelope_recipients?.name,
    subject: request.envelopes?.subject ?? request.envelopes?.metadata?.email_subject, message: request.envelopes?.message ?? request.envelopes?.metadata?.email_message,
    idempotencyKey: `esign-invitation:${request.id}:${createHash("sha256").update(request.token_hash).digest("hex").slice(0, 24)}` })
}

/** Outbox-owned delivery: provider acceptance and the receipt must both persist. */
export async function deliverAutomaticSigningReminder(input: { orgId: string; requestId: string; deliveryKey: string }) {
  const supabase = createServiceSupabaseClient()
  const manual = input.deliveryKey.startsWith("manual:")
  const { data: request, error } = await supabase.from("document_signing_requests")
    .select("*, documents(title, status), envelopes(status, expires_at, subject, message, metadata), envelope_recipients(name)")
    .eq("org_id", input.orgId).eq("id", input.requestId).single()
  if (error || !request) throw new Error("Reminder request not found")
  if (!["sent", "viewed"].includes(request.status) ||
      (request.envelopes ? !["sent", "partially_signed"].includes(request.envelopes.status) : request.documents?.status !== "sent") ||
      (!manual && request.envelopes?.metadata?.reminder_settings?.enabled !== true) ||
      (request.expires_at && new Date(request.expires_at).getTime() <= Date.now()) ||
      (request.envelopes?.expires_at && new Date(request.envelopes.expires_at).getTime() <= Date.now())) return
  let receiptQuery = supabase.from("esign_reminder_deliveries")
    .select("sent_at").eq("org_id", input.orgId).eq("signing_request_id", request.id)
    .eq("delivery_type", manual ? "manual" : "automatic").eq("status", "sent")
  if (manual) receiptQuery = receiptQuery.eq("delivery_key", input.deliveryKey)
  const { data: receipt, error: receiptError } = await receiptQuery.order("sent_at", { ascending: false }).limit(1).maybeSingle()
  if (receiptError) throw new Error(`Could not read reminder receipt: ${receiptError.message}`)
  const expectedKey = `${request.id}:${receipt?.sent_at ?? request.sent_at}`
  if (manual ? Boolean(receipt) : expectedKey !== input.deliveryKey) return // An earlier attempt already recorded delivery.
  // Recipient and credential must come from one snapshot: correction revokes this link.
  const link = { url: buildUnifiedSigningUrl(createRecoverableSigningToken(request)) }
  await sendSignerRequestEmail({ orgId: input.orgId, toEmail: request.sent_to_email,
    requestId: request.id, expectedTokenHash: request.token_hash,
    documentTitle: request.documents?.title ?? "Document", documentId: request.document_id,
    signingUrl: link.url, recipientName: request.envelope_recipients?.name, isReminder: true,
    idempotencyKey: `esign-reminder:${input.deliveryKey}` })
  const { error: saveError } = await supabase.from("esign_reminder_deliveries").insert({
    org_id: input.orgId, envelope_id: request.envelope_id, signing_request_id: request.id,
    recipient_email: request.sent_to_email, delivery_type: manual ? "manual" : "automatic", status: "sent", delivery_key: input.deliveryKey,
  })
  if (saveError && saveError.code !== "23505") throw new Error(`Could not record reminder delivery: ${saveError.message}`)
}
