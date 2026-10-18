import { catalogPricePublicationSchema } from "@/lib/validation/selections"
import type { z } from "zod"

export type PricePublicationAttempt = z.infer<typeof catalogPricePublicationSchema>
export type PricePublicationScope = { orgId: string; actorId: string; communityId?: string | null }
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function key(scope: PricePublicationScope) {
  return `arc:catalog-price-publication:v1:${scope.orgId.toLowerCase()}:${scope.actorId.toLowerCase()}:${scope.communityId?.toLowerCase() ?? "org"}`
}

export function pricePublicationLockName(scope: PricePublicationScope) { return key(scope) }

function reviewed(scope: PricePublicationScope, value: unknown): PricePublicationAttempt {
  const request = catalogPricePublicationSchema.parse(value)
  if (request.expectedOrgId?.toLowerCase() !== scope.orgId.toLowerCase() || request.expectedActorId?.toLowerCase() !== scope.actorId.toLowerCase() || (request.communityId?.toLowerCase() ?? null) !== (scope.communityId?.toLowerCase() ?? null)) {
    throw new Error("Saved price publication belongs to a different organization, user or community")
  }
  return request
}

/** Never expire or silently discard an attempt that may already have committed. */
export function readPricePublication(storage: RequestStorage, scope: PricePublicationScope): PricePublicationAttempt | null {
  const saved = storage.getItem(key(scope))
  if (saved === null) return null
  if (saved.length > 512_000) throw new Error("Saved price publication cannot be read. Reconcile it before publishing again")
  return reviewed(scope, JSON.parse(saved))
}

/** The exact request must be recoverable before any server action starts. */
export function persistPricePublication(storage: RequestStorage, scope: PricePublicationScope, attempt: PricePublicationAttempt): PricePublicationAttempt {
  const parsed = reviewed(scope, attempt)
  const previous = readPricePublication(storage, scope)
  const encoded = JSON.stringify(parsed)
  if (previous && JSON.stringify(previous) !== encoded) throw new Error("Recover the previous reviewed price batch before publishing another")
  storage.setItem(key(scope), encoded)
  if (storage.getItem(key(scope)) !== encoded) throw new Error("Price recovery could not be saved. No new publication was sent")
  return parsed
}

/** Remove only our verified attempt, never a newer batch from another tab. */
export function clearPricePublication(storage: RequestStorage, scope: PricePublicationScope, attempt: PricePublicationAttempt) {
  const previous = readPricePublication(storage, scope)
  if (!previous) return
  if (JSON.stringify(previous) !== JSON.stringify(reviewed(scope, attempt))) throw new Error("Another price batch needs recovery. Reload before publishing again")
  storage.removeItem(key(scope))
  if (storage.getItem(key(scope)) !== null) throw new Error("Price recovery could not be cleared. Retry the reviewed batch to reconcile it")
}
