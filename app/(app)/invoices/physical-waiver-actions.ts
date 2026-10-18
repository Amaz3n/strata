"use server"

import { runAction } from "@/lib/action-result"
import { revalidatePath } from "next/cache"

export async function holdInvoiceForPhysicalWaiverAction(invoiceId: string, waiverId: string, recipients: string[]) {
  return runAction(async () => {
    const { invoiceWaiverContext, getInvoiceWaiverRecord } = await import("@/lib/services/invoice-waiver-workflow")
    const { isInvoiceRecipientValid } = await import("@/lib/invoices/composer-recipients")
    const { getInvoiceWithLines, assertInvoiceCanIssue } = await import("@/lib/services/invoices")
    const { readWaiverWorkflow } = await import("@/lib/lien-waivers/invoice-waiver")
    const { invoiceWaiverContentHash } = await import("@/lib/lien-waivers/invoice-content")
    if (!Array.isArray(recipients) || !recipients.length || recipients.some(email => !isInvoiceRecipientValid(email))) throw new Error("Add valid customer email addresses")
    const ctx = await invoiceWaiverContext(invoiceId, "invoice.send")
    const invoice = await getInvoiceWithLines(invoiceId,ctx.orgId)
    if (!invoice) throw new Error("Invoice not found")
    await assertInvoiceCanIssue(ctx,invoice)
    const {waiver} = await getInvoiceWaiverRecord(invoiceId,waiverId,"invoice.write")
    const flow = readWaiverWorkflow(waiver)
    if (!flow || waiver.status === "void" || flow.signing_document_id || flow.invoice_content_hash !== invoiceWaiverContentHash(ctx.invoice)) throw new Error("Prepare a current waiver for physical signing")
    const {data,error} = await ctx.supabase.from("invoices").update({metadata:{...ctx.invoice.metadata,waiver_packet:{enabled:true,waiver_id:waiverId,delivery_mode:"after_physical_execution",actor_id:ctx.userId,recipients,requested_at:new Date().toISOString()}}}).eq("org_id",ctx.orgId).eq("id",invoiceId).eq("updated_at",ctx.invoice.updated_at).select("id").maybeSingle()
    if(error || !data) throw new Error("Could not save the pending invoice delivery. Refresh and try again.")
    revalidatePath("/billing")
    return (await getInvoiceWithLines(invoiceId,ctx.orgId))!
  })
}
export async function uploadExecutedWaiverAction(form: FormData) {
  return runAction(async () => {
    const file = form.get("file")
    if (!(file instanceof File)) throw new Error("Choose the scanned PDF")
    const result = await (await import("@/lib/services/invoice-waiver-workflow")).uploadExecutedInvoiceWaiver(String(form.get("invoiceId")),String(form.get("waiverId")),file,form.get("confirmed") === "true")
    revalidatePath("/billing"); revalidatePath("/invoices")
    return result
  })
}
