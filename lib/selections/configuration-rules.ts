export type ConfigurationRule = {
  id: string
  sourceOptionId: string
  targetOptionId: string
  kind: "requires" | "excludes"
  sourceName: string
  targetName: string
}
export type ConfigurationViolation = ConfigurationRule & { message: string }

/** Selected IDs include canonical parents so community overrides inherit rules. */
export function evaluateConfigurationRules(selectedIds: Iterable<string>, rules: readonly ConfigurationRule[]): ConfigurationViolation[] {
  const selected = new Set(selectedIds)
  return rules.flatMap((rule) => {
    if (!selected.has(rule.sourceOptionId)) return []
    const targetSelected = selected.has(rule.targetOptionId)
    if (rule.kind === "requires" && !targetSelected) return [{ ...rule, message: `${rule.sourceName} requires ${rule.targetName}.` }]
    if (rule.kind === "excludes" && targetSelected) return [{ ...rule, message: `${rule.sourceName} cannot be combined with ${rule.targetName}.` }]
    return []
  })
}
