import { renderSovPayApplicationPdf, type SovPayAppPdfData, type SovPayAppPdfLine } from "@/lib/pdfs/pay-application-g702"
import { normalizeRetainageSchedule, resolveRetainageRatePercent } from "@/lib/financials/pay-app-math"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { createFileRecord } from "@/lib/services/files"
import { attachFile } from "@/lib/services/file-links"
import { createInitialVersion } from "@/lib/services/file-versions"
import { uploadFilesObject } from "@/lib/storage/files-storage"

export type SovPayApplicationReport = {
  project_id: string
  pay_application_id: string
  file_name: string
  data: SovPayAppPdfData
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

export async function getSovPayApplicationReport({
  projectId,
  payApplicationId,
  orgId,
}: {
  projectId: string
  payApplicationId: string
  orgId?: string
}): Promise<SovPayApplicationReport> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "report.read")

  const { data: app, error: appError } = await supabase
    .from("pay_applications")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("id", payApplicationId)
    .maybeSingle()
  if (appError) throw new Error(`Failed to load pay application: ${appError.message}`)
  if (!app) throw new Error("Pay application not found")
  if (app.status === "draft") throw new Error("Submit the pay application before generating its PDF")

  const [
    { data: lineRows, error: linesError },
    { data: sovRows, error: sovError },
    { data: project, error: projectError },
    { data: org, error: orgError },
    { data: contract },
    { data: changeOrders },
  ] = await Promise.all([
    supabase
      .from("pay_application_lines")
      .select("prime_sov_line_id, scheduled_value_cents, previous_billed_cents, this_period_cents, stored_materials_cents, retainage_cents")
      .eq("org_id", resolvedOrgId)
      .eq("pay_application_id", payApplicationId),
    supabase
      .from("prime_sov_lines")
      .select("id, line_number, description, stored_materials_cents, retainage_held_cents, retainage_released_cents, previous_billed_cents")
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", app.contract_id),
    supabase
      .from("projects")
      .select("name, location, client_id, qbo_customer_name")
      .eq("org_id", resolvedOrgId)
      .eq("id", projectId)
      .maybeSingle(),
    supabase.from("orgs").select("name").eq("id", resolvedOrgId).maybeSingle(),
    supabase
      .from("contracts")
      .select("signed_at, effective_date, retainage_percent, retainage_schedule, stored_materials_retainage_percent")
      .eq("org_id", resolvedOrgId)
      .eq("id", app.contract_id)
      .maybeSingle(),
    supabase
      .from("change_orders")
      .select("title, total_cents, lifecycle")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("lifecycle", "approved")
      .order("created_at", { ascending: true }),
  ])
  if (linesError) throw new Error(`Failed to load pay application lines: ${linesError.message}`)
  if (sovError) throw new Error(`Failed to load schedule of values: ${sovError.message}`)
  if (projectError) throw new Error(`Failed to load project: ${projectError.message}`)
  if (orgError) throw new Error(`Failed to load organization: ${orgError.message}`)
  if (!project) throw new Error("Project not found")

  const [clientResult, invoiceResult] = await Promise.all([
    project.client_id
      ? supabase
          .from("contacts")
          .select("full_name")
          .eq("org_id", resolvedOrgId)
          .eq("id", project.client_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { full_name?: string | null } | null }),
    app.invoice_id
      ? supabase
          .from("invoices")
          .select("invoice_number")
          .eq("org_id", resolvedOrgId)
          .eq("id", app.invoice_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { invoice_number?: string | null } | null }),
  ])

  const sovById = new Map((sovRows ?? []).map((row) => [row.id as string, row]))
  const lines: SovPayAppPdfLine[] = (lineRows ?? [])
    .map((row) => {
      const sov = sovById.get(row.prime_sov_line_id as string)
      return {
        itemNo: String(sov?.line_number ?? "—"),
        description: (sov?.description as string) ?? "SOV line",
        scheduledValueCents: Number(row.scheduled_value_cents ?? 0),
        previousCents: Number(row.previous_billed_cents ?? 0),
        thisPeriodCents: Number(row.this_period_cents ?? 0),
        storedMaterialsCents: Number(row.stored_materials_cents ?? 0),
        retainageCents: Number(row.retainage_cents ?? 0),
        sortKey: Number(sov?.line_number ?? 0),
      }
    })
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ sortKey: _sortKey, ...line }) => line)

  // 5a/5b split: retainage on stored materials is the current stored balance
  // at the stored rate; the remainder of retainage to date is on completed work.
  const schedule = normalizeRetainageSchedule(contract?.retainage_schedule)
  const contractPercent = Number(contract?.retainage_percent ?? 0)
  const storedRate =
    contract?.stored_materials_retainage_percent != null
      ? Number(contract.stored_materials_retainage_percent)
      : resolveRetainageRatePercent({ percentComplete: 100, schedule, contractPercent })
  const storedBalanceCents = (sovRows ?? []).reduce((sum, row) => sum + Number(row.stored_materials_cents ?? 0), 0)
  const retainageOnStored = Math.min(Number(app.retainage_cents ?? 0), Math.round(storedBalanceCents * (storedRate / 100)))

  const metadata = (app.metadata ?? {}) as Record<string, any>
  const data: SovPayAppPdfData = {
    applicationNumber: Number(app.application_number),
    applicationDateIso: app.submitted_at ?? app.created_at ?? new Date().toISOString(),
    periodStartIso: app.period_start ?? null,
    periodToIso: app.period_end,
    projectName: project.name ?? "Project",
    propertyDescription: projectLocationText(project.location),
    ownerName: clientResult.data?.full_name ?? project.qbo_customer_name ?? "Owner",
    contractorName: org?.name ?? "Contractor",
    contractDateIso: contract?.signed_at ?? contract?.effective_date ?? null,
    invoiceNumber: invoiceResult.data?.invoice_number ?? null,
    isRetainageRelease: metadata.type === "retainage_release",
    originalContractSumCents: Number(app.original_contract_sum_cents ?? 0),
    changeOrderSumCents: Number(app.change_order_sum_cents ?? 0),
    contractSumToDateCents: Number(app.contract_sum_to_date_cents ?? 0),
    totalCompletedStoredCents: Number(app.total_completed_stored_cents ?? 0),
    retainageCents: Number(app.retainage_cents ?? 0),
    retainageOnCompletedWorkCents: Number(app.retainage_cents ?? 0) - retainageOnStored,
    retainageOnStoredMaterialsCents: retainageOnStored,
    totalEarnedLessRetainageCents: Number(app.total_earned_less_retainage_cents ?? 0),
    previousCertificatesCents: Number(app.previous_certificates_cents ?? 0),
    currentPaymentDueCents: Number(app.current_payment_due_cents ?? 0),
    balanceToFinishCents: Number(app.balance_to_finish_cents ?? 0),
    changeOrders: (changeOrders ?? []).map((co) => ({
      title: (co.title as string) ?? "Change order",
      amountCents: Number(co.total_cents ?? 0),
    })),
    lines,
  }

  return {
    project_id: projectId,
    pay_application_id: payApplicationId,
    file_name: `pay-application-${app.application_number}.pdf`,
    data,
  }
}

