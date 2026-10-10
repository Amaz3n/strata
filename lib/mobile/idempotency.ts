import { createHash } from "node:crypto"

import { MobileAPIError, mobileDataResponse } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"

const MAX_KEY_LENGTH = 200
/** A claim with no stored result this old belongs to a request that died mid-flight. */
const ABANDONED_CLAIM_MS = 2 * 60 * 1000

export const IDEMPOTENCY_HEADER = "Idempotency-Key"

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/** The same method, path and body hash the same, whatever the key order. */
export function mobileRequestHash(request: Request, body: unknown) {
  const path = new URL(request.url).pathname
  return createHash("sha256").update(`${request.method} ${path}\n${canonicalJson(body)}`).digest("hex")
}

type Receipt = { id: string; request_hash: string; response: unknown; created_at: string; expires_at: string }

/**
 * Runs a mutation at most once per `Idempotency-Key`. Without the header it is
 * a plain call, so the shipped app keeps working. With it:
 *  - first use: claim the key, run, store the result;
 *  - replay with the same body: return the stored result, run nothing;
 *  - same key, different body or path: 409 `idempotency_key_reuse`;
 *  - same key while the first request is still running: 409 `idempotency_in_progress`.
 * Only successes are stored. A failed run releases the key so a retry re-executes.
 */
export async function runIdempotent<T>(
  context: MobileOrgContext,
  request: Request,
  body: unknown,
  execute: () => Promise<T>,
): Promise<{ data: T; replayed: boolean }> {
  const key = request.headers.get(IDEMPOTENCY_HEADER)?.trim()
  if (!key) return { data: await execute(), replayed: false }
  if (key.length > MAX_KEY_LENGTH) {
    throw new MobileAPIError(422, "invalid_idempotency_key", "The Idempotency-Key header is too long.")
  }

  const requestHash = mobileRequestHash(request, body)
  const table = () => context.serviceSupabase.from("mobile_idempotency_receipts")
  const scope = { org_id: context.orgId, user_id: context.user.id, idempotency_key: key }
  const nowIso = () => new Date().toISOString()

  const read = async (): Promise<Receipt | null> => {
    const { data, error } = await table()
      .select("id, request_hash, response, created_at, expires_at")
      .eq("org_id", scope.org_id)
      .eq("user_id", scope.user_id)
      .eq("idempotency_key", key)
      .maybeSingle()
    if (error) throw new MobileAPIError(500, "idempotency_unavailable", "The request could not be checked for replay.")
    return (data as Receipt | null) ?? null
  }

  const release = async (id: string) => {
    await table().delete().eq("org_id", context.orgId).eq("id", id)
  }

  // Resolves an existing receipt: a stored result to replay, or null when the
  // receipt is expired or abandoned and has been cleared for a fresh claim.
  const resolve = async (receipt: Receipt): Promise<{ data: T; replayed: true } | null> => {
    const now = Date.now()
    if (Date.parse(receipt.expires_at) <= now) {
      await release(receipt.id)
      return null
    }
    if (receipt.request_hash !== requestHash) {
      throw new MobileAPIError(409, "idempotency_key_reuse", "This Idempotency-Key was already used for a different request.")
    }
    if (receipt.response !== null && receipt.response !== undefined) {
      return { data: receipt.response as T, replayed: true }
    }
    if (Date.parse(receipt.created_at) <= now - ABANDONED_CLAIM_MS) {
      await release(receipt.id)
      return null
    }
    throw new MobileAPIError(409, "idempotency_in_progress", "This request is still being processed. Retry shortly.")
  }

  const existing = await read()
  if (existing) {
    const replay = await resolve(existing)
    if (replay) return replay
  }

  // Retention: an org's expired receipts go whenever it claims a new key.
  await table().delete().eq("org_id", context.orgId).lt("expires_at", nowIso())

  const claim = await table().insert({ ...scope, request_hash: requestHash }).select("id").single()
  if (claim.error || !claim.data) {
    // Lost the race to a concurrent request with the same key.
    const raced = await read()
    if (!raced) throw new MobileAPIError(500, "idempotency_unavailable", "The request could not be checked for replay.")
    const replay = await resolve(raced)
    if (replay) return replay
    throw new MobileAPIError(409, "idempotency_in_progress", "This request is still being processed. Retry shortly.")
  }
  const claimId = (claim.data as { id: string }).id

  let data: T
  try {
    data = await execute()
  } catch (error) {
    await release(claimId)
    throw error
  }
  const stored = await table().update({ response: data ?? null, status_code: 200 }).eq("org_id", context.orgId).eq("id", claimId)
  if (stored.error) await release(claimId)
  return { data, replayed: false }
}

/** The response for a `runIdempotent` result; a replay is flagged so the app can tell. */
export function idempotentResponse<T>(
  result: { data: T; replayed: boolean },
  requestId: string,
  status = 200,
) {
  return mobileDataResponse(result.data, requestId, {
    status,
    headers: result.replayed ? { "Idempotent-Replay": "true" } : undefined,
  })
}
