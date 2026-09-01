import { invoiceHref } from "@/lib/financials/invoice-destinations"
import "server-only"

import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { requireOrgContext } from "@/lib/services/context"
import { authorize } from "@/lib/services/authorization"
import { listInvoices } from "@/lib/services/invoices"
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
  attribution_basis: "project_client_contact"
  contract_value_cents: number
  invoiced_cents: number
  collected_cents: number
  outstanding_cents: number
  invoice_count: number
  can_view_invoices: boolean
  can_view_books: boolean
  projects: PartyReceivableProject[]
  activity: PartyFinancialActivity[]
}

export interface PartyFinancialActivity {
  id: string
  kind: "invoice" | "payment" | "credit_memo" | "write_off"
  occurred_at: string
  label: string
  detail: string
  amount_cents: number
  project_id: string
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
        const invoices = await listInvoices({ orgId: context.orgId, projectId: project.id })
        return { projectId: project.id, invoices, canViewInvoices: true }
      } catch {
        return { projectId: project.id, invoices: [], canViewInvoices: false }
      }
    }),
  )
  const readableInvoices = invoiceResults.flatMap((result) => result.invoices)
  const invoiceIds = readableInvoices.map((invoice) => invoice.id)
  const canViewBooks = (await authorize({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })).allowed
  const service = createServiceSupabaseClient()
  const [paymentResult, adjustmentResult] = invoiceIds.length === 0
    ? [{ data: [], error: null }, { data: [], error: null }]
    : await Promise.all([
        service.from("payments").select("id,invoice_id,amount_cents,status,received_at,method,reference").eq("org_id", context.orgId).in("invoice_id", invoiceIds).in("status", ["succeeded", "completed", "paid"]),
        service.from("receivable_adjustments").select("id,invoice_id,adjustment_type,status,amount_cents,effective_date,reason,created_at,voided_at").eq("org_id", context.orgId).in("invoice_id", invoiceIds),
      ])
  if (paymentResult.error) throw new Error(`Unable to load party payments: ${paymentResult.error.message}`)
  if (adjustmentResult.error) throw new Error(`Unable to load party credits: ${adjustmentResult.error.message}`)
  const invoicesByProject = new Map(invoiceResults.map((result) => [result.projectId, result]))
  const billed = new Set<string>(BILLED_INVOICE_STATUSES)
  const projects = visibleProjects.map((project) => {
    const invoices = (invoicesByProject.get(project.id)?.invoices ?? []).filter((invoice) =>
      billed.has(String(invoice.status)),
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
      collected_cents: Math.max(0, invoiced - outstanding),
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
    if (!project) continue
    activity.push({ id: `invoice:${invoice.id}`, kind: "invoice", occurred_at: invoice.issue_date ?? invoice.sent_at ?? invoice.updated_at ?? invoice.created_at ?? "1970-01-01", label: `Invoice ${invoice.invoice_number ?? ""}`.trim(), detail: invoice.title || project.name, amount_cents: Number(invoice.total_cents ?? 0), project_id: project.id, project_name: project.name, invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project.id), journal_entry_id: null })
  }
  for (const payment of paymentResult.data ?? []) {
    const invoice = invoiceById.get(payment.invoice_id)
    const project = invoice ? projectById.get(String(invoice.project_id)) : null
    if (!invoice || !project) continue
    activity.push({ id: `payment:${payment.id}`, kind: "payment", occurred_at: payment.received_at, label: "Payment received", detail: payment.reference || payment.method || invoice.invoice_number || "Invoice payment", amount_cents: Number(payment.amount_cents), project_id: project.id, project_name: project.name, invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project.id), journal_entry_id: null })
  }
  for (const adjustment of adjustmentResult.data ?? []) {
    const invoice = invoiceById.get(adjustment.invoice_id)
    const project = invoice ? projectById.get(String(invoice.project_id)) : null
    if (!invoice || !project) continue
    activity.push({ id: `adjustment:${adjustment.id}`, kind: adjustment.adjustment_type as "credit_memo" | "write_off", occurred_at: adjustment.voided_at ?? adjustment.effective_date ?? adjustment.created_at, label: `${adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"}${adjustment.status === "void" ? " voided" : ""}`, detail: adjustment.reason, amount_cents: adjustment.status === "void" ? 0 : -Number(adjustment.amount_cents), project_id: project.id, project_name: project.name, invoice_id: invoice.id, source_href: invoiceHref(invoice.id, project.id), journal_entry_id: null })
  }
  if (canViewBooks && activity.length > 0) {
    const sourceIds = activity.map((row) => row.id.split(":")[1])
    const { data: journals } = await service.from("journal_entries").select("id,source_id").eq("org_id", context.orgId).eq("status", "posted").in("source_id", sourceIds).order("created_at", { ascending: false })
    const journalBySource = new Map((journals ?? []).map((journal) => [journal.source_id, journal.id]))
    for (const row of activity) row.journal_entry_id = journalBySource.get(row.id.split(":")[1]) ?? null
  }
  activity.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))

  return {
    party_type: input.partyType,
    party_id: input.partyId,
    included_contact_ids: contactIds,
    attribution_basis: "project_client_contact",
    contract_value_cents: projects.reduce((sum, project) => sum + project.contract_value_cents, 0),
    invoiced_cents: projects.reduce((sum, project) => sum + project.invoiced_cents, 0),
    collected_cents: projects.reduce((sum, project) => sum + project.collected_cents, 0),
    outstanding_cents: projects.reduce((sum, project) => sum + project.outstanding_cents, 0),
    invoice_count: projects.reduce((sum, project) => sum + project.invoice_count, 0),
    can_view_invoices: invoiceResults.every((result) => result.canViewInvoices),
    can_view_books: canViewBooks,
    projects,
    activity,
  }
}
