import { computePayApplicationCertification, type PayApplicationDeferral } from "@/lib/financials/pay-app-certification"
import { buildPayApplicationProgressEvidence, type PayApplicationProgressEvidence, type ApprovedSovEvidenceRow } from "@/lib/financials/pay-app-evidence"
import type { SovPayAppPdfData } from "@/lib/pdfs/pay-application-g702"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  computePayAppLine,
  computePayAppSummary,
  normalizeRetainageSchedule,
  resolveRetainageRatePercent,
  thisPeriodFromPercentComplete,
  type ComputedPayAppLine,
  type PayAppSummary,
  type RetainageStep,
} from "@/lib/financials/pay-app-math"
import {
  derivePayApplicationStage,
  readCertification,
  readReturns,
  readRevision,
  readSentToOwner,
  type PayApplicationCertification,
  type PayApplicationReturn,
  type PayApplicationStage,
} from "@/lib/financials/pay-app-lifecycle"
import { getProjectPosture, normalizeProductTier, type ProductTier } from "@/lib/product-tier"
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInvoice, issueInvoice, runInvoiceIssuance, voidInvoice } from "@/lib/services/invoices"
import { voidPendingInvoiceLienWaiversWithClient } from "@/lib/services/invoice-lien-waivers"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { getPeriodForCostDate, linkInvoiceToBillingPeriod } from "@/lib/services/billing-periods"
import { getProgressBillingContract, listPrimeSovLines, type PrimeSovLine } from "@/lib/services/prime-sov"
import { buildSovPayApplicationReport, renderAndStorePayApplicationPdf } from "@/lib/services/reports/pay-application-g702"
import { projectBillingHref } from "@/lib/financials/invoice-destinations"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  payApplicationCreateSchema,
  payApplicationLinesUpdateSchema,
  retainageReleaseInputSchema,
  type PayApplicationLineEntry,
  type RetainageReleaseInput,
} from "@/lib/validation/pay-applications"

const PAY_APP_SELECT =
  "id, org_id, project_id, contract_id, application_number, period_start, period_end, billing_period_id, status, invoice_id, original_contract_sum_cents, change_order_sum_cents, contract_sum_to_date_cents, total_completed_stored_cents, retainage_cents, total_earned_less_retainage_cents, previous_certificates_cents, current_payment_due_cents, balance_to_finish_cents, submitted_at, approved_at, paid_at, pdf_file_id, metadata, created_at, updated_at"

const APP_LINE_SELECT =
  "id, pay_application_id, prime_sov_line_id, scheduled_value_cents, previous_billed_cents, this_period_cents, stored_materials_cents, percent_complete, balance_to_finish_cents, retainage_cents, metadata"

const BILLED_APP_STATUSES = ["submitted", "approved", "invoiced", "paid"] as const

export type PayApplicationStatus = "draft" | "submitted" | "approved" | "invoiced" | "paid" | "void"

export interface PayApplication {
  id: string
  project_id: string
  contract_id: string
  application_number: number
  period_start: string | null
  period_end: string
  billing_period_id: string | null
  status: PayApplicationStatus
  invoice_id: string | null
  original_contract_sum_cents: number
  change_order_sum_cents: number
  contract_sum_to_date_cents: number
  total_completed_stored_cents: number
  retainage_cents: number
  total_earned_less_retainage_cents: number
  previous_certificates_cents: number
  current_payment_due_cents: number
  requested_payment_cents?: number
  certified_payment_cents?: number | null
  deferred_payment_cents?: number
  balance_to_finish_cents: number
  submitted_at: string | null
  approved_at: string | null
  paid_at: string | null
  invoice_due_date?: string | null
  invoice_balance_due_cents?: number | null
  invoice_status: string | null
  /** The invoice's public token, for the owner's PDF and pay links. */
  invoice_token: string | null
  days_past_due?: number
  pdf_file_id: string | null
  is_retainage_release: boolean
  /** How many times the owner returned it. A returned draft is a revision. */
  revision: number
  /** The posture requires the owner's certificate before the invoice issues. */
  certification_required: boolean
  certification: PayApplicationCertification | null
  sent_to_owner: { at: string; recipients: string[] } | null
  returns: PayApplicationReturn[]
  stage: PayApplicationStage
  created_at?: string
}

export interface PayApplicationLine {
  progress_evidence?: { source_bill_ids: string[]; suggested_percent_complete: number; accepted_by: string;
    accepted_at: string; source_through_date: string; applied_work_cents: number; note: string } | null
  id: string
  prime_sov_line_id: string
  line_number: number
  description: string
  cost_code_label: string | null
  scheduled_value_cents: number
  previous_billed_cents: number
  this_period_cents: number
  stored_materials_cents: number
  previous_stored_materials_cents: number
  previous_deferred_cents?: number
  maximum_deferrable_cents?: number
  percent_complete: number
  balance_to_finish_cents: number
  retainage_cents: number
  retainage_percent_override: number | null
  overbilled: boolean
}

export interface PayApplicationRetainageConfig {
  contract_percent: number
  schedule: RetainageStep[] | null
  stored_materials_percent: number | null
}

export interface PayApplicationDetail {
  report_snapshot: SovPayAppPdfData | null
  application: PayApplication
  lines: PayApplicationLine[]
  summary: PayAppSummary
  retainage_config: PayApplicationRetainageConfig
}

type PayAppRow = Record<string, any>
type AppLineRow = Record<string, any>

interface ApplicationFacts {
  certificationRequired: boolean
  invoice: { status: string | null; token: string | null } | null
}

function mapApplication(row: PayAppRow, facts: ApplicationFacts): PayApplication {
  const metadata = (row.metadata ?? {}) as Record<string, any>
  const certification = readCertification(metadata)
  const sentToOwner = readSentToOwner(metadata)
  const revision = readRevision(metadata)
  const stage = derivePayApplicationStage({
    status: String(row.status),
    revision,
    sentToOwnerAt: sentToOwner?.at ?? null,
    certifiedAt: certification?.certified_at ?? row.approved_at ?? null,
    certificationRequired: facts.certificationRequired,
    invoiceStatus: facts.invoice?.status ?? null,
  })
  return {
    id: row.id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    application_number: Number(row.application_number),
    period_start: row.period_start ?? null,
    period_end: row.period_end,
    billing_period_id: row.billing_period_id ?? null,
    status: row.status as PayApplicationStatus,
    invoice_id: row.invoice_id ?? null,
    original_contract_sum_cents: Number(row.original_contract_sum_cents ?? 0),
    change_order_sum_cents: Number(row.change_order_sum_cents ?? 0),
    contract_sum_to_date_cents: Number(row.contract_sum_to_date_cents ?? 0),
    total_completed_stored_cents: Number(row.total_completed_stored_cents ?? 0),
    retainage_cents: Number(row.retainage_cents ?? 0),
    total_earned_less_retainage_cents: Number(row.total_earned_less_retainage_cents ?? 0),
    previous_certificates_cents: Number(row.previous_certificates_cents ?? 0),
    current_payment_due_cents: Number(row.current_payment_due_cents ?? 0),
    requested_payment_cents: Number(row.current_payment_due_cents ?? 0),
    certified_payment_cents: certification?.certified_amount_cents ?? null,
    deferred_payment_cents: certification?.deferred_amount_cents ?? 0,
    balance_to_finish_cents: Number(row.balance_to_finish_cents ?? 0),
    submitted_at: row.submitted_at ?? null,
    approved_at: row.approved_at ?? null,
    paid_at: row.paid_at ?? null,
    invoice_status: facts.invoice?.status ?? null,
    invoice_token: facts.invoice?.token ?? null,
    pdf_file_id: row.pdf_file_id ?? null,
    is_retainage_release: metadata.type === "retainage_release",
    revision,
    certification_required: facts.certificationRequired,
    certification,
    sent_to_owner: sentToOwner,
    returns: readReturns(metadata),
    stage,
    created_at: row.created_at,
  }
}

/**
 * Whether this project's owner has to certify a pay application before its
 * invoice issues. Commercial owners do (the posture policy's required review);
 * a custom-home client billed by progress does not.
 */
async function certificationRequiredForProject(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  productTier: ProductTier,
): Promise<boolean> {
  const { data } = await supabase.from("projects").select("property_type").eq("org_id", orgId).eq("id", projectId).maybeSingle()
  const posture = getProjectPosture(data?.property_type, productTier)
  return getReceivablesPosturePolicy(posture).approvalMode === "required_review"
}

async function loadInvoiceFacts(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string | null,
): Promise<ApplicationFacts["invoice"]> {
  if (!invoiceId) return null
  const { data } = await supabase.from("invoices").select("status, token").eq("org_id", orgId).eq("id", invoiceId).maybeSingle()
  return data ? { status: data.status ?? null, token: data.token ?? null } : null
}

