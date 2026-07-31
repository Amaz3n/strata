import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { forwardRfiSchema } from "@/lib/validation/rfi-forward"

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;")
}

export async function forwardRfiByEmail(input: unknown, orgId?: string) {
  const parsed = forwardRfiSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("rfi.write", context)
  const { data: rfi } = await context.supabase.from("rfis").select("id,project_id,rfi_number,subject,question").eq("org_id", context.orgId).eq("id", parsed.rfi_id).maybeSingle()
  if (!rfi) throw new Error("RFI not found")
  const serviceClient = createServiceSupabaseClient()
  const { data: token, error: tokenError } = await serviceClient.from("portal_access_tokens").insert({
    org_id: context.orgId, project_id: rfi.project_id, portal_type: "sub", scoped_rfi_id: rfi.id,
    can_view_schedule: false, can_view_photos: false, can_view_documents: false, can_view_daily_logs: false,
    can_view_budget: false, can_approve_change_orders: false, can_submit_selections: false,
    can_create_punch_items: false, can_message: false, can_view_invoices: false, can_pay_invoices: false,
    can_view_rfis: true, can_respond_rfis: true, can_view_submittals: false, can_submit_submittals: false,
    can_download_files: true, can_submit_invoices: false, can_view_commitments: false, can_view_bills: false,
    can_upload_compliance_docs: false, require_account: false, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), created_by: context.userId,
  }).select("id,token").single()
  if (tokenError || !token) throw new Error(`Failed to create RFI participant link: ${tokenError?.message}`)
  const participant = { org_id: context.orgId, project_id: rfi.project_id, rfi_id: rfi.id, email: parsed.email.toLowerCase(), name: parsed.name ?? null, portal_token_id: token.id, invited_by: context.userId }
  const { data, error } = await context.supabase.from("rfi_external_participants").upsert(participant, { onConflict: "rfi_id,email" }).select("*").single()
  if (error || !data) throw new Error(`Failed to add RFI participant: ${error?.message}`)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  const url = `${appUrl}/s/${token.token}`
  const html = renderStandardEmailLayout({ title: `RFI #${rfi.rfi_number}: ${rfi.subject}`, messageHtml: `<p>${escapeHtml(parsed.message ?? "Your input is requested on this RFI.")}</p><p>${escapeHtml(rfi.question)}</p>`, buttonText: "Review and respond", buttonUrl: url, showManageSettings: false })
  await sendEmail({ from: await getOrgSenderEmail(context.orgId), to: [parsed.email], subject: `RFI #${rfi.rfi_number}: ${rfi.subject}`, html })
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "rfi_forwarded", entityType: "rfi", entityId: rfi.id, payload: { project_id: rfi.project_id, participant_id: data.id, email: parsed.email } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "rfi_external_participant", entityId: data.id, after: participant }),
  ])
  return data
}
