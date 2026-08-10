import { booksDigest } from "@/lib/services/books/hash"

export type ProjectPocInput = {
  originalContractCents: number
  approvedChangeOrdersCents: number
  revisedContractCents: number
  actualCostCents: number
  eacCents: number
  billedCents: number
}

/**
 * Everything that can be wrong with a project's POC inputs. A union rather than
 * `string[]` so a consumer that switches on a warning cannot silently miss one
 * that gets added later.
 */
export type ProjectPocWarning =
  | "missing_contract_value"
  | "missing_eac"
  | "negative_actual_cost"
  | "missing_budget"

export type ProjectPocResult = ProjectPocInput & {
  costToCompleteCents: number
  /**
   * A 0–1 RATIO, not a percentage — multiply by 100 at the edge. The
   * `poc_snapshots.percent_complete` column stores this same ratio despite its
   * name; the column is what shipped, so the name here is the one that gets to
   * be honest.
   */
  completionRatio: number
  earnedRevenueCents: number
  overUnderCents: number
  forecastGrossProfitCents: number
  forecastGrossMarginPercent: number | null
  warnings: ProjectPocWarning[]
  inputsHash: string
}

function assertSafeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be integer cents`)
}

export function computeProjectPoc(
  input: ProjectPocInput,
  options: { extraWarnings?: ProjectPocWarning[] } = {},
): ProjectPocResult {
  for (const [label, value] of Object.entries(input)) assertSafeCents(value, label)
  const warnings: ProjectPocWarning[] = []
  if (input.revisedContractCents <= 0) warnings.push("missing_contract_value")
  if (input.eacCents <= 0) warnings.push("missing_eac")
  if (input.actualCostCents < 0) warnings.push("negative_actual_cost")
  // `missing_budget` is known by the caller that tried to load the budget, not
  // by the arithmetic. It still belongs in `warnings` so every consumer reads
  // one list, and so it reaches `inputsHash` — a POC computed without a budget
  // is not the same fact as one computed with it.
  for (const warning of options.extraWarnings ?? []) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }

  const completionRatio = input.eacCents > 0
    ? Math.min(1, Math.max(0, input.actualCostCents / input.eacCents))
    : 0
  const earnedRevenueCents = Math.round(input.revisedContractCents * completionRatio)
  const forecastGrossProfitCents = input.revisedContractCents - input.eacCents
  const result = {
    ...input,
    costToCompleteCents: Math.max(0, input.eacCents - input.actualCostCents),
    completionRatio: Math.round(completionRatio * 100000) / 100000,
    earnedRevenueCents,
    overUnderCents: input.billedCents - earnedRevenueCents,
    forecastGrossProfitCents,
    forecastGrossMarginPercent: input.revisedContractCents > 0
      ? Math.round((forecastGrossProfitCents / input.revisedContractCents) * 1000) / 10
      : null,
    warnings,
  }
  return { ...result, inputsHash: booksDigest(result) }
}
