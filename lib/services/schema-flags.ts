import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SCHEMA_FLAGS, migrationVersion, missingSchemaForFlag, schemaFlagIsOn, schemaFlagRefusal, type SchemaFlag } from "@/lib/schema-flags"

// A flag whose schema was confirmed stays confirmed for the life of the process:
// migrations are never rolled back underneath a running deployment.
const confirmed = new Set<SchemaFlag>()

/**
 * Whether a schema-dependent flag is on. Off: false, without touching the database.
 * On: true once the ledger holds every migration the flag needs; otherwise it throws,
 * naming the missing migrations, rather than letting the flagged path fail half-way.
 */
export async function schemaFlagEnabled(flag: SchemaFlag): Promise<boolean> {
  if (!schemaFlagIsOn(flag, process.env)) return false
  if (confirmed.has(flag)) return true
  const versions = SCHEMA_FLAGS[flag].requires.map(migrationVersion)
  const { data, error } = await createServiceSupabaseClient().rpc("applied_migration_versions", { p_versions: versions })
  if (error) throw new Error(`${flag} is on, but the migration ledger could not be read to confirm its schema (${error.message}). Apply 20261021201000_applied_migration_versions or turn the flag off.`)
  const applied = new Set<string>(Array.isArray(data) ? data.map(String) : [])
  const missing = missingSchemaForFlag(flag, applied)
  if (missing.length) throw new Error(schemaFlagRefusal(flag, missing))
  confirmed.add(flag)
  return true
}
