import type { SupabaseClient } from "@supabase/supabase-js"

import { renderSovPayApplicationPdf, type SovPayAppPdfData, type SovPayAppPdfLine } from "@/lib/pdfs/pay-application-g702"
import { normalizeRetainageSchedule, resolveRetainageRatePercent } from "@/lib/financials/pay-app-math"
import { readCertification, readRevision } from "@/lib/financials/pay-app-lifecycle"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { storeGeneratedPdf } from "@/lib/services/generated-documents"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type SovPayApplicationReport = {
  project_id: string
  pay_application_id: string
  file_name: string
  data: SovPayAppPdfData
}

/** The link role of the application PDF on its invoice. */
export const PAY_APPLICATION_PDF_LINK_ROLE = "pay_application"

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

/**
 * The G702/G703 data for one posted application, from any client. No
 * authorization here: the authed wrapper below checks the member, and the
 * owner portal checks its token before calling this with the service client.
 */
export async function buildSovPayApplicationReport(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  payApplicationId: string,
  submission?: Record<string, unknown>,
): Promise<SovPayApplicationReport> {
  const { data: app, error: appError } = await supabase
    .from("pay_applications")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", payApplicationId)
    .maybeSingle()
  if (appError) throw new Error(`Failed to load pay application: ${appError.message}`)
  if (!app) throw new Error("Pay application not found")
  if (submission) Object.assign(app, submission)
  if (app.status === "draft" && !submission) throw new Error("Submit the pay application before generating its PDF")

  const metadata = (app.metadata ?? {}) as Record<string, unknown>
  const frozen = metadata.report_snapshot as SovPayAppPdfData | undefined
  if (frozen && !submission) {
    const certificate = readCertification(metadata)
    const data = { ...frozen, certification: certificate ? {
      signerName: certificate.signer_name, certifiedAt: certificate.certified_at,
      certifiedAmountCents: certificate.certified_amount_cents,
      requestedAmountCents: certificate.requested_amount_cents,
      deferredAmountCents: certificate.deferred_amount_cents,
      note: certificate.note,
    } : null }
    return { project_id: projectId, pay_application_id: payApplicationId,
      file_name: `pay-application-${app.application_number}${data.revision > 0 ? `-rev${data.revision}` : ""}.pdf`, data }
  }
  const submittedById = typeof metadata.submitted_by === "string" ? metadata.submitted_by : null

  const [
    { data: lineRows, error: linesError },
    { data: sovRows, error: sovError },
    { data: project, error: projectError },
    { data: org, error: orgError },
    { data: contract },
    { data: changeOrders },
    { data: submitter },
  ] = await Promise.all([
    supabase
      .from("pay_application_lines")
      .select("prime_sov_line_id, scheduled_value_cents, previous_billed_cents, this_period_cents, stored_materials_cents, retainage_cents, metadata")
      .eq("org_id", orgId)
      .eq("pay_application_id", payApplicationId),
    supabase
      .from("prime_sov_lines")
      .select("id, line_number, description, stored_materials_cents, retainage_held_cents, retainage_released_cents, previous_billed_cents")
      .eq("org_id", orgId)
      .eq("contract_id", app.contract_id),
    supabase.from("projects").select("name, location, client_id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
    supabase
      .from("contracts")
      .select("signed_at, effective_date, retainage_percent, retainage_schedule, stored_materials_retainage_percent")
      .eq("org_id", orgId)
      .eq("id", app.contract_id)
      .maybeSingle(),
    supabase
      .from("change_orders")
      .select("title, total_cents, lifecycle")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("lifecycle", "approved")
      .order("created_at", { ascending: true }),
    submittedById
      ? supabase.from("app_users").select("full_name").eq("id", submittedById).maybeSingle()
      : Promise.resolve({ data: null as { full_name?: string | null } | null }),
  ])
  if (linesError) throw new Error(`Failed to load pay application lines: ${linesError.message}`)
  if (sovError) throw new Error(`Failed to load schedule of values: ${sovError.message}`)
  if (projectError) throw new Error(`Failed to load project: ${projectError.message}`)
  if (orgError) throw new Error(`Failed to load organization: ${orgError.message}`)
  if (!project) throw new Error("Project not found")

  const [clientResult, invoiceResult] = await Promise.all([
    project.client_id
      ? supabase.from("contacts").select("full_name").eq("org_id", orgId).eq("id", project.client_id).maybeSingle()
      : Promise.resolve({ data: null as { full_name?: string | null } | null }),
    app.invoice_id
      ? supabase.from("invoices").select("invoice_number").eq("org_id", orgId).eq("id", app.invoice_id).maybeSingle()
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
  const retainageOnStored = Math.min(Number(app.retainage_cents ?? 0), (lineRows ?? []).reduce((sum, row) => {
    const lineMetadata = (row.metadata ?? {}) as Record<string, unknown>
    return sum + Math.round(Number(row.stored_materials_cents ?? 0) * Number(lineMetadata.stored_retainage_percent ?? storedRate) / 100)
  }, 0))

  // Accounting customer identity lives in the provider-neutral entity map.
  const accountingCustomerName =
    (await resolveAccountingTarget({ orgId, projectId }).catch(() => null))?.dimensions.customer?.name ?? null

  const certification = readCertification(metadata)
  const data: SovPayAppPdfData = {
    applicationNumber: Number(app.application_number),
    applicationDateIso: app.submitted_at ?? app.created_at ?? new Date().toISOString(),
    periodStartIso: app.period_start ?? null,
    periodToIso: app.period_end,
    projectName: project.name ?? "Project",
    propertyDescription: projectLocationText(project.location),
    ownerName: clientResult.data?.full_name ?? accountingCustomerName ?? "Owner",
    contractorName: org?.name ?? "Contractor",
    contractDateIso: contract?.signed_at ?? contract?.effective_date ?? null,
    invoiceNumber: invoiceResult.data?.invoice_number ?? null,
    isRetainageRelease: metadata.type === "retainage_release",
    revision: readRevision(metadata),
    submittedBy:
      submitter?.full_name && app.submitted_at ? { name: submitter.full_name, at: app.submitted_at } : null,
    certification: certification
      ? {
          signerName: certification.signer_name,
          certifiedAt: certification.certified_at,
          certifiedAmountCents: certification.certified_amount_cents,
          requestedAmountCents: certification.requested_amount_cents,
          deferredAmountCents: certification.deferred_amount_cents,
          note: certification.note,
        }
      : null,
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

  const revisionSuffix = data.revision > 0 ? `-rev${data.revision}` : ""
  return {
    project_id: projectId,
    pay_application_id: payApplicationId,
    file_name: `pay-application-${app.application_number}${revisionSuffix}.pdf`,
    data,
  }
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
  return buildSovPayApplicationReport(supabase, resolvedOrgId, projectId, payApplicationId)
}

/**
 * Render the application + continuation PDF, store it as a project file
 * attached to the application's invoice, and point `pdf_file_id` at the fresh
 * copy. Works without a session so the owner's certification, which changes
 * what the document says, can refresh it from the portal.
 */
export async function renderAndStorePayApplicationPdf(input: {
  orgId: string
  projectId: string
  payApplicationId: string
  createdBy: string | null
}): Promise<{ fileName: string; pdf: Buffer; fileId: string; report: SovPayApplicationReport }> {
  const supabase = createServiceSupabaseClient()
  const report = await buildSovPayApplicationReport(supabase, input.orgId, input.projectId, input.payApplicationId)
  const pdf = await renderSovPayApplicationPdf(report.data)

  const { data: appRow } = await supabase
    .from("pay_applications")
    .select("invoice_id")
    .eq("org_id", input.orgId)
    .eq("id", input.payApplicationId)
    .maybeSingle()

  const { fileId } = await storeGeneratedPdf({
    supabase,
    orgId: input.orgId,
    projectId: input.projectId,
    fileName: report.file_name,
    pdf,
    storageFolder: "pay-applications",
    folderPath: "Financials/Pay Applications",
    description: `Pay Application #${report.data.applicationNumber}${report.data.revision > 0 ? ` (revision ${report.data.revision})` : ""}`,
    shareWithClients: true,
    createdBy: input.createdBy,
    metadata: { pay_application_id: input.payApplicationId, revision: report.data.revision },
    attachTo: appRow?.invoice_id
      ? { entityType: "invoice", entityId: appRow.invoice_id as string, linkRole: PAY_APPLICATION_PDF_LINK_ROLE }
      : null,
  })

  const { error: pdfError } = await supabase
    .from("pay_applications")
    .update({ pdf_file_id: fileId })
    .eq("org_id", input.orgId)
    .eq("id", input.payApplicationId)
  if (pdfError) throw new Error(`Failed to record pay application PDF: ${pdfError.message}`)

  return { fileName: report.file_name, pdf, fileId, report }
}

/** The member-facing entry point: authorize, then render and store. */
export async function generateSovPayApplicationPdf(args: {
  projectId: string
  payApplicationId: string
  orgId?: string
}): Promise<{ fileName: string; pdf: Buffer; report: SovPayApplicationReport }> {
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(args.orgId)
  await requireProjectPermission(userId, args.projectId, "report.read")
  return renderAndStorePayApplicationPdf({
    orgId: resolvedOrgId,
    projectId: args.projectId,
    payApplicationId: args.payApplicationId,
    createdBy: userId,
  })
}