function retainageConfigFromContract(contract: {
  retainage_percent?: number | null
  retainage_schedule?: unknown
  stored_materials_retainage_percent?: number | null
}): PayApplicationRetainageConfig {
  return {
    contract_percent: Number(contract.retainage_percent ?? 0),
    schedule: normalizeRetainageSchedule(contract.retainage_schedule),
    stored_materials_percent:
      contract.stored_materials_retainage_percent != null ? Number(contract.stored_materials_retainage_percent) : null,
  }
}

function computedFromRow(row: AppLineRow): ComputedPayAppLine {
  return {
    thisPeriodCents: Number(row.this_period_cents ?? 0),
    storedMaterialsCents: Number(row.stored_materials_cents ?? 0),
    totalCompletedAndStoredCents:
      Number(row.previous_billed_cents ?? 0) + Number(row.this_period_cents ?? 0) + Number(row.stored_materials_cents ?? 0),
    percentComplete: Number(row.percent_complete ?? 0),
    balanceToFinishCents: Number(row.balance_to_finish_cents ?? 0),
    retainageCents: Number(row.retainage_cents ?? 0),
    overbilled: Boolean((row.metadata as Record<string, any> | null)?.overbilled),
  }
}

function mapLine(row: AppLineRow, sovLine: PrimeSovLine | undefined): PayApplicationLine {
  const metadata = (row.metadata ?? {}) as Record<string, any>
  return {
    id: row.id,
    prime_sov_line_id: row.prime_sov_line_id,
    line_number: sovLine?.line_number ?? 0,
    description: sovLine?.description ?? "SOV line",
    cost_code_label: sovLine?.cost_code_label ?? null,
    scheduled_value_cents: Number(row.scheduled_value_cents ?? 0),
    previous_billed_cents: Number(row.previous_billed_cents ?? 0),
    this_period_cents: Number(row.this_period_cents ?? 0),
    stored_materials_cents: Number(row.stored_materials_cents ?? 0),
    previous_stored_materials_cents: Number(metadata.previous_stored_materials_cents ?? 0),
    previous_deferred_cents: Number(metadata.previous_deferred_cents ?? 0),
    maximum_deferrable_cents: Math.max(0, Number(row.this_period_cents ?? 0) + Number(row.stored_materials_cents ?? 0) -
      Number(metadata.previous_stored_materials_cents ?? 0) - Number(row.retainage_cents ?? 0) + Number(metadata.previous_deferred_cents ?? 0)),
    percent_complete: Number(row.percent_complete ?? 0),
    balance_to_finish_cents: Number(row.balance_to_finish_cents ?? 0),
    retainage_cents: Number(row.retainage_cents ?? 0),
    retainage_percent_override: sovLine?.retainage_percent_override ?? null,
    overbilled: Boolean(metadata.overbilled),
    progress_evidence: metadata.progress_evidence ?? null,
  }
}

async function requirePayAppPermission(params: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission?: "payapp.write" | "invoice.read" | "invoice.approve"
  resourceId?: string
}) {
  await requireAuthorization({
    permission: params.permission ?? "payapp.write",
    userId: params.userId,
    orgId: params.orgId,
    projectId: params.projectId,
    supabase: params.supabase,
    logDecision: params.permission !== "invoice.read",
    resourceType: "pay_application",
    resourceId: params.resourceId,
  })
}

async function loadApplication(supabase: SupabaseClient, orgId: string, payApplicationId: string): Promise<PayAppRow> {
  const { data, error } = await supabase
    .from("pay_applications")
    .select(PAY_APP_SELECT)
    .eq("org_id", orgId)
    .eq("id", payApplicationId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to load pay application: ${error.message}`)
  }
  if (!data) {
    throw new Error("Pay application not found")
  }
  return data
}

async function loadApplicationLines(supabase: SupabaseClient, orgId: string, payApplicationId: string): Promise<AppLineRow[]> {
  const { data, error } = await supabase
    .from("pay_application_lines")
    .select(APP_LINE_SELECT)
    .eq("org_id", orgId)
    .eq("pay_application_id", payApplicationId)
  if (error) {
    throw new Error(`Failed to load pay application lines: ${error.message}`)
  }
  return data ?? []
}

async function sumPreviousCertificates(
  supabase: SupabaseClient,
  orgId: string,
  contractId: string,
  excludeAppId?: string,
): Promise<number> {
  let query = supabase
    .from("pay_applications")
    .select("id, current_payment_due_cents, metadata")
    .eq("org_id", orgId)
    .eq("contract_id", contractId)
    .in("status", [...BILLED_APP_STATUSES])
  if (excludeAppId) {
    query = query.neq("id", excludeAppId)
  }
  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load prior pay applications: ${error.message}`)
  }
  return (data ?? []).reduce((sum, row) => sum + (readCertification(row.metadata)?.certified_amount_cents ?? Number(row.current_payment_due_cents ?? 0)), 0)
}

async function sumApprovedChangeOrders(supabase: SupabaseClient, orgId: string, projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("change_orders")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("lifecycle", "approved")
  if (error) {
    throw new Error(`Failed to load approved change orders: ${error.message}`)
  }
  return (data ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
}

async function buildDetail(
  supabase: SupabaseClient,
  orgId: string,
  appRow: PayAppRow,
  options: { sovLines?: PrimeSovLine[]; productTier: ProductTier },
): Promise<PayApplicationDetail> {
  const [lineRows, sovState, contract, previousCertificates, changeOrderSum, certificationRequired, invoiceFacts] =
    await Promise.all([
      loadApplicationLines(supabase, orgId, appRow.id),
      options.sovLines ? Promise.resolve(null) : listPrimeSovLines(appRow.project_id as string, orgId),
      getProgressBillingContract(supabase, orgId, appRow.project_id as string),
      sumPreviousCertificates(supabase, orgId, appRow.contract_id as string, appRow.id as string),
      sumApprovedChangeOrders(supabase, orgId, appRow.project_id as string),
      certificationRequiredForProject(supabase, orgId, appRow.project_id as string, options.productTier),
      loadInvoiceFacts(supabase, orgId, (appRow.invoice_id as string | null) ?? null),
    ])

  const sovLines = options.sovLines ?? sovState?.lines ?? []
  const sovById = new Map(sovLines.map((line) => [line.id, line]))
  const lines = lineRows
    .map((row) => mapLine(row, sovById.get(row.prime_sov_line_id as string)))
    .sort((a, b) => a.line_number - b.line_number)

  const application = mapApplication(appRow, { certificationRequired, invoice: invoiceFacts })
  const heldNet = sovLines.reduce((sum, line) => sum + line.retainage_held_cents - line.retainage_released_cents, 0)
  const isPosted = application.status !== "draft"

  // For drafts the summary is live-computed; posted apps report their frozen
  // snapshot so the numbers never drift after invoicing.
  const summary: PayAppSummary = isPosted
    ? {
        contractSumToDateCents: application.contract_sum_to_date_cents,
        totalCompletedStoredCents: application.total_completed_stored_cents,
        currentRetainageCents: Number((appRow.metadata as Record<string, any> | null)?.current_retainage_cents ?? 0),
        retainageCents: application.retainage_cents,
        totalEarnedLessRetainageCents: application.total_earned_less_retainage_cents,
        previousCertificatesCents: application.previous_certificates_cents,
        currentPaymentDueCents: application.current_payment_due_cents,
        balanceToFinishCents: application.balance_to_finish_cents,
      }
    : computePayAppSummary({
        originalContractSumCents: resolveOriginalContractSum(contract),
        changeOrderSumCents: changeOrderSum,
        previousRetainageHeldCents: heldNet,
        previousCertificatesCents: previousCertificates,
        lines: lineRows.map(computedFromRow),
      })

  return {
    report_snapshot: isPosted ? ((appRow.metadata as Record<string, unknown> | null)?.report_snapshot as SovPayAppPdfData ?? null) : null,
    application,
    lines,
    summary,
    retainage_config: retainageConfigFromContract(contract ?? {}),
  }
}

function resolveOriginalContractSum(contract: { total_cents?: number | null; snapshot?: Record<string, any> | null } | null): number {
  if (!contract) return 0
  const original = Number(contract.snapshot?.base_total_cents ?? contract.snapshot?.original_total_cents ?? NaN)
  if (Number.isFinite(original)) return Math.round(original)
  return Number(contract.total_cents ?? 0)
}

/** The register rows for a project, from any client; the authed wrapper and the owner portal share it. */
export async function listPayApplicationsWithClient(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  productTier: ProductTier,
): Promise<PayApplication[]> {
  const [{ data, error }, certificationRequired] = await Promise.all([
    supabase
      .from("pay_applications")
      .select(PAY_APP_SELECT)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("application_number", { ascending: false }),
    certificationRequiredForProject(supabase, orgId, projectId, productTier),
  ])
  if (error) {
    throw new Error(`Failed to load pay applications: ${error.message}`)
  }
  const rows = data ?? []
  const invoiceIds = rows.map((row) => row.invoice_id as string | null).filter((id): id is string => Boolean(id))
  const { data: invoices, error: invoiceError } =
    invoiceIds.length > 0
      ? await supabase.from("invoices").select("id, status, token, due_date, balance_due_cents").eq("org_id", orgId).in("id", invoiceIds)
      : { data: [], error: null }
  if (invoiceError) throw new Error(`Failed to load pay application receivables: ${invoiceError.message}`)
  const invoiceById = new Map((invoices ?? []).map((invoice) => [invoice.id as string, invoice]))
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()
  return rows.map((row) => {
    const invoice = row.invoice_id ? invoiceById.get(row.invoice_id as string) : null
    const application = mapApplication(row, {
      certificationRequired,
      invoice: invoice ? { status: invoice.status ?? null, token: invoice.token ?? null } : null,
    })
    const dueAt = invoice?.due_date ? new Date(`${invoice.due_date}T00:00:00Z`).getTime() : null
    return {
      ...application,
      invoice_due_date: invoice?.due_date ?? null,
      invoice_balance_due_cents: invoice?.balance_due_cents == null ? null : Number(invoice.balance_due_cents),
      days_past_due: dueAt != null && Number(invoice?.balance_due_cents ?? 0) > 0
        ? Math.max(0, Math.floor((today - dueAt) / 86_400_000))
        : 0,
    }
  })
}

export async function listPayApplications(projectId: string, orgId?: string): Promise<PayApplication[]> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })
  return listPayApplicationsWithClient(supabase, resolvedOrgId, projectId, productTier)
}

