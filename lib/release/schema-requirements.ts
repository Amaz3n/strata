import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * What a piece of code needs from the database before it may run.
 *
 * A deploy and a migration are two steps with a gap between them, and the
 * starts worker is incompatible with the schema on either side of the gap: new
 * code on the old schema cannot claim a job, and old code on the new schema is
 * refused by the release fences. Each requirement names RPCs that are cheap and
 * side-effect free to call, so "is the schema here yet" is a question the
 * worker can ask instead of failing on.
 *
 * A probe is called with arguments the function rejects (or answers harmlessly)
 * once it exists. PostgREST answers PGRST202 only when no such function is in
 * the schema, which is the one answer that means "not migrated".
 */
export const SCHEMA_REQUIREMENTS = {
  "starts-pipeline": {
    probes: [
      // 20261003048000: the tokened claim protocol. A zero limit raises
      // "Invalid starts claim limit" when the function exists.
      { rpc: "claim_starts_jobs", args: { p_limit: 0 } },
      // 20261014180000: true only when an object from each EP07 migration exists
      // (throughput, trade notices, trade responses, release resume, cutover
      // guards, release-key guards), whatever order they were applied in.
      { rpc: "starts_cutover_ready", args: {}, mustReturn: true },
    ],
  },
} as const satisfies Record<string, { probes: ReadonlyArray<{ rpc: string; args: Record<string, unknown>; mustReturn?: true }> }>

export type SchemaRequirementKey = keyof typeof SCHEMA_REQUIREMENTS

const FUNCTION_MISSING = "PGRST202"

/** The first required function the database does not have, or null when the schema is ready. */
export async function findMissingSchemaRequirement(service: SupabaseClient, key: SchemaRequirementKey) {
  for (const probe of SCHEMA_REQUIREMENTS[key].probes) {
    const { data, error } = await service.rpc(probe.rpc, probe.args)
    if (error?.code === FUNCTION_MISSING) return probe.rpc
    // A marker that exists but answers false is a chain with a migration missing.
    if (!error && "mustReturn" in probe && data !== true) return probe.rpc
  }
  return null
}
