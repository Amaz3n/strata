import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import {
  applyProjectIdScope,
  applyReportingExclusion,
  getReportingExcludedProjectIds,
} from "@/lib/services/reporting-scope"

export interface ReadyToBillProject {
  projectId: string
  projectName: string
  count: number
  totalCents: number
  aging0To30Cents: number
  aging31To60Cents: number
  aging61PlusCents: number
  oldestAgeDays: number
  href: string
}

export interface OutstandingInvoiceRow {
  id: string
  projectId: string | null
  projectName: string
  invoiceNumber: string
  title: string
  status: string
  dueDate: string | null
  balanceDueCents: number
  href: string
}

export interface OrgBillingDeskData {
  readyToBill: ReadyToBillProject[]
  outstandingInvoices: OutstandingInvoiceRow[]
  stats: {
    readyToBillCount: number
    readyToBillCents: number
    aging0To30Cents: number
    aging31To60Cents: number
    aging61PlusCents: number
    outstandingArCents: number
    retainageHeldCents: number
  }
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function daysOld(value?: string | null) {
  if (!value) return 0
  const then = new Date(`${value}T00:00:00.000Z`).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

const FIXED_PRICE_MODEL = "fixed_price"

interface ProjectMeta {
  name: string
  contractTotalCents: number
}

async function loadProjectMeta(
  supabase: any,
  orgId: string,
  projectIds: string[],
): Promise<Map<string, ProjectMeta>> {
  if (projectIds.length === 0) return new Map<string, ProjectMeta>()
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, total_contract_value_cents")
    .eq("org_id", orgId)
    .in("id", projectIds)
  if (error) return new Map<string, ProjectMeta>()
  return new Map(
    (data ?? []).map((project: any) => [
      project.id as string,
      {
        name: String(project.name ?? "Project"),
        contractTotalCents: Number(project.total_contract_value_cents ?? 0),
      } satisfies ProjectMeta,
    ]),
  )
}

async function loadBillingModels(
  supabase: any,
  orgId: string,
  projectIds: string[],
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map<string, string>()
  const { data, error } = await supabase
    .from("project_financial_settings")
    .select("project_id, billing_model")
    .eq("org_id", orgId)
    .in("project_id", projectIds)
  if (error) return new Map<string, string>()
  return new Map(
    (data ?? [])
      .filter((row: any) => row.billing_model)
      .map((row: any) => [row.project_id as string, String(row.billing_model)]),
  )
}

// Fixed-price draws bill either a flat amount or a % of the contract sum.
function drawAmountCents(row: any, contractTotalCents: number): number {
  const explicit = Number(row.amount_cents ?? 0)
  if (explicit > 0) return explicit
  const percent = Number(row.percent_of_contract ?? 0)
  if (percent > 0 && contractTotalCents > 0) return Math.round((percent / 100) * contractTotalCents)
  return 0
}

async function loadRetainageHeldCents(
  supabase: any,
  orgId: string,
  projectIds: string[] | null,
  excludedProjectIds: string[],
) {
  let query = supabase
    .from("retainage")
    .select("amount_cents")
    .eq("org_id", orgId)
    .eq("status", "held")
  query = applyReportingExclusion(query, excludedProjectIds)
  query = applyProjectIdScope(query, projectIds)
  const { data, error } = await query

  if (error) return 0
  return (data ?? []).reduce((sum: number, row: any) => sum + Number(row.amount_cents ?? 0), 0)
}

export async function loadOrgBillingDeskData(projectIds: string[] | null = null): Promise<OrgBillingDeskData> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    supabase,
    logDecision: true,
    resourceType: "billing_desk",
  })

  const today = new Date().toISOString().split("T")[0]
  const excludedProjectIds = projectIds === null ? [] : await getReportingExcludedProjectIds(supabase, orgId)
  let costsQuery = supabase
    .from("billable_costs")
    .select("project_id, billable_cents, occurred_on")
    .eq("org_id", orgId)
    .eq("status", "open")
    .eq("is_billable", true)
    .order("occurred_on", { ascending: true })
    .limit(2000)
  let drawsQuery = supabase
    .from("draw_schedules")
    .select("project_id, amount_cents, percent_of_contract, due_date")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true })
    .limit(2000)
  let invoicesQuery = supabase
    .from("invoices")
    .select("id, project_id, invoice_number, title, status, due_date, balance_due_cents, project:projects(id, name)")
    .eq("org_id", orgId)
    .in("status", ["sent", "partial", "overdue"])
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(100)
  costsQuery = applyProjectIdScope(applyReportingExclusion(costsQuery, excludedProjectIds), projectIds)
  drawsQuery = applyProjectIdScope(applyReportingExclusion(drawsQuery, excludedProjectIds), projectIds)
  invoicesQuery = applyProjectIdScope(applyReportingExclusion(invoicesQuery, excludedProjectIds), projectIds)

  const [costsResult, drawsResult, invoicesResult, retainageHeldCents] = await Promise.all([
    costsQuery,
    drawsQuery,
    invoicesQuery,
    loadRetainageHeldCents(supabase, orgId, projectIds, excludedProjectIds),
  ])

  if (costsResult.error) throw new Error(`Failed to load ready-to-bill costs: ${costsResult.error.message}`)
  if (drawsResult.error) throw new Error(`Failed to load due draws: ${drawsResult.error.message}`)
  if (invoicesResult.error) throw new Error(`Failed to load outstanding invoices: ${invoicesResult.error.message}`)

  const asProjectId = (id: unknown): id is string => typeof id === "string"
  const costProjectIds = (costsResult.data ?? []).map((row: any) => row.project_id).filter(asProjectId)
  const drawProjectIds = (drawsResult.data ?? []).map((row: any) => row.project_id).filter(asProjectId)
  const involvedProjectIds = Array.from(new Set<string>([...costProjectIds, ...drawProjectIds]))

  const [projectMeta, billingModels] = await Promise.all([
    loadProjectMeta(supabase, orgId, involvedProjectIds),
    loadBillingModels(supabase, orgId, involvedProjectIds),
  ])

  // A project bills by draws (fixed price) when its model says so, or when it
  // actually has due draws — draws only exist on fixed-price contracts. Those
  // projects' job costs are internal, never client-billable, so we skip them.
  const drawProjectIdSet = new Set(drawProjectIds)
  const billsByDraws = (projectId: string) =>
    billingModels.get(projectId) === FIXED_PRICE_MODEL || drawProjectIdSet.has(projectId)

  const readyByProject = new Map<string, ReadyToBillProject>()
  const addReady = (projectId: string, amount: number, age: number, hrefPath: string) => {
    if (amount <= 0) return
    const existing =
      readyByProject.get(projectId) ??
      {
        projectId,
        projectName: projectMeta.get(projectId)?.name ?? "Project",
        count: 0,
        totalCents: 0,
        aging0To30Cents: 0,
        aging31To60Cents: 0,
        aging61PlusCents: 0,
        oldestAgeDays: 0,
        href: `/projects/${projectId}/financials/${hrefPath}`,
      }
    existing.count += 1
    existing.totalCents += amount
    existing.oldestAgeDays = Math.max(existing.oldestAgeDays, age)
    if (age <= 30) existing.aging0To30Cents += amount
    else if (age <= 60) existing.aging31To60Cents += amount
    else existing.aging61PlusCents += amount
    readyByProject.set(projectId, existing)
  }

  for (const row of costsResult.data ?? []) {
    const projectId = row.project_id as string | null
    if (!projectId || billsByDraws(projectId)) continue
    addReady(projectId, Number(row.billable_cents ?? 0), daysOld(row.occurred_on), "review")
  }

  for (const row of drawsResult.data ?? []) {
    const projectId = row.project_id as string | null
    if (!projectId) continue
    const amount = drawAmountCents(row, projectMeta.get(projectId)?.contractTotalCents ?? 0)
    addReady(projectId, amount, daysOld(row.due_date), "receivables")
  }

  const readyToBill = Array.from(readyByProject.values()).sort((a, b) => b.totalCents - a.totalCents)
  const outstandingInvoices = (invoicesResult.data ?? []).map((row: any) => {
    const project = one(row.project)
    const projectId = (row.project_id as string | null) ?? null
    return {
      id: row.id,
      projectId,
      projectName: project?.name ? String(project.name) : "Project",
      invoiceNumber: String(row.invoice_number ?? "Draft"),
      title: String(row.title ?? "Invoice"),
      status: String(row.status ?? "sent"),
      dueDate: row.due_date ?? null,
      balanceDueCents: Number(row.balance_due_cents ?? 0),
      href: projectId ? `/projects/${projectId}/financials/receivables?invoice=${row.id}` : "/billing",
    } satisfies OutstandingInvoiceRow
  })

  return {
    readyToBill,
    outstandingInvoices,
    stats: {
      readyToBillCount: readyToBill.reduce((sum, project) => sum + project.count, 0),
      readyToBillCents: readyToBill.reduce((sum, project) => sum + project.totalCents, 0),
      aging0To30Cents: readyToBill.reduce((sum, project) => sum + project.aging0To30Cents, 0),
      aging31To60Cents: readyToBill.reduce((sum, project) => sum + project.aging31To60Cents, 0),
      aging61PlusCents: readyToBill.reduce((sum, project) => sum + project.aging61PlusCents, 0),
      outstandingArCents: outstandingInvoices.reduce((sum, invoice) => sum + invoice.balanceDueCents, 0),
      retainageHeldCents,
    },
  }
}