export async function getPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    permission: "invoice.read",
    resourceId: payApplicationId,
  })
  return buildDetail(supabase, resolvedOrgId, appRow, { productTier })
}

const INSERT_RETRY_LIMIT = 5

export async function createPayApplication(
  projectId: string,
  input: { period_start?: string | null; period_end: string },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = payApplicationCreateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId })

  const sovState = await listPrimeSovLines(projectId, resolvedOrgId)
  if (!sovState.summary) {
    throw new Error("Set up the billing contract before creating a pay application")
  }
  if (sovState.lines.length === 0) {
    throw new Error("Build the schedule of values before creating a pay application")
  }

  const { data: openDraft, error: draftError } = await supabase
    .from("pay_applications")
    .select("id, application_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", sovState.summary.contract_id)
    .eq("status", "draft")
    .limit(1)
    .maybeSingle()
  if (draftError) {
    throw new Error(`Failed to check open pay applications: ${draftError.message}`)
  }
  if (openDraft) {
    throw new Error(`Application #${openDraft.application_number} is still a draft. Submit or delete it first.`)
  }

  const billingPeriod = await getPeriodForCostDate({
    supabase,
    orgId: resolvedOrgId,
    projectId,
    occurredOn: parsed.period_end,
  }).catch(() => null)

  let appRow: PayAppRow | null = null
  for (let attempt = 0; attempt < INSERT_RETRY_LIMIT && !appRow; attempt += 1) {
    const { data: maxRow, error: maxError } = await supabase
      .from("pay_applications")
      .select("application_number")
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", sovState.summary.contract_id)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxError) {
      throw new Error(`Failed to number pay application: ${maxError.message}`)
    }
    const nextNumber = Number(maxRow?.application_number ?? 0) + 1

    const { data, error } = await supabase
      .from("pay_applications")
      .insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: sovState.summary.contract_id,
        application_number: nextNumber,
        period_start: parsed.period_start ?? null,
        period_end: parsed.period_end,
        billing_period_id: billingPeriod?.id ?? null,
        status: "draft",
        metadata: { current_retainage_cents: 0 },
      })
      .select(PAY_APP_SELECT)
      .single()

    if (!error && data) {
      appRow = data
      break
    }
    if (error?.code !== "23505") {
      throw new Error(`Failed to create pay application: ${error?.message}`)
    }
  }
  if (!appRow) {
    throw new Error("Failed to allocate a pay application number. Try again.")
  }

  const { data: previousApp, error: previousAppError } = await supabase.from("pay_applications")
    .select("metadata").eq("org_id", resolvedOrgId).eq("contract_id", sovState.summary.contract_id)
    .in("status", [...BILLED_APP_STATUSES]).order("application_number", { ascending: false }).limit(1).maybeSingle()
  if (previousAppError) throw new Error(`Failed to read previous certificate: ${previousAppError.message}`)
  const previousDeferrals = readCertification(previousApp?.metadata)?.deferrals ?? []
  const seedLines = sovState.lines.map((line) => ({
    org_id: resolvedOrgId,
    pay_application_id: appRow!.id,
    prime_sov_line_id: line.id,
    scheduled_value_cents: line.scheduled_value_cents,
    previous_billed_cents: line.previous_billed_cents,
    this_period_cents: 0,
    stored_materials_cents: line.stored_materials_cents,
    percent_complete:
      line.scheduled_value_cents > 0
        ? Math.round((line.previous_billed_cents / line.scheduled_value_cents) * 10000) / 100
        : 0,
    balance_to_finish_cents: line.scheduled_value_cents - line.previous_billed_cents - line.stored_materials_cents,
    retainage_cents: 0,
    metadata: { previous_stored_materials_cents: line.stored_materials_cents, previous_deferred_cents: previousDeferrals.find((entry) => entry.prime_sov_line_id === line.id)?.deferred_cents ?? 0 },
  }))

  const { error: linesError } = await supabase.from("pay_application_lines").insert(seedLines)
  if (linesError) {
    await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", appRow.id)
    throw new Error(`Failed to seed pay application lines: ${linesError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "pay_application",
    entityId: appRow.id as string,
    after: { project_id: projectId, application_number: appRow.application_number, period_end: parsed.period_end },
  })

  return buildDetail(supabase, resolvedOrgId, appRow, { sovLines: sovState.lines, productTier })
}

export async function deletePayApplication(payApplicationId: string, orgId?: string): Promise<{ success: true }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("Only draft pay applications can be deleted. Void submitted applications instead.")
  }

  const { error } = await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", payApplicationId)
  if (error) {
    throw new Error(`Failed to delete pay application: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "pay_application",
    entityId: payApplicationId,
    before: { application_number: appRow.application_number, project_id: appRow.project_id },
  })
  return { success: true }
}

