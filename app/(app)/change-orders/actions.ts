"use server"

import { revalidatePath } from "next/cache"

import {
  approveChangeOrder,
  createChangeOrder,
  getChangeOrderLinkedInvoice,
  linkInvoiceToChangeOrder,
  listChangeOrders,
  publishChangeOrder,
  unlinkInvoiceFromChangeOrder,
} from "@/lib/services/change-orders"
import { listInvoices } from "@/lib/services/invoices"
import { requireOrgContext } from "@/lib/services/context"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function listChangeOrdersAction(projectId?: string) {
  try {
    return await listChangeOrders({ projectId })
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createChangeOrderAction(input: unknown) {
  try {
    const parsed = changeOrderInputSchema.parse(input)
    const changeOrder = await createChangeOrder({ input: parsed })
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function publishChangeOrderAction(changeOrderId: string) {
  try {
    const changeOrder = await publishChangeOrder(changeOrderId)
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function approveChangeOrderAction(changeOrderId: string) {
  try {
    const changeOrder = await approveChangeOrder({ changeOrderId })
    revalidatePath("/change-orders")
    return changeOrder
  } catch (error) {
    rethrowTypedAuthError(error)
  }
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
  try {
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
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function getChangeOrderLinkedInvoiceAction(changeOrderId: string) {
  try {
    return await getChangeOrderLinkedInvoice({ changeOrderId })
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function linkInvoiceToChangeOrderAction(
  projectId: string,
  changeOrderId: string,
  invoiceId: string,
) {
  try {
    const result = await linkInvoiceToChangeOrder({ changeOrderId, invoiceId })
    revalidatePath("/change-orders")
    revalidatePath(`/projects/${projectId}/change-orders`)
    revalidatePath(`/projects/${projectId}/financials/receivables`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function unlinkInvoiceFromChangeOrderAction(projectId: string, changeOrderId: string) {
  try {
    const result = await unlinkInvoiceFromChangeOrder({ changeOrderId })
    revalidatePath("/change-orders")
    revalidatePath(`/projects/${projectId}/change-orders`)
    revalidatePath(`/projects/${projectId}/financials/receivables`)
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
