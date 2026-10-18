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

/**
 * A configuration that breaks its rules. The message stays the joined sentence
 * every caller already shows; `violations` lets an action return the rules
 * themselves, since a thrown error reaches the browser only as a digest.
 */
export class ConfigurationViolationError extends Error {
  readonly code = "CONFIGURATION_VIOLATION"
  constructor(readonly violations: ConfigurationViolation[]) {
    super(violations.slice(0, 50).map((violation) => violation.message).join(" ") + (violations.length > 50 ? " Additional configuration conflicts require review." : ""))
    this.name = "ConfigurationViolationError"
  }
}
