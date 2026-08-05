import "server-only"

import type {
  AccountingDimensionValue,
  AccountingProvider,
  PushResult,
} from "@/lib/integrations/accounting/provider"
import { isAccountingBatchFormat, type AccountingBatchFormat } from "@/lib/integrations/accounting/file/formats"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * A file target: Sage 300 CRE, Foundation, Viewpoint Vista.
 *
 * "Pushing" here means accruing a line into the connection's open batch, which a
 * controller exports and imports on their side. That is not a lesser integration
 * — it is how AP actually reaches those systems, none of which offers a usable
 * push API in the field. It is also why the commercial and production postures
 * could not use the AP rail at all while QuickBooks was the only implementation.
 *
 * Every push is idempotent on (connection, entity, direction), which is what
 * makes the outbox's at-least-once delivery safe against a target that cannot be
 * asked "did you already receive this?".
 */

interface BatchLineInput {
  orgId: string
  connectionId: string
  projectId: string | null
  entityType: "invoice" | "payment" | "project_expense" | "bill" | "bill_payment" | "journal"
  entityId: string
  direction: "post" | "reverse"
  amountCents: number
  currency: string
  postedAt: string
  memo: string | null
  payload: Record<string, unknown>
}

async function connectionFormat(connectionId: string): Promise<AccountingBatchFormat> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("accounting_connections").select("settings").eq("id", connectionId).maybeSingle()
  if (error) throw new Error(`Unable to load accounting connection: ${error.message}`)
  const configured = (data?.settings as Record<string, unknown> | null)?.batch_format
  // An unconfigured connection falls back to the widest layout rather than
  // guessing a specific ERP's columns and dropping fields it needed.
  return isAccountingBatchFormat(configured) ? configured : "generic"
}

async function appendLine(input: BatchLineInput): Promise<PushResult> {
  const supabase = createServiceSupabaseClient()
  const format = await connectionFormat(input.connectionId)
  const { data, error } = await supabase.rpc("append_accounting_batch_line_atomic", {
    p_org_id: input.orgId,
    p_connection_id: input.connectionId,
    p_format: format,
    p_project_id: input.projectId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_direction: input.direction,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
    p_posted_at: input.postedAt,
    p_memo: input.memo,
    p_payload: input.payload,
  })
  if (error || !data) throw new Error(`Unable to record accounting batch line: ${error?.message ?? "no line returned"}`)
  const line = data as Record<string, unknown>
  const id = typeof line.id === "string" ? line.id : null
  if (!id) throw new Error("Accounting batch line was written without an id")
  return { externalId: id }
}

/**
 * The shared shape every AP record carries into a batch. Job, cost code and cost
 * type are what make a construction AP import land on the right job rather than
 * in an uncoded suspense account, so they are resolved here rather than left to
 * each format.
 */
async function loadVendorBillContext(orgId: string, billId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("vendor_bills")
    .select("id,project_id,bill_number,bill_date,due_date,total_cents,currency,company_id,company:companies(name),project:projects(name),cost_code:cost_codes(code,cost_type)")
    .eq("org_id", orgId)
    .eq("id", billId)
    .maybeSingle()
  if (error || !data) throw new Error(error?.message ?? "Vendor bill not found for accounting batch")
  const company = Array.isArray(data.company) ? data.company[0] : data.company
  const project = Array.isArray(data.project) ? data.project[0] : data.project
  const costCode = Array.isArray(data.cost_code) ? data.cost_code[0] : data.cost_code
  return {
    row: data,
    payload: {
      arc_reference: data.id,
      vendor_name: company?.name ?? "",
      document_number: data.bill_number ?? "",
      due_date: data.due_date ?? "",
      job_name: project?.name ?? "",
      cost_code: costCode?.code ?? "",
      cost_type: costCode?.cost_type ?? "",
    } satisfies Record<string, unknown>,
  }
}

async function loadPaymentContext(orgId: string, paymentId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payments")
    .select("id,project_id,bill_id,amount_cents,currency,method,reference,received_at,bill:vendor_bills(bill_number,company_id,company:companies(name)),project:projects(name)")
    .eq("org_id", orgId)
    .eq("id", paymentId)
    .maybeSingle()
  if (error || !data) throw new Error(error?.message ?? "Payment not found for accounting batch")
  const bill = Array.isArray(data.bill) ? data.bill[0] : data.bill
  const billCompany = bill ? (Array.isArray(bill.company) ? bill.company[0] : bill.company) : null
  const project = Array.isArray(data.project) ? data.project[0] : data.project
  return {
    row: data,
    payload: {
      arc_reference: data.id,
      vendor_name: billCompany?.name ?? "",
      document_number: bill?.bill_number ?? data.reference ?? "",
      job_name: project?.name ?? "",
      payment_method: data.method ?? "",
    } satisfies Record<string, unknown>,
  }
}

function unsupported(operation: string): never {
  throw new Error(`A file-based accounting target does not support ${operation}`)
}

