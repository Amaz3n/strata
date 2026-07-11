export type BudgetTransferValidationLine = {
  budgetLineId: string
  amountCents: number
  currentBudgetCents: number
  actualCents: number
  committedCents: number
}

export type BudgetTransferValidation = {
  valid: boolean
  totalCents: number
  floorViolations: Array<{
    budgetLineId: string
    resultingBudgetCents: number
    floorCents: number
  }>
  errors: string[]
}

export function validateBudgetTransfer(
  lines: BudgetTransferValidationLine[],
  options: { allowOverride?: boolean; overrideReason?: string | null } = {},
): BudgetTransferValidation {
  const errors: string[] = []
  const distinctLineIds = new Set(lines.map((line) => line.budgetLineId))
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)

  if (lines.length < 2 || distinctLineIds.size < 2) {
    errors.push("A transfer requires at least two distinct budget lines")
  }
  if (distinctLineIds.size !== lines.length) {
    errors.push("Each budget line may appear only once")
  }
  if (totalCents !== 0) {
    errors.push("Transfer lines must net to zero")
  }
  if (lines.some((line) => !Number.isInteger(line.amountCents) || line.amountCents === 0)) {
    errors.push("Every transfer line must contain a non-zero whole-cent amount")
  }

  const floorViolations = lines.flatMap((line) => {
    const resultingBudgetCents = line.currentBudgetCents + line.amountCents
    const floorCents = line.actualCents + line.committedCents
    return resultingBudgetCents < floorCents
      ? [{ budgetLineId: line.budgetLineId, resultingBudgetCents, floorCents }]
      : []
  })

  if (floorViolations.length > 0 && !options.allowOverride) {
    errors.push("A transfer cannot reduce a line below its actual plus committed cost floor")
  }
  if (floorViolations.length > 0 && options.allowOverride && !options.overrideReason?.trim()) {
    errors.push("An override reason is required when transferring below a cost floor")
  }

  return { valid: errors.length === 0, totalCents, floorViolations, errors }
}
