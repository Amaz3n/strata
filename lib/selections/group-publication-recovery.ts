import { catalogGroupPublicationSchema } from "@/lib/validation/selections"
import type { z } from "zod"

export type GroupPublicationAttempt = z.infer<typeof catalogGroupPublicationSchema>
export type GroupPublicationScope = { orgId: string; actorId: string; communityId?: string | null }
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function key(scope: GroupPublicationScope) {
  return `arc:catalog-group-publication:v1:${scope.orgId.toLowerCase()}:${scope.actorId.toLowerCase()}:${scope.communityId?.toLowerCase() ?? "org"}`
}

export function groupPublicationLockName(scope: GroupPublicationScope) { return key(scope) }

function reviewed(scope: GroupPublicationScope, value: unknown): GroupPublicationAttempt {
  const request = catalogGroupPublicationSchema.parse(value)
  if (!request.publicationKey || request.requireAtomicPublication !== true) throw new Error("Saved cutoff rule publication requires a stable key and atomic publication")
  if (request.expectedOrgId?.toLowerCase() !== scope.orgId.toLowerCase() || request.expectedActorId?.toLowerCase() !== scope.actorId.toLowerCase() || (request.communityId?.toLowerCase() ?? null) !== (scope.communityId?.toLowerCase() ?? null)) {
    throw new Error("Saved cutoff rule publication belongs to a different organization, user or community")
  }
  return request
}

/** Never expire or silently discard an attempt that may already have committed. */
export function readGroupPublication(storage: RequestStorage, scope: GroupPublicationScope): GroupPublicationAttempt | null {
  const saved = storage.getItem(key(scope))
  if (saved === null) return null
  if (saved.length > 512_000) throw new Error("Saved cutoff rule publication cannot be read. Reconcile it before publishing again")
  return reviewed(scope, JSON.parse(saved))
}

/** The exact request must be recoverable before any server action starts. */
export function persistGroupPublication(storage: RequestStorage, scope: GroupPublicationScope, attempt: GroupPublicationAttempt): GroupPublicationAttempt {
  const parsed = reviewed(scope, attempt)
  const previous = readGroupPublication(storage, scope)
  const encoded = JSON.stringify(parsed)
  if (previous && JSON.stringify(previous) !== encoded) throw new Error("Recover the previous reviewed cutoff rule save before publishing another")
  storage.setItem(key(scope), encoded)
  if (storage.getItem(key(scope)) !== encoded) throw new Error("Cutoff rule recovery could not be saved. No new publication was sent")
  return parsed
}

/** Remove only our verified attempt, never a newer batch from another tab. */
export function clearGroupPublication(storage: RequestStorage, scope: GroupPublicationScope, attempt: GroupPublicationAttempt) {
  const previous = readGroupPublication(storage, scope)
  if (!previous) return
  if (JSON.stringify(previous) !== JSON.stringify(reviewed(scope, attempt))) throw new Error("Another cutoff rule save needs recovery. Reload before publishing again")
  storage.removeItem(key(scope))
  if (storage.getItem(key(scope)) !== null) throw new Error("Cutoff rule recovery could not be cleared. Retry the reviewed batch to reconcile it")
}
