import { z } from "zod"

const requestSchema = z.object({ receiptId: z.string().uuid(), requestId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) })
export type PendingDeliveryRecovery = z.infer<typeof requestSchema>
type Scope = { orgId: string; actorId: string; packageId: string }
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
function key(scope: Scope) { return `arc:starts-delivery-recovery:${scope.orgId}:${scope.actorId}:${scope.packageId}` }
export function readPendingDeliveryRecovery(storage: RequestStorage, scope: Scope): PendingDeliveryRecovery | null {
  const saved = storage.getItem(key(scope))
  return saved === null ? null : requestSchema.parse(JSON.parse(saved))
}
export function savePendingDeliveryRecovery(storage: RequestStorage, scope: Scope, request: PendingDeliveryRecovery) {
  const parsed = requestSchema.parse(request)
  const previous = readPendingDeliveryRecovery(storage, scope)
  if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error("Resolve the previous delivery retry first")
  storage.setItem(key(scope), JSON.stringify(parsed))
}
export function clearPendingDeliveryRecovery(storage: RequestStorage, scope: Scope) { storage.removeItem(key(scope)) }
