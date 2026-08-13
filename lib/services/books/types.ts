export type BooksLedgerAuthority = "external" | "arc"
export type ArcLedgerMode = "disabled" | "shadow" | "parallel" | "official"
export type ExternalSyncPosture = "normal" | "outbound_mirror" | "disconnected"

export type BooksOperatingPosture = {
  ledgerAuthority: BooksLedgerAuthority
  arcLedgerMode: ArcLedgerMode
  externalSyncPosture: ExternalSyncPosture
}

export type GlAccountType = "asset" | "liability" | "equity" | "income" | "cogs" | "expense"
export type NormalBalance = "debit" | "credit"
export type CashFlowCategory = "operating" | "investing" | "financing" | "cash"

/**
 * Semantic buckets the statements and close checks branch on. Free-text subtypes
 * would let a typo silently orphan an account from the balance sheet, so the set
 * is closed here and mirrored by a CHECK constraint on `gl_accounts.subtype`.
 */
export const GL_ACCOUNT_SUBTYPES = [
  "cash",
  "undeposited_funds",
  "accounts_receivable",
  "retainage_receivable",
  "costs_in_excess",
  "work_in_progress",
  "prepaid_expenses",
  "fixed_assets",
  "accumulated_depreciation",
  "other_asset",
  "accounts_payable",
  "retainage_payable",
  "credit_card",
  "payroll_clearing",
  "sales_use_tax",
  "customer_deposits",
  "billings_in_excess",
  "current_debt",
  "long_term_debt",
  "other_liability",
  "owner_equity",
  "owner_contributions",
  "owner_distributions",
  "retained_earnings",
  "construction_revenue",
  "other_revenue",
  "early_pay_discount",
  "payment_fee_recovery",
  "job_costs",
  "subcontractor_costs",
  "material_costs",
  "direct_labor",
  "equipment_costs",
  "warranty_costs",
  "rent",
  "insurance",
  "software",
  "professional_fees",
  "utilities",
  "bank_fees",
  "interest",
  "payroll",
  "depreciation",
  "other_expense",
] as const

export type GlAccountSubtype = (typeof GL_ACCOUNT_SUBTYPES)[number]

export const GL_ACCOUNT_SUBTYPE_TYPES: Record<GlAccountSubtype, GlAccountType> = {
  cash: "asset",
  undeposited_funds: "asset",
  accounts_receivable: "asset",
  retainage_receivable: "asset",
  costs_in_excess: "asset",
  work_in_progress: "asset",
  prepaid_expenses: "asset",
  fixed_assets: "asset",
  accumulated_depreciation: "asset",
  other_asset: "asset",
  accounts_payable: "liability",
  retainage_payable: "liability",
  credit_card: "liability",
  payroll_clearing: "liability",
  sales_use_tax: "liability",
  customer_deposits: "liability",
  billings_in_excess: "liability",
  current_debt: "liability",
  long_term_debt: "liability",
  other_liability: "liability",
  owner_equity: "equity",
  owner_contributions: "equity",
  owner_distributions: "equity",
  retained_earnings: "equity",
  construction_revenue: "income",
  other_revenue: "income",
  early_pay_discount: "income",
  payment_fee_recovery: "income",
  job_costs: "cogs",
  subcontractor_costs: "cogs",
  material_costs: "cogs",
  direct_labor: "cogs",
  equipment_costs: "cogs",
  warranty_costs: "cogs",
  rent: "expense",
  insurance: "expense",
  software: "expense",
  professional_fees: "expense",
  utilities: "expense",
  bank_fees: "expense",
  interest: "expense",
  payroll: "expense",
  depreciation: "expense",
  other_expense: "expense",
}

export function normalBalanceForSubtype(subtype: GlAccountSubtype): NormalBalance {
  if (subtype === "accumulated_depreciation") return "credit"
  if (subtype === "owner_distributions") return "debit"
  return ["liability", "equity", "income"].includes(GL_ACCOUNT_SUBTYPE_TYPES[subtype])
    ? "credit"
    : "debit"
}

