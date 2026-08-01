import { booksDigest } from "@/lib/services/books/hash"

export type ProjectPocInput = {
  originalContractCents: number
  approvedChangeOrdersCents: number
  revisedContractCents: number
  actualCostCents: number
  eacCents: number
  billedCents: number
}

export type ProjectPocResult = ProjectPocInput & {
  costToCompleteCents: number
  percentComplete: number
  earnedRevenueCents: number
  overUnderCents: number
  forecastGrossProfitCents: number
  forecastGrossMarginPercent: number | null
  warnings: string[]
  inputsHash: string
}

function assertSafeCents(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be integer cents`)
}

export function computeProjectPoc(input: ProjectPocInput): ProjectPocResult {
  for (const [label, value] of Object.entries(input)) assertSafeCents(value, label)
  const warnings: string[] = []
  if (input.revisedContractCents <= 0) warnings.push("missing_contract_value")
  if (input.eacCents <= 0) warnings.push("missing_eac")
  if (input.actualCostCents < 0) warnings.push("negative_actual_cost")

  const completionRatio = input.eacCents > 0
    ? Math.min(1, Math.max(0, input.actualCostCents / input.eacCents))
    : 0
  const earnedRevenueCents = Math.round(input.revisedContractCents * completionRatio)
  const forecastGrossProfitCents = input.revisedContractCents - input.eacCents
  const result = {
    ...input,
    costToCompleteCents: Math.max(0, input.eacCents - input.actualCostCents),
    percentComplete: Math.round(completionRatio * 100000) / 100000,
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
