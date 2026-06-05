import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import type { ProjectBillingModel } from "@/lib/financials/billing-model"
import {
  assertApprovedCostInvoiceBillingModelAllowed,
  isCostDrivenBillingModel,
  resolveProjectBillingModel,
} from "@/lib/financials/billing-model"
import type { ProjectInput } from "@/lib/validation/projects"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"

export type ProjectFinancialSetupStatus = "complete" | "needs_setup"

export interface ProjectFinancialSettings {
  id: string
  org_id: string
  project_id: string
  billing_model: ProjectBillingModel
  paid_costs_required: boolean
  proof_required: boolean
  client_cost_approval_required: boolean
  open_book_required: boolean
  cost_codes_enabled: boolean
  setup_completed_at?: string | null
  setup_completed_by?: string | null
  metadata?: Record<string, any>
}

export interface ProjectFinancialSetupIssue {
  code: string
  severity: "blocking" | "warning"
  message: string
}

export interface ProjectFinancialSetupStatusResult {
  projectId: string
  billingModel: ProjectBillingModel
  status: ProjectFinancialSetupStatus
  settings: ProjectFinancialSettings | null
  contract: {
    id?: string | null
    total_cents?: number | null
    markup_percent?: number | null
    gmp_cents?: number | null
    fixed_fee_cents?: number | null
    savings_split_owner_pct?: number | null
    savings_split_builder_pct?: number | null
    labor_burden_multiplier?: number | null
    retainage_percent?: number | null
  } | null
  issues: ProjectFinancialSetupIssue[]
}

type ContractLike = {
  id?: string | null
  title?: string | null
  contract_type?: string | null
  total_cents?: number | null
  currency?: string | null
  markup_percent?: number | null
  gmp_cents?: number | null
  savings_split_owner_pct?: number | null
  savings_split_builder_pct?: number | null
  labor_burden_multiplier?: number | null
  retainage_percent?: number | null
  open_book?: boolean | null
  requires_client_cost_approval?: boolean | null
  snapshot?: Record<string, any> | null
}

const BILLING_MODELS = new Set<ProjectBillingModel>([
  "fixed_price",
  "cost_plus_percent",
  "cost_plus_fixed_fee",
  "cost_plus_gmp",
  "time_and_materials",
])

const financialSetupInputSchema = z.object({
  projectId: z.string().uuid(),
  billingModel: z.enum(["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"]),
  totalContractValueCents: z.number().int().nonnegative().optional().nullable(),
  retainagePercent: z.number().min(0).max(100).optional().nullable(),
  markupPercent: z.number().min(0).max(200).optional().nullable(),
  gmpCents: z.number().int().nonnegative().optional().nullable(),
  fixedFeeCents: z.number().int().nonnegative().optional().nullable(),
  savingsSplitOwnerPct: z.number().min(0).max(100).optional().nullable(),
  savingsSplitBuilderPct: z.number().min(0).max(100).optional().nullable(),
  laborBurdenMultiplier: z.number().min(1).optional().nullable(),
  paidCostsRequired: z.boolean().default(false),
  proofRequired: z.boolean().default(false),
  clientCostApprovalRequired: z.boolean().default(false),
  openBookRequired: z.boolean().default(false),
  costCodesEnabled: z.boolean().default(true),
})

export type FinancialSetupInput = z.infer<typeof financialSetupInputSchema>

function normalizeBillingModel(value?: string | null): ProjectBillingModel | null {
  return value && BILLING_MODELS.has(value as ProjectBillingModel) ? (value as ProjectBillingModel) : null
}

function contractTypeForBillingModel(model: ProjectBillingModel): "fixed" | "cost_plus" | "time_materials" {
  if (model === "time_and_materials") return "time_materials"
  if (model === "fixed_price") return "fixed"
  return "cost_plus"
}