export const fileProvider: AccountingProvider = {
  key: "file",
  capabilities: {
    supportsClasses: false,
    supportsLocations: false,
    supportsDepartments: false,
    supportsSubCustomers: false,
    supportsInvoiceNumberReservation: false,
    supportsInvoiceDocNumberSync: false,
    supportsCDC: false,
    supportsWebhooks: false,
    supportsAttachments: false,
    supportsJournalEntryPush: true,
    supportsVendorCredits: true,
    // A batch cannot be un-imported, so a reversal is a new negative line rather
    // than an edit of the original. That is a supported reversal, not a missing
    // one — the controller imports the correction the same way they imported the
    // payment.
    supportsBillPaymentVoid: true,
    updateConcurrency: "none",
    dimensions: [],
  },
  async ensureHealthy() {
    // Nothing to reach. A file connection cannot expire or lose credentials, so
    // reporting anything but healthy would be inventing a failure mode.
    return { ok: true }
  },
  async disconnect() {
    // Local lifecycle only; there is no remote side to revoke.
  },
  async pushInvoice(input) {
    const supabase = createServiceSupabaseClient()
    const { data, error } = await supabase
      .from("invoices")
      .select("id,project_id,invoice_number,issue_date,total_cents,currency,project:projects(name)")
      .eq("org_id", input.orgId).eq("id", input.invoiceId).maybeSingle()
    if (error || !data) throw new Error(error?.message ?? "Invoice not found for accounting batch")
    const project = Array.isArray(data.project) ? data.project[0] : data.project
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: data.project_id,
      entityType: "invoice",
      entityId: data.id,
      direction: "post",
      amountCents: Number(data.total_cents ?? 0),
      currency: String(data.currency ?? "usd"),
      postedAt: data.issue_date ?? new Date().toISOString(),
      memo: data.invoice_number ? `Invoice ${data.invoice_number}` : null,
      payload: {
        arc_reference: data.id,
        document_number: data.invoice_number ?? "",
        job_name: project?.name ?? "",
      },
    })
  },
  async pushPayment(input) {
    const { row, payload } = await loadPaymentContext(input.orgId, input.paymentId)
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: row.project_id,
      entityType: "payment",
      entityId: row.id,
      direction: "post",
      amountCents: Number(row.amount_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      postedAt: row.received_at ?? new Date().toISOString(),
      memo: row.reference ?? null,
      payload,
    })
  },
  async pushExpense(input) {
    const supabase = createServiceSupabaseClient()
    const { data, error } = await supabase
      .from("project_expenses")
      .select("id,project_id,amount_cents,description,expense_date,project:projects(name),cost_code:cost_codes(code,cost_type)")
      .eq("org_id", input.orgId).eq("id", input.expenseId).maybeSingle()
    if (error || !data) throw new Error(error?.message ?? "Expense not found for accounting batch")
    const project = Array.isArray(data.project) ? data.project[0] : data.project
    const costCode = Array.isArray(data.cost_code) ? data.cost_code[0] : data.cost_code
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: data.project_id,
      entityType: "project_expense",
      entityId: data.id,
      direction: "post",
      amountCents: Number(data.amount_cents ?? 0),
      // project_expenses carries no currency column; the org's ledger is USD.
      currency: "usd",
      postedAt: data.expense_date ?? new Date().toISOString(),
      memo: data.description ?? null,
      payload: {
        arc_reference: data.id,
        job_name: project?.name ?? "",
        cost_code: costCode?.code ?? "",
        cost_type: costCode?.cost_type ?? "",
      },
    })
  },
  async pushVendorBill(input) {
    const { row, payload } = await loadVendorBillContext(input.orgId, input.billId)
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: row.project_id,
      entityType: "bill",
      entityId: row.id,
      direction: "post",
      amountCents: Number(row.total_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      postedAt: row.bill_date ?? new Date().toISOString(),
      memo: row.bill_number ? `Vendor invoice ${row.bill_number}` : null,
      payload,
    })
  },
  async pushVendorCredit(input) {
    const { row, payload } = await loadVendorBillContext(input.orgId, input.creditId)
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: row.project_id,
      entityType: "bill",
      entityId: row.id,
      direction: "reverse",
      amountCents: Number(row.total_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      postedAt: row.bill_date ?? new Date().toISOString(),
      memo: row.bill_number ? `Vendor credit ${row.bill_number}` : "Vendor credit",
      payload,
    })
  },
  async pushBillPayment(input) {
    const { row, payload } = await loadPaymentContext(input.orgId, input.paymentId)
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: row.project_id,
      entityType: "bill_payment",
      entityId: row.id,
      direction: "post",
      amountCents: Number(row.amount_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      postedAt: row.received_at ?? new Date().toISOString(),
      memo: row.reference ?? null,
      payload,
    })
  },
  async voidBillPayment(input) {
    const { row, payload } = await loadPaymentContext(input.orgId, input.paymentId)
    return appendLine({
      orgId: input.orgId,
      connectionId: input.connectionId,
      projectId: row.project_id,
      entityType: "bill_payment",
      entityId: row.id,
      direction: "reverse",
      amountCents: Number(row.amount_cents ?? 0),
      currency: String(row.currency ?? "usd"),
      postedAt: new Date().toISOString(),
      memo: `Reversed: ${input.reason}`,
      payload,
    })
  },
  async listDimensionValues(): Promise<AccountingDimensionValue[]> {
    // Dimensions live in the customer's ERP and Arc cannot read them. Returning
    // nothing is honest; the batch carries job and cost-code strings instead.
    return []
  },
  async listAccounts(): Promise<AccountingDimensionValue[]> {
    return []
  },
  async searchCounterparties() {
    return unsupported("counterparty search")
  },
  /**
   * There is no remote vendor list to reconcile against, so the counterparty is
   * simply the Arc company. Returning its own id keeps callers that expect a
   * resolved reference working, and the batch carries the name the controller
   * maps on import.
   */
  async resolveCounterparty(input) {
    return { id: input.companyId ?? input.displayName, name: input.displayName }
  },
}
