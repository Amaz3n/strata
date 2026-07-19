"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { setReleaseSlot } from "@/lib/services/even-flow"
import {
  attestGate, cancelRelease, cancelStartPackage, openStartPackage, refreshAutoGates,
  releaseStart, reopenGate, retryRelease, setProjectSuperintendent, updateStartPackage,
  upsertGateDefinition, waiveGate,
} from "@/lib/services/starts"
import { sendTradeLookahead } from "@/lib/services/trade-lookahead"

async function run<T>(operation: () => Promise<T>, paths: string[] = ["/starts"]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function openStartPackageAction(lotId: string, input: unknown) { return await run(() => openStartPackage(z.string().uuid().parse(lotId), input as Parameters<typeof openStartPackage>[1])) }
export async function updateStartPackageAction(id: string, input: unknown) { return await run(() => updateStartPackage(z.string().uuid().parse(id), input as Parameters<typeof updateStartPackage>[1])) }
export async function refreshGatesAction(id: string) { return await run(() => refreshAutoGates(z.string().uuid().parse(id))) }
export async function attestGateAction(packageId: string, gateId: string, input: unknown) { return await run(() => attestGate(z.string().uuid().parse(packageId), z.string().uuid().parse(gateId), input as Parameters<typeof attestGate>[2])) }
export async function waiveGateAction(packageId: string, gateId: string, reason: string) { return await run(() => waiveGate(z.string().uuid().parse(packageId), z.string().uuid().parse(gateId), { reason })) }
export async function reopenGateAction(packageId: string, gateId: string) { return await run(() => reopenGate(z.string().uuid().parse(packageId), z.string().uuid().parse(gateId))) }
export async function releaseStartAction(packageId: string, input: unknown) { return await run(() => releaseStart(z.string().uuid().parse(packageId), input as Parameters<typeof releaseStart>[1])) }
export async function retryReleaseAction(packageId: string) { return await run(() => retryRelease(z.string().uuid().parse(packageId))) }
export async function cancelReleaseAction(packageId: string) { return await run(() => cancelRelease(z.string().uuid().parse(packageId))) }
export async function cancelStartPackageAction(packageId: string, reason: string) { return await run(() => cancelStartPackage(z.string().uuid().parse(packageId), { reason })) }
export async function setReleaseSlotAction(communityId: string, weekStart: string, input: unknown) { return await run(() => setReleaseSlot(z.string().uuid().parse(communityId), weekStart, input as Parameters<typeof setReleaseSlot>[2])) }
export async function upsertGateDefinitionAction(input: unknown) { return await run(() => upsertGateDefinition(input as Parameters<typeof upsertGateDefinition>[0]), ["/starts/settings"]) }
export async function sendTradeLookaheadAction(companyId: string, input: unknown) { return await run(() => sendTradeLookahead(z.string().uuid().parse(companyId), input as Parameters<typeof sendTradeLookahead>[1]), ["/starts/trades"]) }
export async function setProjectSuperintendentAction(projectId: string, userId: string | null) { return await run(() => setProjectSuperintendent(z.string().uuid().parse(projectId), userId ? z.string().uuid().parse(userId) : null), [`/projects/${projectId}`, "/my-houses", "/starts"]) }
