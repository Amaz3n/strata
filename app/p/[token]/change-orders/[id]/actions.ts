"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import { recordEvent } from "@/lib/services/events"
import { approveChangeOrderFromPortalSignature, getChangeOrderForPortal } from "@/lib/services/change-orders"
import { validatePortalToken } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"

async function clientIp(): Promise<string | null> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null
  return h.get("x-real-ip")
}

function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export async function approveChangeOrderInPortalAction(input: {
  token: string
  changeOrderId: string
  signature: {
    signer_name: string
    signer_email?: string | null
    signature_text?: string | null
    signature_image: string
    consent_accepted: boolean
  }
}) {
  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_approve_change_orders) {
    throw new Error("This portal link cannot approve change orders.")
  }

  const changeOrder = await getChangeOrderForPortal(input.changeOrderId, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    throw new Error("Change order not found.")
  }

  if (changeOrder.status === "approved") {
    return { success: true }
  }

  const signerName = input.signature.signer_name.trim()
  const signatureImage = input.signature.signature_image
  if (!input.signature.consent_accepted || !signerName || !signatureImage) {
    throw new Error("Signature and electronic consent are required.")
  }

  const ip = await clientIp()
  await approveChangeOrderFromPortalSignature({
    orgId: access.org_id,
    projectId: access.project_id,
    changeOrderId: input.changeOrderId,
    portalTokenId: access.id,
    contactId: access.contact_id ?? null,
    signerName,
    signerEmail: input.signature.signer_email?.trim() || null,
    signatureText: input.signature.signature_text?.trim() || signerName,
    signatureImage,
    signerIp: ip,
  })

  revalidatePath(`/p/${input.token}/change-orders/${input.changeOrderId}`)
  return { success: true }
}

export async function requestChangeOrderChangesAction(input: {
  token: string
  changeOrderId: string
  note: string
}) {
  const note = input.note.trim()
  if (note.length < 3) {
    throw new Error("Add a note before sending changes.")
  }

  const access = await validatePortalToken(input.token)
  if (!access || !access.permissions.can_approve_change_orders) {
    throw new Error("This portal link cannot request change-order changes.")
  }

  const changeOrder = await getChangeOrderForPortal(input.changeOrderId, access.org_id, access.project_id)
  if (!changeOrder || !changeOrder.client_visible) {
    throw new Error("Change order not found.")
  }

  if (changeOrder.status === "approved") {
    throw new Error("This change order has already been approved.")
  }

  const supabase = createServiceSupabaseClient()

  let requester: { name: string | null; email: string | null } = { name: null, email: null }
  if (access.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("full_name, email")
      .eq("org_id", access.org_id)
      .eq("id", access.contact_id)
      .maybeSingle()

    requester = {
      name: contact?.full_name ?? null,
      email: contact?.email ?? null,
    }
  }

  const nowIso = new Date().toISOString()
  const existingRequests = Array.isArray(changeOrder.metadata?.portal_change_requests)
    ? changeOrder.metadata.portal_change_requests
    : []

  const metadata = {
    ...(changeOrder.metadata ?? {}),
    portal_change_requested_at: nowIso,
    portal_change_requested_by_contact_id: access.contact_id ?? null,
    portal_change_requested_by_name: requester.name,
    portal_change_requested_by_email: requester.email,
    portal_change_request_note: note,
    portal_change_request_active: true,
    portal_change_request_resolved_at: null,
    portal_change_request_resolved_by: null,
    portal_change_requests: [
      ...existingRequests,
      {
        note,
        requested_at: nowIso,
        contact_id: access.contact_id ?? null,
        name: requester.name,
        email: requester.email,
      },
    ],
  }

  const { error } = await supabase
    .from("change_orders")
    .update({
      status: "requested_changes",
      metadata,
      updated_at: nowIso,
    })
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .eq("id", input.changeOrderId)

  if (error) {
    throw new Error(`Failed to send changes: ${error.message}`)
  }

  await recordEvent({
    orgId: access.org_id,
    eventType: "portal_message",
    entityType: "change_order",
    entityId: input.changeOrderId,
    payload: {
      project_id: access.project_id,
      status: "requested_changes",
      source: "portal",
      note,
      contact_id: access.contact_id ?? null,
    },
  })

  if (typeof changeOrder.metadata?.published_by === "string") {
    try {
      const [builderResult, orgResult, projectResult] = await Promise.all([
        supabase
          .from("app_users")
          .select("email, full_name")
          .eq("id", changeOrder.metadata.published_by)
          .maybeSingle(),
        supabase
          .from("orgs")
          .select("name, logo_url, slug")
          .eq("id", access.org_id)
          .maybeSingle(),
        supabase
          .from("projects")
          .select("name")
          .eq("id", access.project_id)
          .maybeSingle(),
      ])

      const builderEmail = builderResult.data?.email
      if (builderEmail) {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).replace(/\/$/, "")
        const requesterLabel = requester.email
          ? `${requester.name ?? "Client"} <${requester.email}>`
          : requester.name ?? "Client"
        const html = renderStandardEmailLayout({
          title: "Client requested changes",
          orgName: orgResult.data?.name ?? "Arc",
          orgLogoUrl: orgResult.data?.logo_url ?? null,
          buttonText: "Open change orders",
          buttonUrl: appUrl ? `${appUrl}/change-orders` : undefined,
          messageHtml: `
            <p style="margin: 0 0 12px 0;">${escapeEmailHtml(requesterLabel)} requested changes to "${escapeEmailHtml(changeOrder.title)}".</p>
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e5e5e5; border-collapse: collapse; margin: 18px 0;">
              <tr>
                <td style="padding: 12px 14px; color: #666666; font-size: 12px; width: 34%;">Project</td>
                <td style="padding: 12px 14px; color: #111111; font-size: 13px;">${escapeEmailHtml(projectResult.data?.name ?? "Project")}</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee;">Requested change</td>
                <td style="padding: 12px 14px; color: #111111; font-size: 13px; border-top: 1px solid #eeeeee; white-space: pre-line;">${escapeEmailHtml(note)}</td>
              </tr>
            </table>
            <p style="margin: 0;">Edit the change order and resend it through the client portal when ready.</p>
          `,
        })

        await sendEmail({
          to: [builderEmail],
          subject: `Changes requested: ${changeOrder.title}`,
          html,
          from: getOrgSenderEmail(orgResult.data?.slug ?? null, orgResult.data?.name ?? null),
        })
      }
    } catch (error) {
      console.error("[change-orders] Failed to send change-request notification email:", error)
    }
  }

  revalidatePath(`/p/${input.token}/change-orders/${input.changeOrderId}`)
  revalidatePath("/change-orders")
  revalidatePath(`/projects/${access.project_id}/change-orders`)
  return { success: true }
}
