"use server"

import { revalidatePath } from "next/cache"

import {
  approveChangeOrder,
  createChangeOrder,
  getChangeOrderLinkedInvoices,
  linkInvoiceToChangeOrder,
  listChangeOrders,
  publishChangeOrder,
  unlinkInvoiceFromChangeOrder,
  updateChangeOrder,
  deleteChangeOrder,
  voidChangeOrder,
  type ManualOfflineChangeOrderApprovalInput,
} from "@/lib/services/change-orders"
import {
  createCommitmentChangeOrderFromClientChangeOrder,
  getChangeOrderSubCostSignal,
  listCommitmentChangeOrdersForClientChangeOrder,
} from "@/lib/services/commitment-change-orders"
import { listProjectCommitments } from "@/lib/services/commitments"
import {
  createPortalAccessToken,
  findReusablePortalAccessToken,
  setPortalTokenRequireAccount,
} from "@/lib/services/portal-access"
import { listInvoices } from "@/lib/services/invoices"
import { requireOrgContext } from "@/lib/services/context"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function optionalStringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function parseManualOfflineApprovalInput(input: unknown): ManualOfflineChangeOrderApprovalInput | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  return {
    approvedAt: optionalStringFromRecord(record, "approvedAt"),
    signerName: optionalStringFromRecord(record, "signerName"),
    signerEmail: optionalStringFromRecord(record, "signerEmail"),
    note: optionalStringFromRecord(record, "note"),
    signedFileId: optionalStringFromRecord(record, "signedFileId"),
  }
}

export async function listChangeOrdersAction(projectId?: string) {
  return await listChangeOrders({ projectId })
}

export async function createChangeOrderAction(input: unknown) {
  return run(async () => {
    const parsed = changeOrderInputSchema.parse(input)
    const changeOrder = await createChangeOrder({ input: parsed })
    revalidatePath("/change-orders")
    return changeOrder
  })
}

export async function publishChangeOrderAction(changeOrderId: string) {
  return run(async () => {
    const { supabase, orgId } = await requireOrgContext()

    const { data: changeOrderRow, error: changeOrderError } = await supabase
      .from("change_orders")
      .select("id, project_id")
      .eq("org_id", orgId)
      .eq("id", changeOrderId)
      .maybeSingle()

    if (changeOrderError || !changeOrderRow) {
      throw new Error("Change order not found.")
    }

    const [{ data: projectRow }, { data: orgRow }] = await Promise.all([
      supabase
        .from("projects")
        .select("id, name, client_id")
        .eq("org_id", orgId)
        .eq("id", changeOrderRow.project_id)
        .maybeSingle(),
      supabase
        .from("orgs")
        .select("id, name, logo_url, slug")
        .eq("id", orgId)
        .maybeSingle(),
    ])

    const clientId = projectRow?.client_id as string | null | undefined
    if (!clientId) {
      throw new Error("Add a project client with an email before sending this change order.")
    }

    const { data: contactRow, error: contactError } = await supabase
      .from("contacts")
      .select("id, full_name, email")
      .eq("org_id", orgId)
      .eq("id", clientId)
      .maybeSingle()

    if (contactError || !contactRow) {
      throw new Error("Project client contact not found.")
    }

    if (!contactRow.email) {
      throw new Error("Project client needs an email before sending this change order.")
    }

    const reusableToken = await findReusablePortalAccessToken({
      projectId: changeOrderRow.project_id,
      portalType: "client",
      contactId: contactRow.id,
      orgId,
    })

    let token =
      reusableToken?.permissions.can_approve_change_orders
        ? reusableToken
        : await createPortalAccessToken({
            projectId: changeOrderRow.project_id,
            portalType: "client",
            contactId: contactRow.id,
            permissions: { can_approve_change_orders: true },
            requireAccount: false,
            orgId,
          })

    if (token.require_account) {
      await setPortalTokenRequireAccount({
        tokenId: token.id,
        requireAccount: false,
        orgId,
      })
      token = { ...token, require_account: false }
    }

    const changeOrder = await publishChangeOrder(changeOrderId)

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
    const portalPath = `/p/${token.token}/change-orders/${changeOrder.id}`
    const portalUrl = appUrl ? `${appUrl}${portalPath}` : portalPath
    const formattedTotal = ((changeOrder.total_cents ?? 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    })
    const emailHtml = renderStandardEmailLayout({
      title: "Change order ready for review",
      orgName: orgRow?.name ?? "Arc",
      orgLogoUrl: (orgRow as any)?.logo_url ?? null,
      buttonText: "Review change order",
      buttonUrl: portalUrl,
      showManageSettings: false,
      messageHtml: `
        <p style="margin: 0 0 12px 0;">${escapeEmailHtml(orgRow?.name ?? "Your builder")} sent a change order for your review.</p>
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e5e5e5; border-collapse: collapse; margin: 18px 0;">
          <tr>
            <td style="padding: 12px 14px; color: #666666; font-size: 12px; width: 34%;">Change order</td>
            <td style="padding: 12px 14px; color: #111111; font-size: 13px; font-weight: 700;">${escapeEmailHtml(changeOrder.title)}</td>
          </tr>
          <tr>
            <td style="padding: 12px 14px; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee;">Project</td>
            <td style="padding: 12px 14px; color: #111111; font-size: 13px; border-top: 1px solid #eeeeee;">${escapeEmailHtml(projectRow?.name ?? "Project")}</td>
          </tr>
          <tr>
            <td style="padding: 12px 14px; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee;">Total change</td>
            <td style="padding: 12px 14px; color: #111111; font-size: 13px; font-weight: 700; border-top: 1px solid #eeeeee;">${escapeEmailHtml(formattedTotal)}</td>
          </tr>
        </table>
        <p style="margin: 0;">Open the secure portal to review the scope, request changes, or approve and sign.</p>
      `,
    })
    const emailSent = await sendEmail({
      to: [contactRow.email],
      subject: `${orgRow?.name ?? "Your builder"} sent a change order: ${changeOrder.title}`,
      html: emailHtml,
      from: getOrgSenderEmail((orgRow as any)?.slug ?? null, orgRow?.name ?? null),
    })
    const sentAt = new Date().toISOString()
    const metadata = {
      ...(changeOrder.metadata ?? {}),
      portal_url: portalUrl,
      sent_to: contactRow.email,
      email_sent: emailSent,
      email_sent_at: sentAt,
    }
    const changeOrderWithSendMetadata = { ...changeOrder, metadata }
    await supabase
      .from("change_orders")
      .update({ metadata })
      .eq("org_id", orgId)
      .eq("id", changeOrder.id)

    revalidatePath("/change-orders")
    revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
    return {
      changeOrder: changeOrderWithSendMetadata,
      portal_url: portalUrl,
      sent_to: contactRow.email as string,
      email_sent: emailSent,
    }
  })
}