function mapSettings(row: any): ProjectFinancialSettings {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    billing_model: row.billing_model,
    paid_costs_required: row.paid_costs_required ?? false,
    proof_required: row.proof_required ?? false,
    client_cost_approval_required: row.client_cost_approval_required ?? false,
    open_book_required: row.open_book_required ?? false,
    cost_codes_enabled: row.cost_codes_enabled ?? true,
    setup_completed_at: row.setup_completed_at ?? null,
    setup_completed_by: row.setup_completed_by ?? null,
    metadata: row.metadata ?? {},
  }
}

export async function getProjectFinancialSettings({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data, error } = await supabase
    .from("project_financial_settings")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load project financial settings: ${error.message}`)
  }

  return data ? mapSettings(data) : null
}

async function getActiveContract(params: { supabase: SupabaseClient; orgId: string; projectId: string }): Promise<ContractLike | null> {
  const { data, error } = await params.supabase
    .from("contracts")
    .select("id, title, contract_type, total_cents, currency, markup_percent, gmp_cents, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, retainage_percent, open_book, requires_client_cost_approval, snapshot")
    .eq("org_id", params.orgId)
    .eq("project_id", params.projectId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load project billing contract: ${error.message}`)
  }

  return data
}

export async function getProjectFinancialSetupStatus({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}): Promise<ProjectFinancialSetupStatusResult> {
  const [settings, contract] = await Promise.all([
    getProjectFinancialSettings({ supabase, orgId, projectId }),
    getActiveContract({ supabase, orgId, projectId }),
  ])

  const billingModel = settings?.billing_model ?? resolveProjectBillingModel(contract as any)
  const issues: ProjectFinancialSetupIssue[] = []
  const contractBillingModel = contract ? resolveProjectBillingModel(contract as any) : null

  if (!settings) {
    issues.push({
      code: "financial_settings_missing",
      severity: "blocking",
      message: "Project financial setup is missing. Open Project Settings and save the billing setup.",
    })
  }

  if (!contract) {
    issues.push({
      code: "active_contract_missing",
      severity: "blocking",
      message: "An active billing contract is required before financial actions can run.",
    })
  }

  if (settings && contractBillingModel && settings.billing_model !== contractBillingModel) {
    issues.push({
      code: "billing_model_contract_mismatch",
      severity: "blocking",
      message: "Project financial setup does not match the active billing contract. Re-save the project billing setup before running financial actions.",
    })
  }

  if (billingModel === "fixed_price" && !contract?.total_cents) {
    issues.push({
      code: "contract_value_missing",
      severity: "warning",
      message: "Fixed-price projects need a contract value for draw billing and WIP reporting.",
    })
  }

  if (billingModel === "cost_plus_percent" && contract?.markup_percent == null) {
    issues.push({
      code: "markup_missing",
      severity: "blocking",
      message: "Cost-plus percentage projects need a markup percent, even if it is 0%.",
    })
  }

  if (billingModel === "cost_plus_gmp" && !contract?.gmp_cents) {
    issues.push({
      code: "gmp_missing",
      severity: "blocking",
      message: "Cost-plus GMP projects need a GMP amount before approved costs can be billed.",
    })
  }

  if (billingModel === "cost_plus_fixed_fee") {
    const fixedFeeCents = Number(contract?.snapshot?.fixed_fee_cents ?? settings?.metadata?.fixed_fee_cents ?? 0)
    if (!fixedFeeCents) {
      issues.push({
        code: "fixed_fee_schedule_missing",
        severity: "warning",
        message: "Fixed-fee cost-plus projects need a fee amount or schedule before fee billing is complete.",
      })
    }
  }

  if (isCostDrivenBillingModel(billingModel) && settings?.open_book_required && contract?.open_book === false) {
    issues.push({
      code: "open_book_conflict",
      severity: "blocking",
      message: "Financial setup requires open-book billing, but the active contract has open book disabled.",
    })
  }

  return {
    projectId,
    billingModel,
    settings,
    contract: contract
      ? {
          id: contract.id ?? null,
          total_cents: contract.total_cents ?? null,
          markup_percent: contract.markup_percent ?? null,
          gmp_cents: contract.gmp_cents ?? null,
          fixed_fee_cents: Number(contract.snapshot?.fixed_fee_cents ?? settings?.metadata?.fixed_fee_cents ?? 0) || null,
          savings_split_owner_pct: contract.savings_split_owner_pct ?? null,
          savings_split_builder_pct: contract.savings_split_builder_pct ?? null,
          labor_burden_multiplier: contract.labor_burden_multiplier ?? null,
          retainage_percent: contract.retainage_percent ?? null,
        }
      : null,
    issues,
    status: issues.some((issue) => issue.severity === "blocking") ? "needs_setup" : "complete",
  }
}