export async function updatePayApplicationLines(
  payApplicationId: string,
  input: { entries: PayApplicationLineEntry[]; allow_overbilling?: boolean },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = payApplicationLinesUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("This pay application has been submitted and is frozen. Void it to make changes.")
  }

  const [lineRows, contract] = await Promise.all([
    loadApplicationLines(supabase, resolvedOrgId, payApplicationId),
    getProgressBillingContract(supabase, resolvedOrgId, appRow.project_id as string),
  ])
  if (!contract) {
    throw new Error("Billing contract not found")
  }

  const { data: sovRows, error: sovError } = await supabase
    .from("prime_sov_lines")
    .select("id, retainage_percent_override, line_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", appRow.contract_id)
  if (sovError) {
    throw new Error(`Failed to load schedule of values: ${sovError.message}`)
  }
  const sovById = new Map((sovRows ?? []).map((row) => [row.id as string, row]))
  const lineBySovId = new Map(lineRows.map((row) => [row.prime_sov_line_id as string, row]))

  const acceptedEvidence = parsed.entries.some((entry) => entry.progress_evidence)
    ? (await getPayApplicationWorkspaceContext(appRow.project_id as string, resolvedOrgId, String(appRow.period_end))).progressEvidence
    : []
  const config = retainageConfigFromContract(contract)
  const overbilledLines: number[] = []
  const pendingUpdates: Array<{
    lineId: string
    values: Record<string, unknown>
  }> = []

  for (const entry of parsed.entries) {
    const lineRow = lineBySovId.get(entry.prime_sov_line_id)
    const sovLine = sovById.get(entry.prime_sov_line_id)
    if (!lineRow || !sovLine) {
      throw new Error("Pay application line does not match the schedule of values")
    }

    const proposal = entry.progress_evidence ? acceptedEvidence.find((evidence) => evidence.primeSovLineId === entry.prime_sov_line_id) : null
    if (entry.progress_evidence && (!proposal || proposal.suggestedPercentComplete !== entry.progress_evidence.suggested_percent_complete ||
      [...proposal.sourceBillIds].sort().join(",") !== [...new Set(entry.progress_evidence.source_bill_ids)].sort().join(","))) {
      throw new Error("Approved progress evidence changed. Refresh the proposal before accepting it.")
    }
    const scheduled = Number(lineRow.scheduled_value_cents ?? 0)
    const previousBilled = Number(lineRow.previous_billed_cents ?? 0)
    const previousStored = Number((lineRow.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)

    const thisPeriod =
      entry.this_period_cents != null
        ? entry.this_period_cents
        : thisPeriodFromPercentComplete({
            scheduledValueCents: scheduled,
            percentComplete: entry.percent_complete ?? 0,
            previousBilledCents: previousBilled,
          })
    if (proposal && thisPeriod !== thisPeriodFromPercentComplete({ scheduledValueCents: scheduled,
      previousBilledCents: previousBilled, percentComplete: proposal.suggestedPercentComplete! })) {
      throw new Error("Accepted progress must match the reviewed proposal. Edit work without claiming the proposal instead.")
    }
    if (previousBilled + thisPeriod < 0) {
      throw new Error(`Line ${sovLine.line_number}: this period cannot reduce billed-to-date below zero`)
    }

    const percentAfter = scheduled > 0 ? ((previousBilled + thisPeriod) / scheduled) * 100 : 0
    const workRate = resolveRetainageRatePercent({
      percentComplete: percentAfter,
      schedule: config.schedule,
      lineOverridePercent: sovLine.retainage_percent_override != null ? Number(sovLine.retainage_percent_override) : null,
      contractPercent: config.contract_percent,
    })
    const storedRate = config.stored_materials_percent ?? workRate

    const computed = computePayAppLine({
      scheduledValueCents: scheduled,
      previousBilledCents: previousBilled,
      thisPeriodCents: thisPeriod,
      storedMaterialsCents: entry.stored_materials_cents,
      previousStoredMaterialsCents: previousStored,
      workRetainagePercent: workRate,
      storedMaterialsRetainagePercent: storedRate,
    })
    if (computed.overbilled) {
      overbilledLines.push(Number(sovLine.line_number))
    }

    pendingUpdates.push({
      lineId: lineRow.id as string,
      values: {
        this_period_cents: computed.thisPeriodCents,
        stored_materials_cents: computed.storedMaterialsCents,
        percent_complete: computed.percentComplete,
        balance_to_finish_cents: computed.balanceToFinishCents,
        retainage_cents: computed.retainageCents,
        metadata: {
          ...((lineRow.metadata as Record<string, any> | null) ?? {}),
          overbilled: computed.overbilled ? true : undefined,
          work_retainage_percent: workRate,
          stored_retainage_percent: storedRate,
          ...(!proposal && Number((lineRow.metadata as Record<string, any> | null)?.progress_evidence?.applied_work_cents) !== thisPeriod
            ? { progress_evidence: null } : {}),
          ...(proposal ? { progress_evidence: {
            source_bill_ids: proposal.sourceBillIds, suggested_percent_complete: proposal.suggestedPercentComplete,
            source_through_date: proposal.throughDate, accepted_by: userId, accepted_at: new Date().toISOString(),
            applied_work_cents: thisPeriod, note: proposal.note,
          } } : {}),
        },
      },
    })
  }

  // Validate the complete batch before writing any line. Previously the guard
  // threw only after persisting the rejected overbilling values.
  if (overbilledLines.length > 0 && !parsed.allow_overbilling) {
    throw new Error(
      `Line${overbilledLines.length > 1 ? "s" : ""} ${overbilledLines.join(", ")} would bill past the scheduled value. Confirm overbilling to continue.`,
    )
  }

  const { data: saved, error: appUpdateError } = await createServiceSupabaseClient().rpc("save_pay_application_lines_atomic", {
    p_org_id: resolvedOrgId, p_pay_application_id: payApplicationId,
    p_updates: pendingUpdates, p_expected_updated_at: appRow.updated_at,
    p_allow_overbilling: parsed.allow_overbilling,
  })
  if (appUpdateError) throw new Error(`Failed to save pay application: ${appUpdateError.message}`)
  const currentRetainage = Number(saved?.current_retainage_cents ?? 0)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { entries: parsed.entries.length, current_retainage_cents: currentRetainage },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

export async function submitPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  const projectId = appRow.project_id as string
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("This pay application has already been submitted.")
  }

  const [lineRows, sovState, contract, previousCertificates, changeOrderSum] = await Promise.all([
    loadApplicationLines(supabase, resolvedOrgId, payApplicationId),
    listPrimeSovLines(projectId, resolvedOrgId),
    getProgressBillingContract(supabase, resolvedOrgId, projectId),
    sumPreviousCertificates(supabase, resolvedOrgId, appRow.contract_id as string, payApplicationId),
    sumApprovedChangeOrders(supabase, resolvedOrgId, projectId),
  ])
  if (!contract) {
    throw new Error("Billing contract not found")
  }

  // The continuation sheet has to foot to the contract sum. A variance is
  // advisory while the SOV is being built; it is a defect on the document the
  // owner certifies, so it stops the submission, not the save.
  if (sovState.summary && sovState.summary.variance_cents !== 0) {
    const scheduled = (sovState.summary.scheduled_total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
    const contractSum = (sovState.summary.contract_sum_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
    throw new Error(`The schedule of values totals ${scheduled} but the contract sum to date is ${contractSum}. Balance the schedule of values before submitting.`)
  }

  const overbilledLines = lineRows.filter(
    (row) =>
      Number(row.previous_billed_cents ?? 0) +
        Number(row.this_period_cents ?? 0) +
        Number(row.stored_materials_cents ?? 0) >
      Number(row.scheduled_value_cents ?? 0),
  )
  const overbillingConfirmed =
    (appRow.metadata as Record<string, unknown> | null)?.overbilling_confirmed === true
  if (overbilledLines.length > 0 && !overbillingConfirmed) {
    throw new Error("This pay application contains overbilled lines that have not been explicitly confirmed. Save and confirm them before submitting.")
  }

  const sovById = new Map(sovState.lines.map((line) => [line.id, line]))
  const activeLines = lineRows.filter((row) => {
    const storedDelta =
      Number(row.stored_materials_cents ?? 0) -
      Number((row.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)
    return Number(row.this_period_cents ?? 0) !== 0 || storedDelta !== 0 || Number((row.metadata as Record<string, unknown> | null)?.previous_deferred_cents ?? 0) > 0
  })
  if (activeLines.length === 0) {
    throw new Error("Enter work completed or stored materials before submitting.")
  }

  const heldNet = sovState.lines.reduce((sum, line) => sum + line.retainage_held_cents - line.retainage_released_cents, 0)
  const summary = computePayAppSummary({
    originalContractSumCents: resolveOriginalContractSum(contract),
    changeOrderSumCents: changeOrderSum,
    previousRetainageHeldCents: heldNet,
    previousCertificatesCents: previousCertificates,
    lines: lineRows.map(computedFromRow),
  })

  const invoiceLines = activeLines.flatMap((row) => {
    const sovLine = sovById.get(row.prime_sov_line_id as string)
    const storedDelta =
      Number(row.stored_materials_cents ?? 0) -
      Number((row.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)
    const amountCents = Number(row.this_period_cents ?? 0) + storedDelta
    const baseLine = {
      cost_code_id: sovLine?.cost_code_id ?? undefined,
      budget_line_id: sovLine?.budget_line_id ?? undefined,
      description: `${sovLine?.line_number ?? ""}. ${sovLine?.description ?? "SOV line"}`.trim(),
      quantity: 1,
      unit: "sov",
      unit_cost: amountCents / 100,
      taxable: false,
    }
    const carry = Number((row.metadata as Record<string, unknown> | null)?.previous_deferred_cents ?? 0)
    return [ ...(amountCents !== 0 ? [baseLine] : []), ...(carry > 0 ? [{ ...baseLine,
      description: `Previously deferred — ${sovLine?.description ?? "SOV line"}`, unit_cost: carry / 100,
    }] : []) ]
  })

  const certificationRequired = await certificationRequiredForProject(supabase, resolvedOrgId, projectId, productTier)
  const applicationNumber = Number(appRow.application_number)
  const numbering = await getNextInvoiceNumber(resolvedOrgId, projectId)
  const today = new Date().toISOString().slice(0, 10)

  const invoice = await createInvoice({
    input: {
      project_id: projectId,
      invoice_number: numbering.number,
      reservation_id: numbering.reservation_id,
      title: `Pay Application #${applicationNumber}`,
      issue: false,
      issue_date: today,
      tax_rate: 0,
      lines: invoiceLines,
      source_type: "pay_application",
      source_pay_application_id: payApplicationId,
    },
    orgId: resolvedOrgId,
  })

  const submissionFacts = {
    original_contract_sum_cents: resolveOriginalContractSum(contract), change_order_sum_cents: changeOrderSum,
    contract_sum_to_date_cents: summary.contractSumToDateCents, total_completed_stored_cents: summary.totalCompletedStoredCents,
    retainage_cents: summary.retainageCents, total_earned_less_retainage_cents: summary.totalEarnedLessRetainageCents,
    previous_certificates_cents: summary.previousCertificatesCents, current_payment_due_cents: summary.currentPaymentDueCents,
    balance_to_finish_cents: summary.balanceToFinishCents, invoice_id: invoice.id, submitted_at: new Date().toISOString(),
    metadata: { ...((appRow.metadata as Record<string, unknown> | null) ?? {}), submitted_by: userId },
  }
  const report = await buildSovPayApplicationReport(supabase, resolvedOrgId, projectId, payApplicationId, submissionFacts).catch(async (error: unknown) => {
    await voidInvoice({ invoiceId: invoice.id, orgId: resolvedOrgId })
    throw error
  })

  const { error: rpcError } = await createServiceSupabaseClient().rpc("post_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: payApplicationId,
    p_invoice_id: invoice.id,
    p_summary: {
      expected_lines: lineRows,
      original_contract_sum_cents: resolveOriginalContractSum(contract),
      change_order_sum_cents: changeOrderSum,
      contract_sum_to_date_cents: summary.contractSumToDateCents,
      total_completed_stored_cents: summary.totalCompletedStoredCents,
      retainage_cents: summary.retainageCents,
      total_earned_less_retainage_cents: summary.totalEarnedLessRetainageCents,
      previous_certificates_cents: summary.previousCertificatesCents,
      current_payment_due_cents: summary.currentPaymentDueCents,
      balance_to_finish_cents: summary.balanceToFinishCents,
      metadata: { current_retainage_cents: summary.currentRetainageCents, submitted_by: userId, certification_required: certificationRequired, report_snapshot: report.data },
    },
  })
  if (rpcError) {
    // Compensate: the invoice must not survive a failed posting.
    await voidInvoice({ invoiceId: invoice.id, orgId: resolvedOrgId }).catch(() => undefined)
    throw new Error(`Failed to post pay application: ${rpcError.message}`)
  }

  // File the application PDF after posting. Optional company waivers are
  // prepared and signed explicitly in the packet workspace.
  await Promise.all([
    renderAndStorePayApplicationPdf({ orgId: resolvedOrgId, projectId, payApplicationId, createdBy: userId }).catch(
      (error: unknown) =>
        recordEvent({
          orgId: resolvedOrgId,
          actorId: userId,
          eventType: "pay_application.pdf_failed",
          entityType: "pay_application",
          entityId: payApplicationId,
          payload: { project_id: projectId, error: error instanceof Error ? error.message : String(error) },
        }),
    ),
  ])

  if (appRow.billing_period_id) {
    try {
      await linkInvoiceToBillingPeriod({
        supabase,
        orgId: resolvedOrgId,
        projectId,
        billingPeriodId: appRow.billing_period_id as string,
        invoiceId: invoice.id,
        costIds: [],
      })
    } catch {
      // Billing-period linkage is bookkeeping, not a submit blocker.
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.submitted",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: {
      project_id: projectId,
      application_number: applicationNumber,
      current_payment_due_cents: summary.currentPaymentDueCents,
    },
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.invoiced",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: { project_id: projectId, invoice_id: invoice.id, invoice_number: invoice.invoice_number },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: {
      status: "invoiced",
      invoice_id: invoice.id,
      current_payment_due_cents: summary.currentPaymentDueCents,
      retainage_cents: summary.retainageCents,
    },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

export async function voidPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })

  const { error: rpcError } = await supabase.rpc("void_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: payApplicationId,
  })
  if (rpcError) {
    throw new Error(`Failed to void pay application: ${rpcError.message}`)
  }

  if (appRow.invoice_id) {
    await voidInvoice({ invoiceId: appRow.invoice_id as string, orgId: resolvedOrgId })
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.voided",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: { project_id: appRow.project_id, application_number: appRow.application_number },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { status: "void" },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

/**
 * Release held retainage on a progress-billing contract: creates a
 * retainage-release pay application + release invoice, distributes the
 * release across SOV lines, and moves the `retainage` mirror rows to
 * invoiced with the release invoice attached.
 */
export async function releasePrimeRetainage(
  projectId: string,
  input: RetainageReleaseInput,
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = retainageReleaseInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId })

  const sovState = await listPrimeSovLines(projectId, resolvedOrgId)
  if (!sovState.summary) {
    throw new Error("This project has no progress-billing contract")
  }
  const availableCents = sovState.summary.retainage_held_cents - sovState.summary.retainage_released_cents
  const amountCents = parsed.full ? availableCents : parsed.amount_cents ?? 0
  if (amountCents <= 0) {
    throw new Error("Enter a release amount")
  }
  if (amountCents > availableCents) {
    throw new Error(`Only ${(availableCents / 100).toFixed(2)} of retainage is available to release`)
  }

  const contractId = sovState.summary.contract_id
  const previousCertificates = await sumPreviousCertificates(supabase, resolvedOrgId, contractId)

  const { data: openDraft } = await supabase
    .from("pay_applications")
    .select("id, application_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contractId)
    .eq("status", "draft")
    .limit(1)
    .maybeSingle()
  if (openDraft) {
    throw new Error(`Application #${openDraft.application_number} is still a draft. Submit or delete it before releasing retainage.`)
  }

  let appRow: PayAppRow | null = null
  for (let attempt = 0; attempt < INSERT_RETRY_LIMIT && !appRow; attempt += 1) {
    const { data: maxRow } = await supabase
      .from("pay_applications")
      .select("application_number")
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", contractId)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextNumber = Number(maxRow?.application_number ?? 0) + 1

    const { data, error } = await supabase
      .from("pay_applications")
      .insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: contractId,
        application_number: nextNumber,
        period_end: new Date().toISOString().slice(0, 10),
        status: "draft",
        metadata: { type: "retainage_release", release_amount_cents: amountCents, current_retainage_cents: 0 },
      })
      .select(PAY_APP_SELECT)
      .single()
    if (!error && data) {
      appRow = data
      break
    }
    if (error?.code !== "23505") {
      throw new Error(`Failed to create retainage release: ${error?.message}`)
    }
  }
  if (!appRow) {
    throw new Error("Failed to allocate a pay application number. Try again.")
  }

  const numbering = await getNextInvoiceNumber(resolvedOrgId, projectId)
  const invoice = await createInvoice({
    input: {
      project_id: projectId,
      invoice_number: numbering.number,
      reservation_id: numbering.reservation_id,
      title: `Retainage Release — Application #${appRow.application_number}`,
      issue: false,
      issue_date: new Date().toISOString().slice(0, 10),
      tax_rate: 0,
      lines: [
        {
          description: "Retainage release",
          quantity: 1,
          unit: "retainage_release",
          unit_cost: amountCents / 100,
          taxable: false,
        },
      ],
      source_type: "pay_application",
      source_pay_application_id: appRow.id as string,
    },
    orgId: resolvedOrgId,
  })

  const { error: releaseError } = await supabase.rpc("release_prime_sov_retainage", {
    p_org_id: resolvedOrgId,
    p_contract_id: contractId,
    p_amount_cents: amountCents,
  })
  if (releaseError) {
    await voidInvoice({ invoiceId: invoice.id, orgId: resolvedOrgId }).catch(() => undefined)
    await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", appRow.id)
    throw new Error(`Failed to release retainage: ${releaseError.message}`)
  }

  const completedStored = sovState.lines.reduce(
    (sum, line) => sum + line.previous_billed_cents + line.stored_materials_cents,
    0,
  )
  const retainageAfter = availableCents - amountCents
  const { error: postError } = await createServiceSupabaseClient().rpc("post_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: appRow.id,
    p_invoice_id: invoice.id,
    p_summary: {
      original_contract_sum_cents: resolveOriginalContractSum(
        await getProgressBillingContract(supabase, resolvedOrgId, projectId),
      ),
      change_order_sum_cents: await sumApprovedChangeOrders(supabase, resolvedOrgId, projectId),
      contract_sum_to_date_cents: sovState.summary.contract_sum_cents,
      total_completed_stored_cents: completedStored,
      retainage_cents: retainageAfter,
      total_earned_less_retainage_cents: completedStored - retainageAfter,
      previous_certificates_cents: previousCertificates,
      current_payment_due_cents: amountCents,
      balance_to_finish_cents: sovState.summary.contract_sum_cents - (completedStored - retainageAfter),
      metadata: { type: "retainage_release", release_amount_cents: amountCents, current_retainage_cents: 0 },
    },
  })
  if (postError) {
    throw new Error(
      `Retainage was released on the SOV but the release application failed to post: ${postError.message}. Contact support before retrying.`,
    )
  }

  // Move the retainage mirror rows (held on each source invoice) to invoiced,
  // splitting the oldest row when the release is partial.
  let remaining = amountCents
  const { data: heldRows, error: heldError } = await supabase
    .from("retainage")
    .select("id, amount_cents, invoice_id")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contractId)
    .eq("status", "held")
    .order("created_at", { ascending: true })
  if (heldError) {
    throw new Error(`Failed to load held retainage records: ${heldError.message}`)
  }
  const now = new Date().toISOString()
  for (const row of heldRows ?? []) {
    if (remaining <= 0) break
    const rowAmount = Number(row.amount_cents ?? 0)
    const take = Math.min(remaining, rowAmount)
    if (take === rowAmount) {
      const { error } = await supabase
        .from("retainage")
        .update({ status: "invoiced", release_invoice_id: invoice.id, released_at: now })
        .eq("org_id", resolvedOrgId)
        .eq("id", row.id)
      if (error) throw new Error(`Failed to update retainage record: ${error.message}`)
    } else {
      const { error: shrinkError } = await supabase
        .from("retainage")
        .update({ amount_cents: rowAmount - take })
        .eq("org_id", resolvedOrgId)
        .eq("id", row.id)
      if (shrinkError) throw new Error(`Failed to split retainage record: ${shrinkError.message}`)
      const { error: insertError } = await supabase.from("retainage").insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: contractId,
        invoice_id: row.invoice_id,
        amount_cents: take,
        status: "invoiced",
        release_invoice_id: invoice.id,
        released_at: now,
      })
      if (insertError) throw new Error(`Failed to record released retainage: ${insertError.message}`)
    }
    remaining -= take
  }

  // File the release application. Its waiver is prepared explicitly in the packet workspace.
  await Promise.all([
    renderAndStorePayApplicationPdf({ orgId: resolvedOrgId, projectId, payApplicationId: appRow.id as string, createdBy: userId }).catch(
      () => null,
    ),
  ])

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "retainage.released",
    entityType: "pay_application",
    entityId: appRow.id as string,
    payload: { project_id: projectId, amount_cents: amountCents, invoice_id: invoice.id },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: appRow.id as string,
    after: { type: "retainage_release", amount_cents: amountCents, invoice_id: invoice.id },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, appRow.id as string)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

