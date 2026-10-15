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
 * The check fails closed. A probe passes only on the one answer that proves the
 * function is there and the schema complete: the error code a live function
 * raises for the arguments the probe sends, or a marker that returns true.
 * Anything else (the function missing, the marker false, a network or database
 * error, an unexpected code) means "not ready", and the worker does nothing.
 */
type Probe = { rpc: string; args: Record<string, unknown>; readyWhen: { errorCode: string } | { returns: true } }

export const SCHEMA_REQUIREMENTS = {
  "starts-pipeline": {
    probes: [
      // 20261003048000: the tokened claim protocol. A zero limit raises
      // "Invalid starts claim limit" (P0001) when the function exists.
      { rpc: "claim_starts_jobs", args: { p_limit: 0 }, readyWhen: { errorCode: "P0001" } },
      // True only when an object from every EP07 migration exists, whatever
      // order they were applied in (see the function's own migration).
      { rpc: "starts_cutover_ready", args: {}, readyWhen: { returns: true } },
    ],
  },
} as const satisfies Record<string, { probes: ReadonlyArray<Probe> }>

export type SchemaRequirementKey = keyof typeof SCHEMA_REQUIREMENTS

/** The first probe that does not prove the schema ready, or null when the schema is ready. */
export async function findMissingSchemaRequirement(service: SupabaseClient, key: SchemaRequirementKey) {
  for (const probe of SCHEMA_REQUIREMENTS[key].probes as ReadonlyArray<Probe>) {
    const { data, error } = await service.rpc(probe.rpc, probe.args)
    const ready = "errorCode" in probe.readyWhen ? error?.code === probe.readyWhen.errorCode : !error && data === true
    if (!ready) return probe.rpc
  }
  return null
}