export async function upsertProjectFinancialSettingsFromProjectInput(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  userId?: string | null
  input: Partial<ProjectInput>
  existingContract?: ContractLike | null
}) {
  const billingModel = normalizeBillingModel(args.input.billing_model) ?? resolveProjectBillingModel(args.existingContract as any)
  const isCostPlus = billingModel === "cost_plus_percent" || billingModel === "cost_plus_fixed_fee" || billingModel === "cost_plus_gmp"
  const existingSettings = await getProjectFinancialSettings({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
  }).catch(() => null)
  const now = new Date().toISOString()
  const fixedFeeCents =
    billingModel === "cost_plus_fixed_fee"
      ? args.input.fixed_fee_cents ?? (args.existingContract?.snapshot as any)?.fixed_fee_cents ?? null
      : null
  const metadata = {
    source: "project_settings",
    updated_from_project_form_at: now,
    fixed_fee_cents: fixedFeeCents,
  }

  const payload = {
    org_id: args.orgId,
    project_id: args.projectId,
    billing_model: billingModel,
    paid_costs_required:
      args.input.paid_costs_required ?? Boolean((args.existingContract?.snapshot as any)?.paid_costs_required ?? false),
    proof_required:
      args.input.proof_required ?? Boolean((args.existingContract?.snapshot as any)?.proof_required ?? false),
    client_cost_approval_required:
      args.input.requires_client_cost_approval ?? args.existingContract?.requires_client_cost_approval ?? false,
    open_book_required: isCostPlus ? args.input.open_book ?? args.existingContract?.open_book ?? true : false,
    cost_codes_enabled: args.input.cost_codes_enabled ?? existingSettings?.cost_codes_enabled ?? true,
    setup_completed_at: now,
    setup_completed_by: args.userId ?? null,
    updated_by: args.userId ?? null,
    created_by: args.userId ?? null,
    metadata,
  }

  const { data, error } = await args.supabase
    .from("project_financial_settings")
    .upsert(payload, { onConflict: "org_id,project_id" })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to save project financial settings: ${error?.message}`)
  }

  return mapSettings(data)
}

export async function saveProjectFinancialSetup(input: FinancialSetupInput, orgId?: string) {
  const parsed = financialSetupInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const ownerPct = parsed.savingsSplitOwnerPct ?? 0
  const builderPct = parsed.savingsSplitBuilderPct ?? 0
  if (ownerPct + builderPct > 100) {
    throw new Error("Savings split percentages cannot exceed 100%.")
  }

  if (parsed.billingModel === "cost_plus_gmp" && !parsed.gmpCents) {
    throw new Error("Cost-plus GMP setup needs a GMP amount.")
  }

  if (parsed.billingModel === "cost_plus_fixed_fee" && !parsed.fixedFeeCents) {
    throw new Error("Cost-plus fixed-fee setup needs a fixed fee amount.")
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name, org_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.projectId)
    .maybeSingle()

  if (projectError || !project) {
    throw new Error("Project not found")
  }

  const existingContract = await getActiveContract({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId })
  const contractPayload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    title: existingContract?.title ?? `${project.name} Contract`,
    status: "active",
    contract_type: contractTypeForBillingModel(parsed.billingModel),
    total_cents: parsed.totalContractValueCents ?? null,
    currency: existingContract?.currency ?? "usd",
    markup_percent:
      parsed.billingModel === "cost_plus_percent" ||
      parsed.billingModel === "cost_plus_gmp" ||
      parsed.billingModel === "time_and_materials"
        ? parsed.markupPercent ?? 0
        : null,
    gmp_cents: parsed.billingModel === "cost_plus_gmp" ? parsed.gmpCents ?? null : null,
    savings_split_owner_pct: parsed.billingModel === "cost_plus_gmp" ? ownerPct : 0,
    savings_split_builder_pct: parsed.billingModel === "cost_plus_gmp" ? builderPct : 0,
    labor_burden_multiplier: parsed.laborBurdenMultiplier ?? 1,
    requires_client_cost_approval: parsed.clientCostApprovalRequired,
    open_book: parsed.openBookRequired,
    retainage_percent: parsed.retainagePercent ?? 0,
    snapshot: {
      ...(existingContract?.snapshot ?? {}),
      billing_setup_source: "financial_setup_wizard",
      billing_model: parsed.billingModel,
      paid_costs_required: parsed.paidCostsRequired,
      proof_required: parsed.proofRequired,
      fixed_fee_cents: parsed.billingModel === "cost_plus_fixed_fee" ? parsed.fixedFeeCents ?? null : null,
    },
  }

  let contractId = existingContract?.id ?? undefined
  let savedContract: any
  if (contractId) {
    const { data, error } = await supabase
      .from("contracts")
      .update(contractPayload)
      .eq("org_id", resolvedOrgId)
      .eq("id", contractId)
      .select("*")
      .single()
    if (error || !data) throw new Error(`Failed to update billing contract: ${error?.message}`)
    savedContract = data
  } else {
    const { data, error } = await supabase.from("contracts").insert(contractPayload).select("*").single()
    if (error || !data) throw new Error(`Failed to create billing contract: ${error?.message}`)
    savedContract = data
    contractId = data.id
  }

  const settingsPayload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    billing_model: parsed.billingModel,
    paid_costs_required: parsed.paidCostsRequired,
    proof_required: parsed.proofRequired,
    client_cost_approval_required: parsed.clientCostApprovalRequired,
    open_book_required: parsed.openBookRequired,
    cost_codes_enabled: parsed.costCodesEnabled,
    setup_completed_at: new Date().toISOString(),
    setup_completed_by: userId,
    updated_by: userId,
    created_by: userId,
    metadata: {
      source: "financial_setup_wizard",
      contract_id: contractId,
      fixed_fee_cents: parsed.billingModel === "cost_plus_fixed_fee" ? parsed.fixedFeeCents ?? null : null,
      updated_at: new Date().toISOString(),
    },
  }

  const { data: settings, error: settingsError } = await supabase
    .from("project_financial_settings")
    .upsert(settingsPayload, { onConflict: "org_id,project_id" })
    .select("*")
    .single()

  if (settingsError || !settings) {
    throw new Error(`Failed to save project financial settings: ${settingsError?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: existingContract ? "update" : "insert",
    entityType: "contract",
    entityId: contractId,
    before: existingContract ?? null,
    after: savedContract,
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project_financial_settings",
    entityId: settings.id,
    after: settings,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_financial_setup_saved",
    entityType: "project",
    entityId: parsed.projectId,
    payload: {
      billing_model: parsed.billingModel,
      paid_costs_required: parsed.paidCostsRequired,
      proof_required: parsed.proofRequired,
      client_cost_approval_required: parsed.clientCostApprovalRequired,
      open_book_required: parsed.openBookRequired,
      cost_codes_enabled: parsed.costCodesEnabled,
    },
  })

  return getProjectFinancialSetupStatus({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId })
}

