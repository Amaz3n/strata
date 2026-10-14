"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { setReleaseSlot, setThroughputTarget } from "@/lib/services/even-flow"
import { clearSuperintendentLimits, setSuperintendentLimits } from "@/lib/services/superintendent-capacity"
import {
  attestGate, cancelRelease, cancelStartPackage, getStartPackage, listSuperintendentCandidates,
  openStartPackage, refreshAutoGates, releaseStart, releaseStarts, reopenGate, retryRelease, retryStartTradeNotice, retryStartConfirmation, retryStartNotificationDelivery, inspectStartNotificationDeliveries,
  seedDefaultGateDefinitions, setProjectSuperintendent, updateStartPackage, upsertGateDefinition,
  waiveGate,
} from "@/lib/services/starts"
import {
  gateAttestSchema, gateDefinitionSchema, gateWaiveSchema, releaseInputSchema,
  startPackageInputSchema, startPackageUpdateSchema, superintendentAssignmentSchema, superintendentLimitSchema, targetWeekSchema,
  throughputTargetSchema,
} from "@/lib/validation/starts"
import { resolveTradeNotice } from "@/lib/services/trade-notices"
import { confirmationRecoveryInputSchema, notificationRecoveryInputSchema, deliveryInspectionInputSchema } from "@/lib/services/starts-confirmation-recovery"

const uuid = z.string().uuid()

function packagePaths(packageId?: string) {
  return ["/starts", ...(packageId ? [`/starts/${packageId}`] : [])]
}

async function run<T>(operation: () => Promise<T>, paths: string[]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/** Loads a package on demand so the lane's sheet never ships every detail up front. */
export async function getStartPackageAction(id: string) {
  return await run(async () => {
    const pkg = await getStartPackage(uuid.parse(id))
    // Whoever holds the house stays in the picker even if their role has moved
    // on, so the assignment never renders as an empty selection.
    const superintendents = await listSuperintendentCandidates({ includeUserIds: [pkg.superintendentId] }).catch(() => [])
    return { pkg, superintendents }
  }, [])
}

export async function openStartPackageAction(lotId: string, input: unknown) {
  return await run(() => openStartPackage(uuid.parse(lotId), startPackageInputSchema.parse(input)), packagePaths())
}

export async function updateStartPackageAction(id: string, input: unknown) {
  return await run(() => updateStartPackage(uuid.parse(id), startPackageUpdateSchema.parse(input)), packagePaths(id))
}

export async function refreshGatesAction(id: string) {
  return await run(() => refreshAutoGates(uuid.parse(id)), packagePaths(id))
}

export async function attestGateAction(packageId: string, gateId: string, input: unknown) {
  return await run(() => attestGate(uuid.parse(packageId), uuid.parse(gateId), gateAttestSchema.parse(input)), packagePaths(packageId))
}

export async function waiveGateAction(packageId: string, gateId: string, reason: string) {
  return await run(() => waiveGate(uuid.parse(packageId), uuid.parse(gateId), gateWaiveSchema.parse({ reason })), packagePaths(packageId))
}

export async function reopenGateAction(packageId: string, gateId: string) {
  return await run(() => reopenGate(uuid.parse(packageId), uuid.parse(gateId)), packagePaths(packageId))
}

export async function releaseStartAction(packageId: string, input: unknown) {
  return await run(() => releaseStart(uuid.parse(packageId), releaseInputSchema.parse(input)), packagePaths(packageId))
}

export async function releaseStartsAction(packageIds: string[], input: unknown) {
  const ids = z.array(uuid).min(1).max(50).parse(packageIds)
  return await run(() => releaseStarts(ids, releaseInputSchema.parse(input)), ["/starts", ...ids.map((id) => `/starts/${id}`)])
}

/** Drag-to-retarget on the lane; a null week sends the house back to the yard. */
export async function setStartTargetWeekAction(packageId: string, weekStart: unknown) {
  const targetWeek = targetWeekSchema.parse(weekStart)
  return await run(() => updateStartPackage(uuid.parse(packageId), { targetWeek }), packagePaths(packageId))
}

export async function retryReleaseAction(packageId: string) {
  return await run(() => retryRelease(uuid.parse(packageId)), packagePaths(packageId))
}

export async function retryStartConfirmationAction(packageId: string, input: unknown) {
  return await run(() => retryStartConfirmation(uuid.parse(packageId), confirmationRecoveryInputSchema.parse(input)), packagePaths(packageId))
}

export async function retryStartNotificationDeliveryAction(packageId: string, input: unknown) {
  return await run(() => retryStartNotificationDelivery(uuid.parse(packageId), notificationRecoveryInputSchema.parse(input)), packagePaths(packageId))
}

export async function inspectStartNotificationDeliveriesAction(packageId: string, input: unknown) {
  return await run(() => inspectStartNotificationDeliveries(uuid.parse(packageId), deliveryInspectionInputSchema.parse(input)), [])
}

export async function retryStartTradeNoticeAction(packageId: string, noticeId: string) {
  return await run(() => retryStartTradeNotice(uuid.parse(packageId), z.string().regex(/^[1-9]\d{0,18}$/).parse(noticeId)), packagePaths(packageId))
}

export async function resolveTradeNoticeAction(input: unknown, packageId?: string) {
  return await run(() => resolveTradeNotice(input), [...packagePaths(packageId ? uuid.parse(packageId) : undefined), "/schedule/trades"])
}

export async function cancelReleaseAction(packageId: string) {
  return await run(() => cancelRelease(uuid.parse(packageId)), packagePaths(packageId))
}

export async function cancelStartPackageAction(packageId: string, reason: string) {
  return await run(() => cancelStartPackage(uuid.parse(packageId), { reason }), packagePaths(packageId))
}

export async function setReleaseSlotAction(communityId: string, weekStart: string, input: unknown) {
  const parsed = z.object({ targetStarts: z.number().int().min(0).max(20), notes: z.string().trim().max(1000).optional().nullable() }).parse(input)
  return await run(() => setReleaseSlot(uuid.parse(communityId), weekStart, parsed), ["/starts"])
}

export async function upsertGateDefinitionAction(input: unknown) {
  return await run(() => upsertGateDefinition(gateDefinitionSchema.parse(input)), ["/settings/starts"])
}

export async function seedDefaultGatesAction() {
  return await run(() => seedDefaultGateDefinitions(), ["/settings/starts"])
}

export async function setThroughputTargetAction(input: unknown) {
  return await run(() => setThroughputTarget(throughputTargetSchema.parse(input)), ["/starts", "/settings/starts"])
}

export async function setSuperintendentLimitsAction(input: unknown) {
  return await run(() => setSuperintendentLimits(superintendentLimitSchema.parse(input)), ["/settings/starts"])
}

export async function clearSuperintendentLimitsAction(userId: string) {
  return await run(() => clearSuperintendentLimits(uuid.parse(userId)), ["/settings/starts"])
}

export async function setProjectSuperintendentAction(projectId: string, userId: string | null, input: unknown = {}) {
  return await run(
    () => setProjectSuperintendent(uuid.parse(projectId), userId ? uuid.parse(userId) : null, superintendentAssignmentSchema.parse(input)),
    [`/projects/${projectId}`, "/", ...packagePaths()],
  )
}
