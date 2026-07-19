"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  convertHoldToReservation,
  createLotHold,
  createPurchaseAgreement,
  endIncentive,
  releaseReservation,
  upsertIncentive,
  voidPurchaseAgreement,
} from "@/lib/services/community-sales"

async function run<T>(operation: () => Promise<T>, paths: string[] = ["/sales"]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createLotHoldAction(input: unknown) { return run(() => createLotHold(input)) }
export async function convertHoldToReservationAction(input: unknown) { return run(() => convertHoldToReservation(input)) }
export async function releaseReservationAction(input: unknown) { return run(() => releaseReservation(input)) }
export async function upsertIncentiveAction(input: unknown) { return run(() => upsertIncentive(input as Parameters<typeof upsertIncentive>[0])) }
export async function endIncentiveAction(id: string) { return run(() => endIncentive(z.string().uuid().parse(id))) }
export async function createPurchaseAgreementAction(input: unknown) { return run(() => createPurchaseAgreement(input)) }
export async function voidPurchaseAgreementAction(input: unknown) { return run(() => voidPurchaseAgreement(input)) }
