import type { SupabaseClient } from "@supabase/supabase-js"

const INSERT_RETRY_LIMIT = 5

interface InsertWithProjectNumberRetryArgs {
  supabase: SupabaseClient
  table: string
  numberColumn: string
  /** Postgres function that atomically allocates the next number, taking p_project_id. */
  rpcName: string
  /** Unique constraint name whose violation triggers a re-allocation retry. */
  conflictConstraint: string
  projectId: string
  payload: Record<string, unknown>
  select: string
  explicitNumber?: number
  entityLabel: string
}

async function resolveNextNumber(
  supabase: SupabaseClient,
  { table, numberColumn, rpcName, projectId }: Pick<InsertWithProjectNumberRetryArgs, "table" | "numberColumn" | "rpcName" | "projectId">,
): Promise<number> {
  const { data: nextFromRpc, error: rpcError } = await supabase.rpc(rpcName, { p_project_id: projectId })
  if (!rpcError && typeof nextFromRpc === "number" && nextFromRpc > 0) {
    return nextFromRpc
  }

  const { data: last } = await supabase
    .from(table)
    .select(numberColumn)
    .eq("project_id", projectId)
    .order(numberColumn, { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, number>>()

  return (last?.[numberColumn] ?? 0) + 1
}

function isConstraintConflict(error: { code?: string; message?: string } | null, constraint: string) {
  if (!error || error.code !== "23505") return false
  return typeof error.message === "string" && error.message.includes(constraint)
}

/**
 * Inserts a per-project sequentially numbered row, retrying number allocation
 * on unique-constraint races. Two users creating RFI/submittal #12 at the same
 * moment both succeed — one lands #13.
 */
export async function insertWithProjectNumberRetry<T>({
  supabase,
  table,
  numberColumn,
  rpcName,
  conflictConstraint,
  projectId,
  payload,
  select,
  explicitNumber,
  entityLabel,
}: InsertWithProjectNumberRetryArgs): Promise<{ data: T; insertPayload: Record<string, unknown> }> {
  let attempt = 0
  while (attempt < INSERT_RETRY_LIMIT) {
    const number =
      explicitNumber ?? (await resolveNextNumber(supabase, { table, numberColumn, rpcName, projectId }))
    const insertPayload = { ...payload, [numberColumn]: number }

    const { data, error } = await supabase.from(table).insert(insertPayload).select(select).single()

    if (!error && data) {
      return { data: data as T, insertPayload }
    }

    if (!isConstraintConflict(error, conflictConstraint) || explicitNumber) {
      throw new Error(`Failed to create ${entityLabel}: ${error?.message}`)
    }

    attempt += 1
  }

  throw new Error(`Failed to create ${entityLabel}: could not allocate a unique number`)
}
