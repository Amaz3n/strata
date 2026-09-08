import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { randomBytes, createHmac } from "node:crypto"
import { buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SignatureEmail } from "@/lib/emails/signature-email"
import {
  getOrgSenderEmail,
  renderEmailTemplate,
  sendEmail,
} from "@/lib/services/mailer"
function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) throw new Error("Missing document signing secret")
  return secret
}
export async function issueSigningLinkForRequest(
  supabase: SupabaseClient,
  params: { orgId: string; requestId: string; markSent: boolean },
) {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret())
    .update(token)
    .digest("hex")
  const nowIso = new Date().toISOString()
  const updatePayload: Record<string, unknown> = {
    token_hash: tokenHash,
    sent_at: nowIso,
  }

  if (params.markSent) {
    updatePayload.status = "sent"
  }

  const { error } = await supabase
    .from("document_signing_requests")
    .update(updatePayload)
    .eq("org_id", params.orgId)
    .eq("id", params.requestId)

  if (error) {
    throw new Error(`Failed to issue signing link: ${error.message}`)
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
  signingUrl: string
  recipientName?: string
  isReminder?: boolean
}) {
  const supabase = createServiceSupabaseClient()
  const { data: org } = await supabase
    .from("orgs")
    .select("name, logo_url, slug")
    .eq("id", input.orgId)
    .maybeSingle()
  const subject = input.isReminder
    ? `Reminder: Signature requested - ${input.documentTitle}`
    : `Signature requested: ${input.documentTitle}`
  const html = await renderEmailTemplate(
    SignatureEmail({
      documentTitle: input.documentTitle,
      signingLink: input.signingUrl,
      recipientName: input.recipientName,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      eventLabel: input.isReminder ? "Signature Reminder" : "Signature Request",
      headline: input.isReminder
        ? "Signature still needed"
        : "Document ready for signature",
      bodyText: input.isReminder
        ? "This is a reminder that your signature is still needed."
        : "You have a document ready for signature.",
      detailLabel: "Signature",
      detailText:
        "Open the document to review all pages, complete required fields, and sign electronically.",
      buttonText: "Review and Sign",
    }),
  )

  const delivered = await sendEmail({
    to: [input.toEmail],
    subject,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })
  if (!delivered)
    throw new Error("Signature email was not delivered; retry the request")
}