/**
 * Render the application + continuation PDF, persist it to the files service,
 * and point `pay_applications.pdf_file_id` at the fresh copy.
 */
export async function generateSovPayApplicationPdf(args: {
  projectId: string
  payApplicationId: string
  orgId?: string
}): Promise<{ fileName: string; pdf: Buffer; report: SovPayApplicationReport }> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(args.orgId)
  const report = await getSovPayApplicationReport({ ...args, orgId: resolvedOrgId })
  const pdf = await renderSovPayApplicationPdf(report.data)

  const storagePath = `${resolvedOrgId}/${args.projectId}/pay-applications/${Date.now()}_${report.file_name}`
  await uploadFilesObject({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    bytes: pdf,
    contentType: "application/pdf",
    upsert: false,
  })

  const record = await createFileRecord(
    {
      project_id: args.projectId,
      file_name: report.file_name,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdf.length,
      visibility: "private",
      category: "financials",
      folder_path: "Financials/Pay Applications",
      description: `Pay Application #${report.data.applicationNumber}`,
      source: "generated",
      share_with_clients: true,
      share_with_subs: false,
    },
    resolvedOrgId,
  )

  await createInitialVersion(
    {
      fileId: record.id,
      storagePath,
      fileName: report.file_name,
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
    },
    resolvedOrgId,
  )

  const { data: appRow } = await supabase
    .from("pay_applications")
    .select("invoice_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", args.payApplicationId)
    .maybeSingle()
  if (appRow?.invoice_id) {
    await attachFile(
      {
        file_id: record.id,
        entity_type: "invoice",
        entity_id: appRow.invoice_id as string,
        project_id: args.projectId,
        link_role: "pay_application",
      },
      resolvedOrgId,
    )
  }

  const { error: pointerError } = await supabase
    .from("pay_applications")
    .update({ pdf_file_id: record.id })
    .eq("org_id", resolvedOrgId)
    .eq("id", args.payApplicationId)
  if (pointerError) {
    throw new Error(`Failed to attach the PDF to the pay application: ${pointerError.message}`)
  }

  return { fileName: report.file_name, pdf, report }
}
