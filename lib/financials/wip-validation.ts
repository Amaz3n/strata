/** These conditions invalidate earned revenue; a review note cannot cure them. */
const BLOCKING_WIP_WARNINGS = new Set([
  "missing_contract_value", "missing_eac", "negative_actual_cost", "missing_budget", "eac_below_actual_cost",
])
export function hasInvalidWipInputs(warnings: readonly string[]) {
  return warnings.some(warning => BLOCKING_WIP_WARNINGS.has(warning))
}