/* ------------------------------------------------------------------------- *
 * Owner-facing lifecycle: send, certify, return.
 *
 * Posting an application creates its invoice as a draft. What happens next
 * depends on the posture: a commercial owner (or their architect) certifies
 * the application in their portal and THAT issues the invoice; a client billed
 * by progress without a certificate gets the invoice the moment it is sent.
 * A return sends the application back to draft as a revision, with the SOV
 * rollups reversed and the invoice voided, so the next submission carries the
 * same number and a revision mark rather than a gap in the sequence.
 * ------------------------------------------------------------------------- */

/**
 * Who is acting, and whose permission the side effects run under. In the
 * portal the actor is the owner, but the invoice still issues under the member
 * who submitted the application — the same "scheduler as actor" rule the
 * scheduled send uses.
 */
export interface PayApplicationActor {
  supabase: SupabaseClient
  orgId: string
  productTier: ProductTier
  /** The org member the side effects are attributed to. */
  actorUserId: string
  source: "portal" | "internal"
  actorName: string | null
  portalTokenId?: string | null
  contactId?: string | null
}

function submittedBy(appRow: PayAppRow): string | null {
  const value = (appRow.metadata as Record<string, unknown> | null)?.submitted_by
  return typeof value === "string" && value ? value : null
}

/**
 * The org member a portal action is attributed to.
 *
 * An owner certifying in their portal is not an Arc user, but issuing the
 * invoice needs one: permission is checked against a member, and the audit
 * trail has to name somebody inside the org. That is the person who submitted
 * the application. Applications posted before submitters were recorded fall
 * back to an active org admin, which is who would have done it by hand.
 */
