import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readWaiverWorkflow } from "@/lib/lien-waivers/invoice-waiver"
import { isIssuedInvoiceStatus } from "@/lib/financials/invoice-lifecycle"
import { normalizeProductTier } from "@/lib/product-tier"
import { issueInvoiceWithContext } from "@/lib/services/invoices"

/** Runs in the retryable signing-completion job, including retries after artifact attachment. */
export async function sendInvoiceAfterWaiverSignature(supabase: SupabaseClient, orgId: string, invoiceId: string, waiverId: string) {
  const { data: invoice, error } = await supabase.from("invoices").select("id,status,metadata").eq("org_id", orgId).eq("id", invoiceId).single()
  if (error || !invoice) throw new Error("Could not load the invoice awaiting signature")
  const plan = invoice.metadata?.waiver_packet
  if (!["after_signature", "after_physical_execution"].includes(plan?.delivery_mode) || !plan.enabled || plan.waiver_id !== waiverId || isIssuedInvoiceStatus(invoice.status) || invoice.status === "void") return
  const { data: waiver, error: waiverError } = await supabase.from("invoice_lien_waivers").select("metadata").eq("org_id", orgId).eq("id", waiverId).eq("invoice_id", invoiceId).single()
  if (waiverError) throw new Error("Could not load the waiver awaiting delivery")
  const flow = waiver && readWaiverWorkflow(waiver)
  if (!flow || flow.lifecycle !== "signed" || flow.needs_review) return
  if (plan.delivery_mode === "after_signature") {
  const { data: document, error: documentError } = await supabase.from("documents").select("metadata").eq("org_id", orgId).eq("id", flow.signing_document_id).single()
  if (documentError) throw new Error("Could not verify the waiver signer")
  if (!plan.actor_id || document?.metadata?.waiver_signer_id !== plan.signer_id || !Array.isArray(plan.recipients) || !plan.recipients.length) throw new Error("The pending invoice delivery needs review")
  } else if (!waiver?.metadata?.physical_execution?.confirmed_by || !plan.actor_id || !Array.isArray(plan.recipients) || !plan.recipients.length) {
    throw new Error("Confirm the executed waiver before delivery")
  }
  const { data: org, error: orgError } = await supabase.from("orgs").select("product_tier").eq("id", orgId).single()
  if (orgError || !org) throw new Error("Could not load the invoice organization")
  // Rechecks the original preparer's permission, invoice approval, current content, and signed packet.
  await issueInvoiceWithContext({ supabase, orgId, userId: plan.actor_id, productTier: normalizeProductTier(org?.product_tier) }, { invoiceId, recipients: plan.recipients })
}
