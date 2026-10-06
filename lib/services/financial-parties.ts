import { invoiceHref } from "@/lib/financials/invoice-destinations"
import "server-only"

import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { requireOrgContext } from "@/lib/services/context"
import { authorize } from "@/lib/services/authorization"
import { listInvoicePage, type ListInvoicesOptions } from "@/lib/services/invoices"
import { requireAnyPermission } from "@/lib/services/permissions"
import { listProjects } from "@/lib/services/projects"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type FinancialPartyType = "contact" | "company"

export interface PartyReceivableProject {
  project_id: string
  project_name: string
  client_contact_id: string
  contract_value_cents: number
  invoiced_cents: number
  collected_cents: number
  outstanding_cents: number
  invoice_count: number
  last_activity?: string
}

export interface PartyReceivablesSummary {
  party_type: FinancialPartyType
  party_id: string
  included_contact_ids: string[]
  attribution_basis: "project_client_contact_and_general_customer"
  contract_value_cents: number
  invoiced_cents: number
  collected_cents: number
  outstanding_cents: number
  invoice_count: number
  can_view_invoices: boolean
  can_view_books: boolean
  open_invoices: Array<{ id: string; number: string; project_name: string; issue_date: string | null; due_date: string | null; total_cents: number; balance_cents: number }>
  available_deposit_cents: number
  general_billing: { invoiced_cents: number; collected_cents: number; outstanding_cents: number; invoice_count: number }
  projects: PartyReceivableProject[]
  activity: PartyFinancialActivity[]
}

export interface PartyFinancialActivity {
  id: string
  kind: "invoice" | "payment" | "credit_memo" | "write_off" | "refund" | "deposit_request" | "deposit_application"
  occurred_at: string
  label: string
  detail: string
  amount_cents: number
  project_id: string | null
  project_name: string
  invoice_id: string
  source_href: string
  journal_entry_id: string | null
}

function cents(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100)
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""))
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
  }
  return 0
}

function latest(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)
}

async function listPartyInvoices(options: ListInvoicesOptions) {
  const invoices: Awaited<ReturnType<typeof listInvoicePage>>["invoices"] = []
  for (let offset = 0; ; offset += 500) {
    const page = await listInvoicePage({ ...options, offset, limit: 500 })
    invoices.push(...page.invoices)
    if (!page.hasMore) return invoices
  }
}

async function resolvePartyContactIds(input: {
  partyType: FinancialPartyType
  partyId: string
  orgId: string
}) {
  const context = await requireOrgContext(input.orgId)
  if (input.partyType === "contact") {
    const { data, error } = await context.supabase
      .from("contacts")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("id", input.partyId)
      .maybeSingle()
    if (error || !data) throw new Error("Contact not found")
    return [String(data.id)]
  }

  const [{ data: company, error: companyError }, { data: links, error: linkError }, { data: primary, error: primaryError }] =
    await Promise.all([
      context.supabase
        .from("companies")
        .select("id")
        .eq("org_id", input.orgId)
        .eq("id", input.partyId)
        .maybeSingle(),
      context.supabase
        .from("contact_company_links")
        .select("contact_id")
        .eq("org_id", input.orgId)
        .eq("company_id", input.partyId),
      context.supabase
        .from("contacts")
        .select("id")
        .eq("org_id", input.orgId)
        .eq("primary_company_id", input.partyId),
    ])
  if (companyError || !company) throw new Error("Company not found")
  if (linkError || primaryError) throw new Error("Unable to resolve the company’s client contacts")
  return Array.from(
    new Set([
      ...(links ?? []).map((row) => String(row.contact_id)),
      ...(primary ?? []).map((row) => String(row.id)),
    ]),
  )
}

/**
 * One receivable attribution contract for both people and companies.
 *
 * Projects own the client relationship through `projects.client_id`; invoices
 * inherit that relationship through their project. A company includes the union
 * of its linked contacts, de-duplicated before any project is counted. This is
 * deliberately not an invoice-metadata union: doing both would count the same
 * invoice once under its project contact and again under a company label.
 */