export async function resolvePayApplicationActor(args: {
  orgId: string
  payApplicationId: string
}): Promise<{ actorUserId: string; productTier: ProductTier; projectId: string } | null> {
  const service = createServiceSupabaseClient()
  const [{ data: appRow }, { data: org }] = await Promise.all([
    service
      .from("pay_applications")
      .select("id, project_id, metadata")
      .eq("org_id", args.orgId)
      .eq("id", args.payApplicationId)
      .maybeSingle(),
    service.from("orgs").select("product_tier").eq("id", args.orgId).maybeSingle(),
  ])
  if (!appRow) return null
  const productTier = normalizeProductTier(org?.product_tier)
  const submitter = submittedBy(appRow)
  if (submitter) return { actorUserId: submitter, productTier, projectId: appRow.project_id as string }

  const { data: admin } = await service
    .from("memberships")
    .select("user_id, roles(key)")
    .eq("org_id", args.orgId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(50)
  const rows = (admin ?? []) as Array<{ user_id: string; roles: { key?: string | null } | Array<{ key?: string | null }> | null }>
  const keyOf = (row: (typeof rows)[number]) => {
    const relation = Array.isArray(row.roles) ? row.roles[0] : row.roles
    return relation?.key ?? null
  }
  const owner = rows.find((row) => keyOf(row) === "owner") ?? rows.find((row) => keyOf(row) === "admin") ?? rows[0]
  if (!owner) return null
  return { actorUserId: owner.user_id, productTier, projectId: appRow.project_id as string }
}

async function loadOwnerRecipient(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_id, property_type")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (!project) throw new Error("Project not found")
  const { data: contact } = project.client_id
    ? await supabase.from("contacts").select("id, full_name, email").eq("org_id", orgId).eq("id", project.client_id).maybeSingle()
    : { data: null }
  return { project, contact }
}

function normalizeRecipients(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    const email = value?.trim().toLowerCase()
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) seen.add(email)
  }
  return [...seen]
}

/**
 * Send the application to the owner. When the posture requires a certificate
 * the owner gets a link to certify or return it in their portal and the invoice
 * stays a draft; otherwise the invoice issues to the same recipients, which is
 * the send.
 */
