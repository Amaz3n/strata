import { AsyncLocalStorage } from "node:async_hooks"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface AccountingDeliveryIdentity {
  orgId: string
  connectionId: string
  entityType: string
  entityId: string
}
interface DeliveryLease extends AccountingDeliveryIdentity { token: string; deadline: number }
const delivery = new AsyncLocalStorage<DeliveryLease>()
const deadlineContext = new AsyncLocalStorage<number>()

/** A provider transport failure with policy supplied by that provider. */
export class AccountingDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly reason: string) { super(message) }
}
export function currentAccountingDelivery(input: AccountingDeliveryIdentity) {
  const lease = delivery.getStore()
  return lease && lease.orgId === input.orgId && lease.connectionId === input.connectionId && lease.entityType === input.entityType && lease.entityId === input.entityId ? lease : null
}
export function accountingDeliveryDeadline() {
  const deadline = Math.min(delivery.getStore()?.deadline ?? Infinity, deadlineContext.getStore() ?? Infinity)
  return Number.isFinite(deadline) ? deadline : undefined
}
export function withAccountingDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> { return deadlineContext.run(Math.min(deadline, accountingDeliveryDeadline() ?? Infinity), work) }
export async function withAccountingDelivery<T>(input: AccountingDeliveryIdentity, deadline: number, work: () => Promise<T>): Promise<{ deferred: true } | { deferred: false; result: T }> {
  const client = createServiceSupabaseClient()
  const { data, error } = await client.rpc("claim_accounting_delivery", { p_org_id: input.orgId, p_connection_id: input.connectionId, p_entity_type: input.entityType, p_entity_id: input.entityId })
  if (error) throw new Error(`Unable to claim accounting delivery: ${error.message}`)
  if (!data) return { deferred: true }
  const lease = { ...input, token: String(data), deadline }
  try { return { deferred: false, result: await delivery.run(lease, work) } }
  finally {
    const { error: releaseError } = await client.rpc("release_accounting_delivery", { p_token: lease.token })
    if (releaseError) throw new Error(`Unable to release accounting delivery: ${releaseError.message}`)
  }
}
/** Identity is retained even if remote success is followed by a later local failure. */
export async function persistAccountingDelivery(input: AccountingDeliveryIdentity & { provider: string; externalId?: string | null; externalVersion?: string | null; status?: string; reason?: string | null; message?: string | null; attemptId?: string | null; fingerprint?: string | null }) {
  const lease = currentAccountingDelivery(input)
  if (!lease) throw new Error("Accounting delivery persistence requires an owned lease")
  const { data, error } = await createServiceSupabaseClient().rpc("persist_accounting_delivery", {
    p_token: lease.token, p_provider: input.provider, p_external_id: input.externalId ?? null,
    p_external_version: input.externalVersion ?? null, p_status: input.status ?? null,
    p_reason: input.reason ?? null, p_message: input.message ?? null, p_attempt_id: input.attemptId ?? null, p_fingerprint: input.fingerprint ?? null,
  })
  if (error || data !== true) throw new Error(`Accounting delivery lease lost or persistence failed${error ? `: ${error.message}` : ""}`)
}

/** Acquire a deterministic full allocation group; no partial inbound group write. */
export async function withAccountingDeliveryGroup<T>(identities: AccountingDeliveryIdentity[], deadline: number, work: () => Promise<T>): Promise<T> {
  const unique = [...new Map(identities.map(identity => [`${identity.orgId}:${identity.connectionId}:${identity.entityType}:${identity.entityId}`, identity])).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, identity]) => identity)
  const acquire = async (index: number): Promise<T> => {
    if (index === unique.length) return work()
    const result = await withAccountingDelivery(unique[index], deadline, () => acquire(index + 1))
    if (result.deferred) throw new AccountingDeliveryError("Accounting allocation group is currently being delivered", true, "concurrent_claim")
    return result.result
  }
  return acquire(0)
}