export async function approveChangeOrderAction(changeOrderId: string, input?: unknown) {
  return run(async () => {
    const changeOrder = await approveChangeOrder({
      changeOrderId,
      approval: parseManualOfflineApprovalInput(input),
    })
    revalidatePath("/change-orders")
    if (changeOrder.project_id) {
      revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
      revalidatePath(`/projects/${changeOrder.project_id}/budget`)
      revalidatePath(`/projects/${changeOrder.project_id}/financials/receivables`)
      revalidatePath(`/projects/${changeOrder.project_id}`)
    }
    return changeOrder
  })
}

export type LinkableChangeOrderInvoice = {
  id: string
  invoice_number: string
  title: string | null
  status: string
  total_cents: number
  issue_date: string | null
  from_qbo: boolean
}

/**
 * Invoices in the same project that may be manually linked to a change order:
 * not voided, not already tied to a draw or another change order. Mirrors the
 * linkable-invoices rule used for draws.
 */
export async function listLinkableInvoicesForChangeOrderAction(
  projectId: string,
): Promise<LinkableChangeOrderInvoice[]> {
  const { orgId } = await requireOrgContext()
  const invoices = await listInvoices({ orgId, projectId })

  return invoices
    .filter((invoice) => {
      if (String(invoice.status).toLowerCase() === "void") return false
      const metadata = (invoice.metadata ?? {}) as Record<string, any>
      if (metadata.source_draw_id) return false
      if (metadata.source_change_order_id) return false
      const sourceType = typeof metadata.source_type === "string" ? metadata.source_type : null
      if (sourceType && sourceType !== "manual" && sourceType !== "qbo") return false
      return true
    })
    .map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      title: invoice.title ?? null,
      status: invoice.status,
      total_cents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
      issue_date: invoice.issue_date ?? null,
      from_qbo: Boolean(invoice.qbo_id) || (invoice.metadata as any)?.source_type === "qbo",
    }))
}

export async function getChangeOrderLinkedInvoicesAction(changeOrderId: string) {
  return await getChangeOrderLinkedInvoices({ changeOrderId })
}

export async function listCommitmentChangeOrdersForChangeOrderAction(changeOrderId: string) {
  return await listCommitmentChangeOrdersForClientChangeOrder({ changeOrderId })
}

export async function getChangeOrderSubCostSignalAction(changeOrderId: string) {
  return await getChangeOrderSubCostSignal({ changeOrderId })
}

