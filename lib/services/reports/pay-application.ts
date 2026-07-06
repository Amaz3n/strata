import { renderPayApplicationPdf, type PayApplicationPdfData } from "@/lib/pdfs/pay-application"
import { requireOrgContext } from "@/lib/services/context"

const BILLED_DRAW_STATUSES = new Set(["invoiced", "partial", "paid"])

export type DrawPayApplicationReport = {
  project_id: string
  draw_id: string
  file_name: string
  data: PayApplicationPdfData
}

function projectLocationText(location: unknown): string | null {
  if (!location) return null
  if (typeof location === "string") return location
  if (typeof location !== "object") return null

  const value = location as Record<string, unknown>
  if (typeof value.address === "string" && value.address.trim()) return value.address
  if (typeof value.formatted === "string" && value.formatted.trim()) return value.formatted

  const joined = [value.street1, value.city, value.state, value.postal_code]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(", ")
  return joined || null
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function resolveRevisedContractCents(contract: any, scheduledTotalCents: number): number {
  const snapshot = (contract?.snapshot ?? {}) as Record<string, unknown>
  return (
    numberValue(snapshot.revised_total_cents) ||
    numberValue(contract?.total_cents) ||
    scheduledTotalCents
  )
}

function resolveOriginalContractCents({
  contract,
  revisedContractCents,
  approvedChangeOrdersCents,
  scheduledTotalCents,
}: {
  contract: any
  revisedContractCents: number
  approvedChangeOrdersCents: number
  scheduledTotalCents: number
}): number {
  const snapshot = (contract?.snapshot ?? {}) as Record<string, unknown>
  const explicitOriginal =
    numberValue(snapshot.original_total_cents) ||
    numberValue(snapshot.base_contract_cents) ||
    numberValue(snapshot.contract_sum_cents)
  if (explicitOriginal > 0) return explicitOriginal

  const inferredOriginal = revisedContractCents - approvedChangeOrdersCents
  if (inferredOriginal > 0) return inferredOriginal
  return revisedContractCents || scheduledTotalCents
}

export async function getDrawPayApplicationReport({
  projectId,
  drawId,
  orgId,
}: {
  projectId: string
  drawId: string
  orgId?: string
}): Promise<DrawPayApplicationReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [
    { data: drawRows, error: drawsError },
    { data: project, error: projectError },
    { data: org, error: orgError },
  ] = await Promise.all([
    supabase
      .from("draw_schedules")
      .select("id, draw_number, title, description, amount_cents, due_date, status, invoice_id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .order("draw_number", { ascending: true }),
    supabase
      .from("projects")
      .select("name, location, client_id, qbo_customer_name")
      .eq("org_id", resolvedOrgId)
      .eq("id", projectId)
      .maybeSingle(),
    supabase.from("orgs").select("name").eq("id", resolvedOrgId).maybeSingle(),
  ])

  if (drawsError) throw new Error(`Failed to load draw schedule: ${drawsError.message}`)
  if (projectError) throw new Error(`Failed to load project: ${projectError.message}`)
  if (orgError) throw new Error(`Failed to load organization: ${orgError.message}`)

  const draws = drawRows ?? []
  const target = draws.find((draw) => draw.id === drawId)
  if (!target) throw new Error("Draw not found")
  if (!project) throw new Error("Project not found")

  const [{ data: contract }, { data: changeOrders }, clientResult, invoiceResult] = await Promise.all([
    supabase
      .from("contracts")
      .select("total_cents, retainage_percent, effective_date, signed_at, snapshot")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["active", "amended", "completed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("change_orders")
      .select("total_cents, status")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    project.client_id
      ? supabase
          .from("contacts")
          .select("full_name")
          .eq("org_id", resolvedOrgId)
          .eq("id", project.client_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { full_name?: string | null } | null }),
    target.invoice_id
      ? supabase
          .from("invoices")
          .select("invoice_number")
          .eq("org_id", resolvedOrgId)
          .eq("id", target.invoice_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { invoice_number?: string | null } | null }),
  ])

  const approvedChangeOrdersCents = (changeOrders ?? [])
    .filter((co) => String(co.status ?? "").toLowerCase() === "approved")
    .reduce((sum, co) => sum + Number(co.total_cents ?? 0), 0)

  const targetNumber = Number(target.draw_number ?? 0)
  const applicationNumber = draws.filter((draw) => Number(draw.draw_number ?? 0) <= targetNumber).length

  const lines = draws.map((draw) => {
    const drawNumber = Number(draw.draw_number ?? 0)
    const amount = Number(draw.amount_cents ?? 0)
    const isTarget = draw.id === target.id
    const previousCents =
      !isTarget && drawNumber < targetNumber && BILLED_DRAW_STATUSES.has(String(draw.status)) ? amount : 0

    return {
      itemNo: String(drawNumber || "—"),
      description: draw.title || `Draw ${drawNumber}`,
      scheduledValueCents: amount,
      previousCents,
      thisPeriodCents: isTarget ? amount : 0,
    }
  })

  const scheduledTotalCents = lines.reduce((sum, line) => sum + line.scheduledValueCents, 0)
  const revisedContractCents = resolveRevisedContractCents(contract, scheduledTotalCents)
  const originalContractCents = resolveOriginalContractCents({
    contract,
    revisedContractCents,
    approvedChangeOrdersCents,
    scheduledTotalCents,
  })

  const data: PayApplicationPdfData = {
    applicationNumber,
    applicationDateIso: new Date().toISOString(),
    periodToIso: target.due_date ?? null,
    projectName: project.name ?? "Project",
    propertyDescription: projectLocationText(project.location),
    ownerName: clientResult.data?.full_name ?? project.qbo_customer_name ?? "Owner",
    contractorName: org?.name ?? "Contractor",
    contractDateIso: contract?.signed_at ?? contract?.effective_date ?? null,
    originalContractCents,
    changeOrdersCents: approvedChangeOrdersCents,
    retainagePercent: Number(contract?.retainage_percent ?? 0),
    lines,
    invoiceNumber: invoiceResult.data?.invoice_number ?? null,
  }

  return {
    project_id: projectId,
    draw_id: drawId,
    file_name: `pay-application-${applicationNumber}-draw-${targetNumber}.pdf`,
    data,
  }
}

export async function generateDrawPayApplicationPdf(args: {
  projectId: string
  drawId: string
  orgId?: string
}): Promise<{ fileName: string; pdf: Buffer; report: DrawPayApplicationReport }> {
  const report = await getDrawPayApplicationReport(args)
  const pdf = await renderPayApplicationPdf(report.data)
  return { fileName: report.file_name, pdf, report }
}
