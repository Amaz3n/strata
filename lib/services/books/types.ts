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

export type ChartAccountTemplate = {
  code: string
  name: string
  accountType: GlAccountType
  subtype: string
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
  postingKey: string
  policyVersion: number
  sourceType?: string
  sourceId?: string
  reversalOfEntryId?: string
  lines: JournalLineDraft[]
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