export async function listCommitmentsForChangeOrderAction(projectId: string) {
  return await listProjectCommitments(projectId)
}

export async function createCommitmentChangeOrderFromChangeOrderAction(
  projectId: string,
  changeOrderId: string,
  commitmentId: string,
) {
  return run(async () => {
    const result = await createCommitmentChangeOrderFromClientChangeOrder({
      input: {
        change_order_id: changeOrderId,
        commitment_id: commitmentId,
      },
    })
    revalidatePath("/change-orders")
    revalidatePath(`/projects/${projectId}/change-orders`)
    revalidatePath(`/projects/${projectId}/commitments`)
    revalidatePath(`/projects/${projectId}/financials/budget`)
    return result
  })
}

export async function updateChangeOrderFollowupAction(
  changeOrderId: string,
  input: { vendor_impact_status?: string | null },
) {
  return run(async () => {
    const { supabase, orgId } = await requireOrgContext()
    const allowedVendorStatuses = new Set([
      "not_reviewed",
      "no_vendor_impact",
      "needs_vendor_pricing",
      "create_vendor_change",
      "linked_commitment",
    ])
    const vendorStatus = input.vendor_impact_status ?? "not_reviewed"
    if (!allowedVendorStatuses.has(vendorStatus)) {
      throw new Error("Invalid vendor impact status.")
    }

    const { data: existing, error: loadError } = await supabase
      .from("change_orders")
      .select("id, project_id, metadata")
      .eq("org_id", orgId)
      .eq("id", changeOrderId)
      .maybeSingle()

    if (loadError || !existing) {
      throw new Error("Change order not found.")
    }

    const previousMetadata = ((existing.metadata as Record<string, any> | null) ?? {}) as Record<string, any>
    const metadata: Record<string, any> = {
      ...previousMetadata,
      vendor_impact_status: vendorStatus,
      vendor_impact_reviewed_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from("change_orders")
      .update({ metadata })
      .eq("org_id", orgId)
      .eq("id", changeOrderId)
      .select(
        "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
      )
      .single()

    if (error || !data) {
      throw new Error(`Failed to update follow-up: ${error?.message}`)
    }

    revalidatePath("/change-orders")
    revalidatePath(`/projects/${existing.project_id}/change-orders`)
    return { ...data, lines: metadata.lines ?? [], totals: metadata.totals, metadata }
  })
}

export async function linkInvoiceToChangeOrderAction(
  projectId: string,
  changeOrderId: string,
  invoiceId: string,
) {
  return run(async () => {
    const result = await linkInvoiceToChangeOrder({ changeOrderId, invoiceId })
    revalidatePath("/change-orders")
    revalidatePath(`/projects/${projectId}/change-orders`)
    revalidatePath(`/projects/${projectId}/financials/receivables`)
    return result
  })
}

export async function unlinkInvoiceFromChangeOrderAction(projectId: string, changeOrderId: string, invoiceId: string) {
  return run(async () => {
    const result = await unlinkInvoiceFromChangeOrder({ changeOrderId, invoiceId })
    revalidatePath("/change-orders")
    revalidatePath(`/projects/${projectId}/change-orders`)
    revalidatePath(`/projects/${projectId}/financials/receivables`)
    return result
  })
}

export async function updateChangeOrderAction(changeOrderId: string, input: unknown) {
  return run(async () => {
    const parsed = changeOrderInputSchema.parse(input)
    const changeOrder = await updateChangeOrder({ changeOrderId, input: parsed })
    revalidatePath("/change-orders")
    if (changeOrder.project_id) {
      revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
    }
    return changeOrder
  })
}

export async function deleteChangeOrderAction(changeOrderId: string) {
  return run(async () => {
    const changeOrder = await deleteChangeOrder({ changeOrderId })
    revalidatePath("/change-orders")
    if (changeOrder.project_id) {
      revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
    }
    return changeOrder
  })
}

export async function voidChangeOrderAction(changeOrderId: string, reason?: string) {
  return run(async () => {
    const trimmed = typeof reason === "string" ? reason.trim() : ""
    const changeOrder = await voidChangeOrder({ changeOrderId, reason: trimmed.length > 0 ? trimmed : null })
    revalidatePath("/change-orders")
    if (changeOrder.project_id) {
      revalidatePath(`/projects/${changeOrder.project_id}/change-orders`)
      revalidatePath(`/projects/${changeOrder.project_id}/financials/receivables`)
      revalidatePath(`/projects/${changeOrder.project_id}/budget`)
      revalidatePath(`/projects/${changeOrder.project_id}`)
    }
    return changeOrder
  })
}