export function isGlAccountSubtype(value: string): value is GlAccountSubtype {
  return (GL_ACCOUNT_SUBTYPES as readonly string[]).includes(value)
}

export type ChartAccountTemplate = {
  code: string
  name: string
  accountType: GlAccountType
  subtype: GlAccountSubtype
  normalBalance: NormalBalance
  cashFlowCategory?: CashFlowCategory
  system: boolean
}

export type JournalLineDraft = {
  accountCode: string
  debitCents: number
  creditCents: number
  description?: string
  projectId?: string
  companyId?: string
  dimensions?: Record<string, unknown>
}

export type JournalEntryDraft = {
  entryDate: string
  entryKind: "operational" | "adjusting" | "opening" | "poc" | "closing" | "reversal"
  memo: string
  /**
   * Unique per organization. MUST embed `projectionVersion` so that re-projecting
   * under a new rule set writes a parallel version instead of colliding with the
   * old one on `journal_entries.unique (org_id, posting_key)` — re-projection is
   * the correctness escape hatch and it depends on this.
   */
  postingKey: string
  projectionVersion: number
  policyVersion: number
  sourceType?: string
  sourceId?: string
  reversalOfEntryId?: string
  lines: JournalLineDraft[]
}

/**
 * Builds a version-scoped posting key. Every posting rule routes through this.
 *
 * `sourceVersion` distinguishes successive economic revisions of the same source
 * record: when a bill's amount genuinely changes, the projector supersedes the
 * old fact, reverses its entry, and posts a new one — which needs a key that does
 * not collide with the entry it replaces. `projectionVersion` does the same for a
 * change to the posting rules themselves.
 */
export function buildPostingKey(
  base: string,
  versions: { projectionVersion: number; sourceVersion?: number },
) {
  const sourceVersion = versions.sourceVersion ?? 1
  if (!Number.isSafeInteger(versions.projectionVersion) || versions.projectionVersion <= 0) {
    throw new Error("Projection version must be a positive integer")
  }
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion <= 0) {
    throw new Error("Source version must be a positive integer")
  }
  return `${base}:s${sourceVersion}:v${versions.projectionVersion}`
}

export type AccountingFactDraft = {
  sourceType: string
  sourceId: string
  sourceVersion: number
  factKind: string
  occurredAt: string
  accountingDate: string
  payload: Record<string, unknown>
  policyVersion: number
  supersedesFactId?: string
  reversalOfFactId?: string
}

export function assertIntegerCents(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of cents`)
  }
}

export function assertBalancedJournalDraft(draft: JournalEntryDraft) {
  if (draft.lines.length < 2) throw new Error("A journal entry requires at least two lines")

  let debitCents = 0
  let creditCents = 0
  for (const [index, line] of draft.lines.entries()) {
    assertIntegerCents(line.debitCents, `Line ${index + 1} debit`)
    assertIntegerCents(line.creditCents, `Line ${index + 1} credit`)
    const hasDebit = line.debitCents > 0 && line.creditCents === 0
    const hasCredit = line.creditCents > 0 && line.debitCents === 0
    if (!hasDebit && !hasCredit) {
      throw new Error(`Line ${index + 1} must contain exactly one positive debit or credit`)
    }
    debitCents += line.debitCents
    creditCents += line.creditCents
  }

  if (debitCents <= 0 || debitCents !== creditCents) {
    throw new Error(`Journal entry is not balanced: debits ${debitCents}, credits ${creditCents}`)
  }
  return { debitCents, creditCents }
}

export function assertValidOperatingPosture(posture: BooksOperatingPosture) {
  const externalValid = posture.ledgerAuthority === "external"
    && posture.arcLedgerMode !== "official"
    && posture.externalSyncPosture === "normal"
  const arcValid = posture.ledgerAuthority === "arc"
    && posture.arcLedgerMode === "official"
    && posture.externalSyncPosture !== "normal"
  if (!externalValid && !arcValid) {
    throw new Error("Ledger authority, Arc ledger mode, and external sync posture are inconsistent")
  }
}