export async function getFinancialPartyReceivables(input: {
  partyType: FinancialPartyType
  partyId: string
  orgId?: string
}): Promise<PartyReceivablesSummary> {
  const context = await requireOrgContext(input.orgId)
  await requireAnyPermission(["org.member", "org.read", "directory.read", "directory.write"], {
    supabase: context.supabase,
    orgId: context.orgId,
    userId: context.userId,
  })
  const contactIds = await resolvePartyContactIds({
    partyType: input.partyType,
    partyId: input.partyId,
    orgId: context.orgId,
  })
  const contactSet = new Set(contactIds)
  const visibleProjects = (await listProjects(context.orgId, context)).filter(
    (project) => project.client_id && contactSet.has(project.client_id),
  )

  const invoiceResults = await Promise.all(
    visibleProjects.map(async (project) => {
      try {
        const invoices = await listPartyInvoices({ orgId: context.orgId, projectId: project.id })
        return { projectId: project.id, invoices, canViewInvoices: true }
      } catch {
        return { projectId: project.id, invoices: [], canViewInvoices: false }
      }
    }),
  )
  // Only invoices WITHOUT a project use the explicit billing contact. A project's
  // invoices continue to belong to its client, even if their bill-to text differs.
  const generalResult = await listPartyInvoices({ orgId: context.orgId, generalCustomerIds: contactIds })
    .then(invoices => ({ invoices, canViewInvoices: true }), () => ({ invoices: [], canViewInvoices: false }))
  const readableInvoices = [...invoiceResults.flatMap((result) => result.invoices), ...generalResult.invoices]
  const invoiceIds = readableInvoices.map((invoice) => invoice.id)
  const canViewBooks = (await authorize({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })).allowed
  const service = createServiceSupabaseClient()
  const [paymentResult, adjustmentResult] = invoiceIds.length === 0
    ? [{ data: [], error: null }, { data: [], error: null }]
    : await Promise.all([
        service.from("payments").select("id,invoice_id,amount_cents,status,received_at,method,reference,metadata,payment_reversals(id,amount_cents,status,created_at,reversal_type,reason)").eq("org_id", context.orgId).in("invoice_id", invoiceIds).in("status", ["succeeded", "completed", "paid", "refunded"]),
        service.from("receivable_adjustments").select("id,invoice_id,adjustment_type,status,amount_cents,effective_date,reason,created_at,voided_at").eq("org_id", context.orgId).in("invoice_id", invoiceIds),
      ])
  if (paymentResult.error) throw new Error(`Unable to load party payments: ${paymentResult.error.message}`)
  if (adjustmentResult.error) throw new Error(`Unable to load party credits: ${adjustmentResult.error.message}`)
  const netCollected = (invoiceIds: Set<string>) => (paymentResult.data ?? [])
    .filter(payment => invoiceIds.has(payment.invoice_id) && !payment.metadata?.customer_deposit_application)
    .reduce((sum, payment) => sum + Number(payment.amount_cents) - (payment.payment_reversals ?? [])
      .filter((reversal: any) => ["pending", "succeeded"].includes(reversal.status))
      .reduce((total: number, reversal: any) => total + Number(reversal.amount_cents), 0), 0)
  const invoicesByProject = new Map(invoiceResults.map((result) => [result.projectId, result]))
  const billed = new Set<string>(BILLED_INVOICE_STATUSES)
  const projects = visibleProjects.map((project) => {
    const invoices = (invoicesByProject.get(project.id)?.invoices ?? []).filter((invoice) =>
      billed.has(String(invoice.status)) && invoice.metadata?.invoice_kind !== "earnest_deposit",
    )
    const contractValue =
      project.billing_contract?.total_cents ??
      project.total_contract_value_cents ??
      cents(project.total_value)
    const invoiced = invoices.reduce((sum, invoice) => sum + Number(invoice.total_cents ?? 0), 0)
    const outstanding = invoices.reduce(
      (sum, invoice) =>
        sum + Number(invoice.balance_due_cents ?? (invoice.status === "paid" ? 0 : invoice.total_cents ?? 0)),
      0,
    )
    return {
      project_id: project.id,
      project_name: project.name,
      client_contact_id: String(project.client_id),
      contract_value_cents: contractValue,
      invoiced_cents: invoiced,
      collected_cents: netCollected(new Set((invoicesByProject.get(project.id)?.invoices ?? []).filter(invoice => billed.has(String(invoice.status))).map(invoice => invoice.id))),
      outstanding_cents: Math.max(0, outstanding),
      invoice_count: invoices.length,
      last_activity: latest([
        project.updated_at,
        project.created_at,
        ...invoices.flatMap((invoice) => [invoice.updated_at, invoice.sent_at, invoice.issue_date, invoice.created_at]),
      ]),
    } satisfies PartyReceivableProject
  })
  projects.sort((left, right) => (right.last_activity ?? "").localeCompare(left.last_activity ?? ""))

  const projectById = new Map(visibleProjects.map((project) => [project.id, project]))
  const invoiceById = new Map(readableInvoices.map((invoice) => [invoice.id, invoice]))
  const activity: PartyFinancialActivity[] = []
  for (const invoice of readableInvoices.filter((row) => billed.has(String(row.status)))) {
    const project = projectById.get(String(invoice.project_id))
    activity.push({ id: `invoice:${invoice.id}`, kind: invoice.metadata?.invoice_kind === "earnest_deposit" ? "deposit_request" : "invoice", occurred_at: invoice.issue_date ?? invoice.sent_at ?? invoice.updated_at ?? invoice.created_at ?? "1970-01-01", label: `${invoice.metadata?.invoice_kind === "earnest_deposit" ? "Deposit request" : "Invoice"} ${invoice.invoice_number ?? ""}`.trim(), detail: invoice.title || project?.name || "General billing", amount_cents: Number(invoice.total_cents ?? 0), project_id: project?.id ?? null, project_name: project?.name ?? "General billing", invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project?.id), journal_entry_id: null })
  }
  for (const payment of paymentResult.data ?? []) {
    const invoice = invoiceById.get(payment.invoice_id)
    const project = invoice ? projectById.get(String(invoice.project_id)) : null
    if (!invoice) continue
    activity.push({ id: `payment:${payment.id}`, kind: payment.metadata?.customer_deposit_application ? "deposit_application" : "payment", occurred_at: payment.received_at, label: payment.metadata?.customer_deposit_application ? "Deposit applied" : invoice.metadata?.invoice_kind === "earnest_deposit" ? "Deposit received" : "Payment received", detail: payment.reference || payment.method || invoice.invoice_number || "Invoice payment", amount_cents: Number(payment.amount_cents), project_id: project?.id ?? null, project_name: project?.name ?? "General billing", invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project?.id), journal_entry_id: null })
  }
  for (const payment of paymentResult.data ?? []) {
    const invoice = invoiceById.get(payment.invoice_id)
    if (!invoice) continue
    const project = projectById.get(String(invoice.project_id))
    for (const reversal of payment.payment_reversals ?? []) {
      if (!["pending", "succeeded"].includes(reversal.status)) continue
      activity.push({ id: `reversal:${reversal.id}`, kind: "refund", occurred_at: reversal.created_at, label: reversal.reversal_type === "refund" ? "Refund" : "Payment reversed", detail: reversal.reason || invoice.invoice_number || "Payment reversal", amount_cents: -Number(reversal.amount_cents), project_id: project?.id ?? null, project_name: project?.name ?? "General billing", invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project?.id), journal_entry_id: null })
    }
  }
  for (const adjustment of adjustmentResult.data ?? []) {
    const invoice = invoiceById.get(adjustment.invoice_id)
    const project = invoice ? projectById.get(String(invoice.project_id)) : null
    if (!invoice) continue
    activity.push({ id: `adjustment:${adjustment.id}`, kind: adjustment.adjustment_type as "credit_memo" | "write_off", occurred_at: adjustment.voided_at ?? adjustment.effective_date ?? adjustment.created_at, label: `${adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"}${adjustment.status === "void" ? " voided" : ""}`, detail: adjustment.reason, amount_cents: adjustment.status === "void" ? 0 : -Number(adjustment.amount_cents), project_id: project?.id ?? null, project_name: project?.name ?? "General billing", invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project?.id), journal_entry_id: null })
  }
  if (canViewBooks && activity.length > 0) {
    const sourceIds = activity.map((row) => row.id.split(":")[1])
    const { data: journals } = await service.from("journal_entries").select("id,source_id").eq("org_id", context.orgId).eq("status", "posted").in("source_id", sourceIds).order("created_at", { ascending: false })
    const journalBySource = new Map((journals ?? []).map((journal) => [journal.source_id, journal.id]))
    for (const row of activity) row.journal_entry_id = journalBySource.get(row.id.split(":")[1]) ?? null
  }
  activity.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))

  const generalBilled = generalResult.invoices.filter(invoice => billed.has(String(invoice.status)) && invoice.metadata?.invoice_kind !== "earnest_deposit")
  const depositPayments = (paymentResult.data ?? []).filter(payment => invoiceById.get(payment.invoice_id)?.metadata?.invoice_kind === "earnest_deposit")
  const availableDeposits = depositPayments.reduce((sum, payment) => {
    const refunded = (payment.payment_reversals ?? []).filter((row: any) => ["pending", "succeeded"].includes(row.status)).reduce((total: number, row: any) => total + Number(row.amount_cents), 0)
    const applied = (paymentResult.data ?? []).filter(row => row.metadata?.deposit_payment_id === payment.id).reduce((total, row) => total + Number(row.amount_cents), 0)
    return sum + Math.max(0, Number(payment.amount_cents) - refunded - applied)
  }, 0)
  return {
    party_type: input.partyType,
    party_id: input.partyId,
    included_contact_ids: contactIds,
    attribution_basis: "project_client_contact_and_general_customer",
    contract_value_cents: projects.reduce((sum, project) => sum + project.contract_value_cents, 0),
    invoiced_cents: projects.reduce((sum, project) => sum + project.invoiced_cents, 0) + generalBilled.reduce((sum, invoice) => sum + Number(invoice.total_cents ?? 0), 0),
    collected_cents: netCollected(new Set(readableInvoices.filter(invoice => billed.has(String(invoice.status))).map(invoice => invoice.id))),
    outstanding_cents: projects.reduce((sum, project) => sum + project.outstanding_cents, 0) + generalBilled.reduce((sum, invoice) => sum + Number(invoice.balance_due_cents ?? (invoice.status === "paid" ? 0 : invoice.total_cents ?? 0)), 0),
    invoice_count: projects.reduce((sum, project) => sum + project.invoice_count, 0) + generalBilled.length,
    can_view_invoices: generalResult.canViewInvoices && invoiceResults.every((result) => result.canViewInvoices),
    can_view_books: canViewBooks,
    available_deposit_cents: availableDeposits,
    general_billing: {
      invoiced_cents: generalBilled.reduce((sum, invoice) => sum + Number(invoice.total_cents ?? 0), 0),
      collected_cents: netCollected(new Set(generalResult.invoices.filter(invoice => billed.has(String(invoice.status))).map(invoice => invoice.id))),
      outstanding_cents: generalBilled.reduce((sum, invoice) => sum + Number(invoice.balance_due_cents ?? (invoice.status === "paid" ? 0 : invoice.total_cents ?? 0)), 0),
      invoice_count: generalBilled.length,
    },
    open_invoices: readableInvoices.filter(invoice => billed.has(String(invoice.status)) && invoice.metadata?.invoice_kind !== "earnest_deposit" && Number(invoice.balance_due_cents ?? 0) > 0)
      .map(invoice => ({ id: invoice.id, number: invoice.invoice_number ?? "Invoice", project_name: projectById.get(String(invoice.project_id))?.name ?? "General billing", issue_date: invoice.issue_date ?? null, due_date: invoice.due_date ?? null, total_cents: Number(invoice.total_cents ?? 0), balance_cents: Number(invoice.balance_due_cents ?? 0) })),
    projects,
    activity,
  }
}
