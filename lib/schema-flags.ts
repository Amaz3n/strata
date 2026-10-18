/**
 * Feature flags that switch on a database path, and the migrations that path needs.
 *
 * A flag here may only be honoured once every listed migration is in the database's
 * ledger: `schemaFlagEnabled()` (lib/services/schema-flags.ts) checks the ledger the
 * first time an enabled flag is read in a process and throws when anything is missing,
 * so turning a flag on ahead of its migration fails loudly at the switch. The
 * activation manifest (docs/reference/production-activation.md) lists the same pairs.
 *
 * Add a flag here in the same change that adds its `process.env` read, and read it
 * only through `schemaFlagEnabled()`.
 */
export const SCHEMA_FLAGS = {
  ARC_TRADE_DATABASE_WORKSPACE_ENABLED: {
    purpose: "The trade lookahead workspace pages and groups in the database (read_trade_lookahead_workspace) instead of in the app.",
    requires: ["20261014110000_trade_notice_deliveries", "20261015130000_po_issue_acknowledgments"],
  },
} as const satisfies Record<`ARC_${string}`, { purpose: string; requires: readonly string[] }>

export type SchemaFlag = keyof typeof SCHEMA_FLAGS

/** The 14-digit ledger version of a migration file stem. */
export function migrationVersion(stem: string): string {
  return stem.slice(0, 14)
}

/** Whether the environment turns the flag on. Only the exact string "true" does. */
export function schemaFlagIsOn(flag: SchemaFlag, env: Readonly<Record<string, string | undefined>>): boolean {
  return env[flag] === "true"
}

/** The flag's required migrations whose versions are not in `appliedVersions`. */
export function missingSchemaForFlag(flag: SchemaFlag, appliedVersions: ReadonlySet<string>): string[] {
  return SCHEMA_FLAGS[flag].requires.filter((stem) => !appliedVersions.has(migrationVersion(stem)))
}

/** What an operator is told when a flag is on ahead of its schema. */
export function schemaFlagRefusal(flag: SchemaFlag, missing: readonly string[]): string {
  return `${flag} is on, but this database is missing ${missing.length === 1 ? "the migration" : `${missing.length} migrations`} it needs: ${missing.join(", ")}. Apply ${missing.length === 1 ? "it" : "them"} or turn the flag off.`
}
