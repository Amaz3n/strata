import type { SupabaseClient } from "@supabase/supabase-js"

export const APPROVAL_GATE_REASONS = {
  timeMissingRate: "Set a labor rate before approval.",
  missingCostCode: "Choose a cost code.",
  timeMissingProof: "Attach time backup before billing.",
  expenseNotSubmitted: "Submit expense before approval.",
  expenseMissingProof: "Attach receipt proof before billing.",
  vendorBillLineMissingCostCode: "Every vendor bill line needs a cost code.",
  vendorBillMissingProof: "Attach vendor bill proof before billing.",
  vendorBillPaymentRequired: "Mark vendor bill paid before owner billing.",
} as const

export interface ApprovalGateSettings {
  cost_codes_enabled: boolean
  proof_required: boolean
  paid_costs_required: boolean
}

function compactReasons(reasons: Array<string | null>): string[] {
  return reasons.filter((reason): reason is string => Boolean(reason))
}

export async function loadApprovalGateSettings({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}): Promise<ApprovalGateSettings> {
  const { data, error } = await supabase
    .from("project_financial_settings")
    .select("cost_codes_enabled, proof_required, paid_costs_required")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load project financial approval settings: ${error.message}`)
  }

  return {
    cost_codes_enabled: data?.cost_codes_enabled ?? true,
    proof_required: data?.proof_required ?? false,
    paid_costs_required: data?.paid_costs_required ?? false,
  }
}

export function getTimeEntryApprovalBlockingReasons(
  entry: {
    base_rate_cents?: number | null
    cost_code_id?: string | null
    attached_file_ids?: string[] | null
  },
  settings: ApprovalGateSettings,
): string[] {
  return compactReasons([
    Number(entry.base_rate_cents ?? 0) <= 0 ? APPROVAL_GATE_REASONS.timeMissingRate : null,
    settings.cost_codes_enabled && !entry.cost_code_id ? APPROVAL_GATE_REASONS.missingCostCode : null,
    settings.proof_required && (!Array.isArray(entry.attached_file_ids) || entry.attached_file_ids.length === 0)
      ? APPROVAL_GATE_REASONS.timeMissingProof
      : null,
  ])
}

export function getExpenseApprovalBlockingReasons(
  expense: {
    status?: string | null
    cost_code_id?: string | null
    receipt_file_id?: string | null
  },
  settings: ApprovalGateSettings,
): string[] {
  return compactReasons([
    expense.status !== "submitted" ? APPROVAL_GATE_REASONS.expenseNotSubmitted : null,
    settings.cost_codes_enabled && !expense.cost_code_id ? APPROVAL_GATE_REASONS.missingCostCode : null,
    settings.proof_required && !expense.receipt_file_id ? APPROVAL_GATE_REASONS.expenseMissingProof : null,
  ])
}

export function getVendorBillApprovalBlockingReasons(
  bill: {
    file_id?: string | null
    paid_cents?: number | null
    total_cents?: number | null
  },
  lines: Array<{ cost_code_id?: string | null }>,
  settings: ApprovalGateSettings,
): string[] {
  const totalCents = Number(bill.total_cents ?? 0)
  const isPaid = totalCents > 0 && Number(bill.paid_cents ?? 0) >= totalCents
  const hasCompleteCoding = !settings.cost_codes_enabled || (lines.length > 0 && lines.every((line) => Boolean(line.cost_code_id)))

  return compactReasons([
    !hasCompleteCoding ? APPROVAL_GATE_REASONS.vendorBillLineMissingCostCode : null,
    settings.proof_required && !bill.file_id ? APPROVAL_GATE_REASONS.vendorBillMissingProof : null,
    settings.paid_costs_required && !isPaid ? APPROVAL_GATE_REASONS.vendorBillPaymentRequired : null,
  ])
}

export function assertApprovalAllowed(reasons: string[]) {
  if (reasons.length > 0) {
    throw new Error(reasons[0])
  }
}