export async function assertProjectFinancialSetupAllowsAction(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  action: "approved_cost_invoice"
}) {
  const status = await getProjectFinancialSetupStatus(args)
  const blockingIssues = status.issues.filter((issue) => issue.severity === "blocking")
  if (blockingIssues.length > 0) {
    throw new Error(blockingIssues.map((issue) => issue.message).join(" "))
  }

  if (args.action === "approved_cost_invoice") {
    assertApprovedCostInvoiceBillingModelAllowed(status.billingModel)
  }

  return status
}

export async function assertApprovedCostsMeetProjectFinancialRules(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  costIds: string[]
}) {
  const setup = await assertProjectFinancialSetupAllowsAction({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
    action: "approved_cost_invoice",
  })
  const settings = setup.settings
  if (!settings?.paid_costs_required && !settings?.proof_required) return setup

  const { data: costs, error } = await args.supabase
    .from("billable_costs")
    .select("id, source_type, source_id, description")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .in("id", args.costIds)

  if (error) {
    throw new Error(`Failed to validate approved-cost billing rules: ${error.message}`)
  }

  const billLineIds = (costs ?? []).filter((cost) => cost.source_type === "vendor_bill_line").map((cost) => cost.source_id)
  const expenseIds = (costs ?? []).filter((cost) => cost.source_type === "project_expense").map((cost) => cost.source_id)
  const timeEntryIds = (costs ?? []).filter((cost) => cost.source_type === "time_entry").map((cost) => cost.source_id)

  const [billLinesResult, expensesResult, timeEntriesResult] = await Promise.all([
    billLineIds.length
      ? args.supabase
          .from("bill_lines")
          .select("id, bill:vendor_bills(id, status, file_id, paid_cents, total_cents)")
          .eq("org_id", args.orgId)
          .in("id", billLineIds)
      : Promise.resolve({ data: [], error: null }),
    expenseIds.length
      ? args.supabase
          .from("project_expenses")
          .select("id, receipt_file_id, status")
          .eq("org_id", args.orgId)
          .in("id", expenseIds)
      : Promise.resolve({ data: [], error: null }),
    timeEntryIds.length
      ? args.supabase
          .from("time_entries")
          .select("id, attached_file_ids, status")
          .eq("org_id", args.orgId)
          .in("id", timeEntryIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (billLinesResult.error) throw new Error(`Failed to validate vendor bill proof: ${billLinesResult.error.message}`)
  if (expensesResult.error) throw new Error(`Failed to validate expense proof: ${expensesResult.error.message}`)
  if (timeEntriesResult.error) throw new Error(`Failed to validate time proof: ${timeEntriesResult.error.message}`)

  const billLineById = new Map((billLinesResult.data ?? []).map((row: any) => [row.id, row]))
  const expenseById = new Map((expensesResult.data ?? []).map((row: any) => [row.id, row]))
  const timeEntryById = new Map((timeEntriesResult.data ?? []).map((row: any) => [row.id, row]))

  const paidRuleFailures: string[] = []
  const proofRuleFailures: string[] = []
  for (const cost of costs ?? []) {
    const sourceType = String(cost.source_type)
    const label = cost.description || cost.id
    const billLine = billLineById.get(cost.source_id)
    const bill = Array.isArray(billLine?.bill) ? billLine.bill[0] : billLine?.bill
    const expense = expenseById.get(cost.source_id)
    const timeEntry = timeEntryById.get(cost.source_id)

    if (settings?.paid_costs_required && sourceType === "vendor_bill_line" && bill?.status !== "paid") {
      paidRuleFailures.push(label)
    }

    if (settings?.proof_required) {
      const hasProof =
        (sourceType === "vendor_bill_line" && Boolean(bill?.file_id)) ||
        (sourceType === "project_expense" && Boolean(expense?.receipt_file_id)) ||
        (sourceType === "time_entry" && Array.isArray(timeEntry?.attached_file_ids) && timeEntry.attached_file_ids.length > 0) ||
        sourceType === "manual_adjustment" ||
        sourceType === "allowance_overage"

      if (!hasProof) proofRuleFailures.push(label)
    }
  }

  if (paidRuleFailures.length > 0) {
    throw new Error(`This project bills paid costs only. Mark these vendor bills paid before invoicing: ${paidRuleFailures.slice(0, 5).join(", ")}.`)
  }

  if (proofRuleFailures.length > 0) {
    throw new Error(`This project requires billing proof. Add proof before invoicing: ${proofRuleFailures.slice(0, 5).join(", ")}.`)
  }

  return setup
}

export async function getProjectFinancialSetupStatusForProject(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return getProjectFinancialSetupStatus({ supabase, orgId: resolvedOrgId, projectId })
}