export async function sendPayApplication(
  payApplicationId: string,
  input: { recipients?: string[]; message?: string | null },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  const projectId = appRow.project_id as string
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId, resourceId: payApplicationId })
  if (appRow.status !== "invoiced" && appRow.status !== "submitted") {
    throw new Error(
      appRow.status === "draft"
        ? "Submit the pay application before sending it."
        : appRow.status === "approved"
          ? "This pay application is already certified. Remind the owner from its invoice."
          : "This pay application cannot be sent.",
    )
  }
  if (!appRow.invoice_id) throw new Error("This pay application has no invoice to send")

  const [{ project, contact }, certificationRequired, { data: org }] = await Promise.all([
    loadOwnerRecipient(supabase, resolvedOrgId, projectId),
    certificationRequiredForProject(supabase, resolvedOrgId, projectId, productTier),
    supabase.from("orgs").select("name, slug").eq("id", resolvedOrgId).maybeSingle(),
  ])
  const recipients = normalizeRecipients(input.recipients?.length ? input.recipients : [contact?.email])
  if (recipients.length === 0) {
    throw new Error(`Add an email for the ${certificationRequired ? "owner" : "customer"} before sending.`)
  }

  const {data:packetInvoice,error:packetError}=await supabase.from("invoices").select("id,metadata,total_cents,project_id,invoice_number,title,subtotal_cents,tax_cents,notes").eq("org_id",resolvedOrgId).eq("id",appRow.invoice_id).single()
  if(packetError||!packetInvoice)throw new Error("Could not load the application packet")
  await (await import("@/lib/services/invoice-waiver-packet")).assertInvoiceWaiverPacketReady(supabase,resolvedOrgId,packetInvoice)
  const includesWaiver=Boolean(packetInvoice.metadata?.waiver_packet?.enabled)
  const sentAt = new Date().toISOString()
  const sentToOwner = { at: sentAt, recipients, by: userId }
  const metadata = (appRow.metadata as Record<string, unknown> | null) ?? {}

  if (certificationRequired) {
    const service = createServiceSupabaseClient()
    const base = await ensurePortalLink({
      supabase: service,
      orgId: resolvedOrgId,
      projectId,
      portalType: "client",
      contactId: project.client_id ?? null,
      createdBy: userId,
      capabilities: { can_view_invoices: true, can_certify_pay_applications: true, can_view_documents: true },
      fallbackPath: projectBillingHref(projectId),
    })
    const amount = (Number(appRow.current_payment_due_cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
    const revision = readRevision(metadata)
    const title = `Pay Application #${appRow.application_number}${revision > 0 ? ` (revision ${revision})` : ""}`
    const messageHtml = [
      `<p>${escapeHtml(org?.name ?? "Your contractor")} has submitted ${escapeHtml(title)} for ${escapeHtml(project.name ?? "the project")}.</p>`,
      `<p><strong>Amount applied for:</strong> ${escapeHtml(amount)}<br/><strong>Period ending:</strong> ${escapeHtml(String(appRow.period_end))}</p>`,
      includesWaiver ? "<p>Your contractor’s signed waiver is included in this packet.</p>" : "",
      input.message?.trim() ? `<p>${escapeHtml(input.message.trim()).replace(/\n/g, "<br/>")}</p>` : "",
      `<p>Review the application and continuation sheet, then certify it for payment or return it with your comments.</p>`,
    ].join("")
    const sent = await sendEmail({
      from: getOrgSenderEmail(org?.slug, org?.name),
      to: recipients,
      subject: `${title}${includesWaiver ? " & signed waiver" : ""} — ${project.name ?? "Project"}`,
      html: renderStandardEmailLayout({
        title: `${title} is ready for your certificate`,
        messageHtml,
        buttonText: "Review and certify",
        buttonUrl: `${base}/pay-applications/${payApplicationId}`,
        orgName: org?.name,
        showManageSettings: false,
      }),
    })
    if (!sent) throw new Error("The pay application email could not be sent")
  } else {
    await issueInvoice({ invoiceId: appRow.invoice_id as string, recipients, orgId: resolvedOrgId })
  }

  const { error: updateError } = await supabase
    .from("pay_applications")
    .update({ metadata: { ...metadata, sent_to_owner: sentToOwner, send_count: Number(metadata.send_count ?? 0) + 1 } })
    .eq("org_id", resolvedOrgId)
    .eq("id", payApplicationId)
  if (updateError) throw new Error(`Failed to record the send: ${updateError.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.sent",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: { project_id: projectId, recipients, certification_required: certificationRequired },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { sent_to_owner: sentToOwner },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

export interface CertifyPayApplicationInput {
  signerName: string
  signatureText?: string | null
  /** When supplied, must equal requested less the explained per-line net deferrals. */
  certifiedAmountCents?: number | null
  deferrals?: PayApplicationDeferral[]
  note?: string | null
}

/**
 * The owner's (or architect's) certificate for payment. Certifying approves the
 * invoice and issues it, so the receivable exists from the moment the owner
 * says the money is due. Runs under an actor so the portal can call it.
 */
export async function certifyPayApplicationWithActor(
  actor: PayApplicationActor,
  payApplicationId: string,
  input: CertifyPayApplicationInput,
): Promise<{ payApplicationId: string; invoiceId: string }> {
  const { supabase, orgId } = actor
  const appRow = await loadApplication(supabase, orgId, payApplicationId)
  const projectId = appRow.project_id as string
  if (appRow.status === "approved" || appRow.status === "paid") {
    throw new Error("This pay application is already certified.")
  }
  if (appRow.status !== "invoiced" && appRow.status !== "submitted") {
    throw new Error("Only a submitted pay application can be certified.")
  }
  if (!appRow.invoice_id) throw new Error("This pay application has no invoice to certify")

  const signerName = input.signerName.trim()
  if (signerName.length < 2) throw new Error("Enter the certifier's name")
  const applied = Number(appRow.current_payment_due_cents ?? 0)
  const lineRows = await loadApplicationLines(supabase, orgId, payApplicationId)
  const deferrals = (input.deferrals ?? []).map((entry) => ({ ...entry, reason: entry.reason.trim() }))
  const amounts = computePayApplicationCertification(applied, lineRows.map((row) => {
    const line = mapLine(row, undefined)
    return { prime_sov_line_id: line.prime_sov_line_id, maximum_deferrable_cents: line.maximum_deferrable_cents ?? 0 }
  }), deferrals)
  const certifiedAmount = amounts.certifiedCents
  if (input.certifiedAmountCents != null && input.certifiedAmountCents !== certifiedAmount) {
    throw new Error("Certified amount must equal the request less its explained line deferrals")
  }

  const metadata = (appRow.metadata as Record<string, unknown> | null) ?? {}
  const certifiedAt = new Date().toISOString()
  const certification: PayApplicationCertification = {
    certified_at: certifiedAt,
    signer_name: signerName,
    signature_text: input.signatureText?.trim() || signerName,
    certified_amount_cents: certifiedAmount,
    requested_amount_cents: applied, deferred_amount_cents: amounts.deferredCents, deferrals,
    source: actor.source,
    note: input.note?.trim() || null,
    portal_token_id: actor.portalTokenId ?? null,
    contact_id: actor.contactId ?? null,
    recorded_by: actor.source === "internal" ? actor.actorUserId : null,
  }

  const service = createServiceSupabaseClient()
  const sentTo = readSentToOwner(metadata)
  const { contact } = await loadOwnerRecipient(service, orgId, projectId)
  const recipients = normalizeRecipients([...(sentTo?.recipients ?? []), contact?.email])
  if (!recipients.length) throw new Error("Add an owner email before certifying this application")
  const { error } = await service.rpc("certify_pay_application_atomic", {
    p_org_id: orgId, p_pay_application_id: payApplicationId, p_actor_id: actor.actorUserId,
    p_certification: certification, p_recipients: recipients,
    p_revision: readRevision(metadata),
  })
  if (error) throw new Error(`Failed to record the certificate: ${error.message}`)
  // The transaction queued durable PDF + delivery work. The worker retries a failure.
  await finishPayApplicationCertification(orgId, { pay_application_id: payApplicationId }).catch(() => undefined)

  await recordEvent({
    orgId,
    actorId: actor.actorUserId,
    eventType: "pay_application.approved",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: {
      project_id: projectId,
      invoice_id: appRow.invoice_id,
      approved_at: certifiedAt,
      certified_by: signerName,
      source: actor.source,
      certified_amount_cents: certifiedAmount,
    },
  })
  await recordAudit({
    orgId,
    actorId: actor.actorUserId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    before: { status: appRow.status, approved_at: appRow.approved_at },
    after: { status: "approved", approved_at: certifiedAt, certification },
  })

  return { payApplicationId, invoiceId: appRow.invoice_id as string }
}

/** Record the owner's certificate from inside Arc (a signed paper, a phone call, an email). */
export async function certifyPayApplication(
  payApplicationId: string,
  input: CertifyPayApplicationInput,
  orgId?: string,
): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    permission: "invoice.approve",
    resourceId: payApplicationId,
  })
  const { data: member } = await supabase.from("app_users").select("full_name").eq("id", userId).maybeSingle()
  await certifyPayApplicationWithActor(
    {
      supabase,
      orgId: resolvedOrgId,
      productTier,
      actorUserId: userId,
      source: "internal",
      actorName: member?.full_name ?? null,
    },
    payApplicationId,
    input,
  )
  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

/**
 * Send the application back to the contractor. The SOV rollups reverse, the
 * invoice is voided, and the application returns to draft as the next revision
 * with the owner's reason on it — same number, so the sequence stays whole.
 */
export async function returnPayApplicationWithActor(
  actor: PayApplicationActor,
  payApplicationId: string,
  input: { reason: string },
): Promise<{ payApplicationId: string; revision: number }> {
  const { supabase, orgId } = actor
  const reason = input.reason.trim()
  if (reason.length < 3) throw new Error("Say why the application is being returned")
  const appRow = await loadApplication(supabase, orgId, payApplicationId)
  const projectId = appRow.project_id as string
  if (appRow.status === "paid") throw new Error("A paid pay application cannot be returned")
  if (appRow.status === "void") throw new Error("This pay application was voided")
  if (appRow.status === "draft") throw new Error("This pay application has not been submitted")
  if ((appRow.metadata as Record<string, unknown> | null)?.type === "retainage_release") {
    throw new Error("A retainage release cannot be returned. Void it instead.")
  }

  const service = createServiceSupabaseClient()
  const metadata = (appRow.metadata as Record<string, unknown> | null) ?? {}
  const previousRevision = readRevision(metadata)
  const returned: PayApplicationReturn = {
    reason, returned_at: new Date().toISOString(), source: actor.source,
    actor_name: actor.actorName, revision: previousRevision,
  }
  const { error } = await service.rpc("return_pay_application_atomic", {
    p_org_id: orgId, p_pay_application_id: payApplicationId, p_actor_id: actor.actorUserId,
    p_return: returned, p_revision: previousRevision,
  })
  if (error) throw new Error(`Failed to return the pay application: ${error.message}`)

  await recordEvent({
    orgId,
    actorId: actor.actorUserId,
    eventType: "pay_application.returned",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: {
      project_id: projectId,
      application_number: appRow.application_number,
      reason,
      source: actor.source,
      returned_by: actor.actorName,
      revision: previousRevision + 1,
    },
  })
  await recordAudit({
    orgId,
    actorId: actor.actorUserId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    before: { status: appRow.status, invoice_id: appRow.invoice_id },
    after: { status: "draft", revision: previousRevision + 1, returned },
  })

  return { payApplicationId, revision: previousRevision + 1 }
}

/** Record a return from inside Arc, on the owner's behalf. */
export async function returnPayApplication(
  payApplicationId: string,
  input: { reason: string },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  const { data: member } = await supabase.from("app_users").select("full_name").eq("id", userId).maybeSingle()
  await returnPayApplicationWithActor(
    { supabase, orgId: resolvedOrgId, productTier, actorUserId: userId, source: "internal", actorName: member?.full_name ?? null },
    payApplicationId,
    input,
  )
  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow, { productTier })
}

/* ------------------------------------------------------------------------- *
 * Owner portal reads. Token-gated by the caller; these run on the service
 * client and expose only what the owner is entitled to see.
 * ------------------------------------------------------------------------- */

export interface PortalPayApplicationSummary {
  id: string
  application_number: number
  period_start: string | null
  period_end: string
  stage: PayApplicationStage
  revision: number
  /** The nine G702 lines, so the portal reconciles against the PDF rather than deriving. */
  original_contract_sum_cents: number
  change_order_sum_cents: number
  contract_sum_to_date_cents: number
  total_completed_stored_cents: number
  retainage_cents: number
  total_earned_less_retainage_cents: number
  previous_certificates_cents: number
  current_payment_due_cents: number
  balance_to_finish_cents: number
  submitted_at: string | null
  certification: PayApplicationCertification | null
  returns: PayApplicationReturn[]
  is_retainage_release: boolean
  invoice_id: string | null
  invoice_status: string | null
  invoice_balance_due_cents: number | null
  pdf_file_id: string | null
  /** The owner may certify or return it. */
  awaiting_certificate: boolean
}

function toPortalSummary(app: PayApplication): PortalPayApplicationSummary {
  return {
    id: app.id,
    application_number: app.application_number,
    period_start: app.period_start,
    period_end: app.period_end,
    stage: app.stage,
    revision: app.revision,
    original_contract_sum_cents: app.original_contract_sum_cents,
    change_order_sum_cents: app.change_order_sum_cents,
    contract_sum_to_date_cents: app.contract_sum_to_date_cents,
    total_completed_stored_cents: app.total_completed_stored_cents,
    retainage_cents: app.retainage_cents,
    total_earned_less_retainage_cents: app.total_earned_less_retainage_cents,
    previous_certificates_cents: app.previous_certificates_cents,
    current_payment_due_cents: app.current_payment_due_cents,
    balance_to_finish_cents: app.balance_to_finish_cents,
    submitted_at: app.submitted_at,
    certification: app.certification,
    returns: app.returns,
    is_retainage_release: app.is_retainage_release,
    invoice_id: app.invoice_id,
    invoice_status: app.invoice_status,
    invoice_balance_due_cents: app.invoice_balance_due_cents ?? null,
    pdf_file_id: app.pdf_file_id,
    awaiting_certificate: app.certification_required && app.stage === "awaiting_certification",
  }
}

/** Posted applications only: the owner never sees a draft, a return-in-progress, or a void. */
export async function listPayApplicationsForPortal(args: { orgId: string; projectId: string }): Promise<PortalPayApplicationSummary[]> {
  const service = createServiceSupabaseClient()
  const { data: org } = await service.from("orgs").select("product_tier").eq("id", args.orgId).maybeSingle()
  const apps = await listPayApplicationsWithClient(service, args.orgId, args.projectId, normalizeProductTier(org?.product_tier))
  return apps.filter((app) => app.status !== "draft" && app.status !== "void").map(toPortalSummary)
}

export async function getPayApplicationForPortal(args: {
  orgId: string
  projectId: string
  payApplicationId: string
}): Promise<{ application: PortalPayApplicationSummary; lines: PayApplicationLine[]; productTier: ProductTier } | null> {
  const service = createServiceSupabaseClient()
  const { data: org } = await service.from("orgs").select("product_tier").eq("id", args.orgId).maybeSingle()
  const productTier = normalizeProductTier(org?.product_tier)
  const { data: row } = await service
    .from("pay_applications")
    .select(PAY_APP_SELECT)
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.payApplicationId)
    .maybeSingle()
  if (!row || row.status === "draft" || row.status === "void") return null
  const detail = await buildDetail(service, args.orgId, row, { productTier })
  return { application: toPortalSummary(detail.application), lines: detail.lines, productTier }
}

/* ------------------------------------------------------------------------- *
 * Workspace context: the parts of the printed application that do not change
 * while the builder types. The live numbers come from the pure math in
 * `lib/financials/pay-app-math.ts`, computed in the browser, so the preview
 * updates on every keystroke without a round trip.
 * ------------------------------------------------------------------------- */

export interface PayApplicationWorkspaceContext {
  progressEvidence: PayApplicationProgressEvidence[]
  ownerName: string
  contractorName: string
  projectName: string
  propertyDescription: string | null
  contractDateIso: string | null
  changeOrders: Array<{ title: string; amountCents: number }>
  changeOrderSumCents: number
  originalContractSumCents: number
  /** Net retainage held across the SOV before the open application. */
  previousRetainageHeldCents: number
  storedMaterialsRetainagePercent: number | null
  /** The customer's email, offered as the default recipient when sending. */
  ownerEmail: string | null
  /** An application bills against the SOV, so with no lines there is nothing to bill. */
  hasSovLines: boolean
  /** Non-zero means the schedule does not foot to the contract sum, which blocks submitting. */
  sovVarianceCents: number
}

export async function getPayApplicationWorkspaceContext(
  projectId: string,
  orgId?: string,
  periodEnd?: string,
): Promise<PayApplicationWorkspaceContext> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const [{ data: project }, { data: org }, contract, { data: contractDates }, sovState, changeOrderRows] = await Promise.all([
    supabase.from("projects").select("name, location, client_id").eq("org_id", resolvedOrgId).eq("id", projectId).maybeSingle(),
    supabase.from("orgs").select("name").eq("id", resolvedOrgId).maybeSingle(),
    getProgressBillingContract(supabase, resolvedOrgId, projectId),
    supabase
      .from("contracts")
      .select("signed_at, effective_date")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["active", "amended", "completed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    listPrimeSovLines(projectId, resolvedOrgId),
    supabase
      .from("change_orders")
      .select("title, total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("lifecycle", "approved")
      .order("created_at", { ascending: true }),
  ])

  const { data: client } = project?.client_id
    ? await supabase.from("contacts").select("full_name, email").eq("org_id", resolvedOrgId).eq("id", project.client_id).maybeSingle()
    : { data: null }

  const changeOrders = (changeOrderRows.data ?? []).map((row) => ({
    title: (row.title as string) ?? "Change order",
    amountCents: Number(row.total_cents ?? 0),
  }))

  const { data: evidenceRows, error: evidenceError } = await supabase.from("vendor_bill_sov_allocations")
    .select("bill_id, budget_line_id, commitment_sov_line_id, previous_billed_cents, current_billed_cents, stored_materials_cents, bill:vendor_bills!inner(bill_number, bill_date, approved_at, status, project_id), sov:commitment_sov_lines(scheduled_value_cents)")
    .eq("org_id", resolvedOrgId).eq("bill.project_id", projectId)
    .in("bill.status", ["approved", "partial", "paid"]).not("bill.approved_at", "is", null)
    .lte("bill.bill_date", periodEnd ?? new Date().toISOString().slice(0, 10))
  if (evidenceError) throw new Error(`Failed to load approved progress evidence: ${evidenceError.message}`)
  const evidence: ApprovedSovEvidenceRow[] = (evidenceRows ?? []).flatMap((row) => {
    const bill = Array.isArray(row.bill) ? row.bill[0] : row.bill
    const sov = Array.isArray(row.sov) ? row.sov[0] : row.sov
    if (!bill || !sov || !row.budget_line_id || !row.commitment_sov_line_id) return []
    return [{ billId: row.bill_id, billNumber: bill.bill_number ?? "Vendor bill", billDate: bill.bill_date,
      approvedAt: bill.approved_at, commitmentSovLineId: row.commitment_sov_line_id, budgetLineId: row.budget_line_id,
      previousWorkCents: Number(row.previous_billed_cents), currentWorkCents: Number(row.current_billed_cents),
      storedMaterialsCents: Number(row.stored_materials_cents), scheduledCents: Number(sov.scheduled_value_cents) }]
  })

  return {
    progressEvidence: buildPayApplicationProgressEvidence(sovState.lines, evidence),
    ownerName: client?.full_name ?? "Owner",
    contractorName: org?.name ?? "Contractor",
    projectName: project?.name ?? "Project",
    propertyDescription: projectPropertyText(project?.location),
    contractDateIso: contractDates?.signed_at ?? contractDates?.effective_date ?? null,
    changeOrders,
    changeOrderSumCents: changeOrders.reduce((sum, row) => sum + row.amountCents, 0),
    originalContractSumCents: resolveOriginalContractSum(contract),
    previousRetainageHeldCents: sovState.lines.reduce(
      (sum, line) => sum + line.retainage_held_cents - line.retainage_released_cents,
      0,
    ),
    storedMaterialsRetainagePercent:
      contract?.stored_materials_retainage_percent != null ? Number(contract.stored_materials_retainage_percent) : null,
    ownerEmail: client?.email ?? null,
    hasSovLines: sovState.lines.length > 0,
    sovVarianceCents: sovState.summary?.variance_cents ?? 0,
  }
}

function projectPropertyText(location: unknown): string | null {
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

/** Durable certificate delivery; only the frozen certified invoice can be delivered. */
export async function finishPayApplicationCertification(orgId: string, payload: { pay_application_id: string }) {
  const service = createServiceSupabaseClient()
  const app = await loadApplication(service, orgId, payload.pay_application_id)
  if (app.status !== "approved" && app.status !== "paid") return
  if (!app.invoice_id) throw new Error("Certified application is missing its invoice")
  await renderAndStorePayApplicationPdf({ orgId, projectId: String(app.project_id), payApplicationId: String(app.id), createdBy: submittedBy(app) })
  const { data: invoice, error } = await service.from("invoices")
    .select("id, invoice_number, project_id, total_cents, due_date, sent_to_emails, status")
    .eq("org_id", orgId).eq("id", app.invoice_id).single()
  if (error || !invoice) throw new Error("Certified invoice could not be loaded")
  if (invoice.status === "void") return
  await runInvoiceIssuance(orgId, { invoice_id: invoice.id, invoice_number: invoice.invoice_number,
    project_id: invoice.project_id, total_cents: invoice.total_cents, due_date: invoice.due_date,
    sent_to_emails: invoice.sent_to_emails ?? [] })
}
