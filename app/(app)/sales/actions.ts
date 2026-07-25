"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  convertHoldToReservation,
  createLotHold,
  createPurchaseAgreement,
  endIncentive,
  getAgreementConfiguratorData,
  getUnitSheetData,
  priceAgreementDraft,
  releaseReservation,
  setLotAskingPrice,
  upsertIncentive,
  voidPurchaseAgreement,
} from "@/lib/services/community-sales"
import type { AgreementConfigurationInput } from "@/lib/validation/community-sales"

async function run<T>(operation: () => Promise<T>, paths: string[] = ["/sales"]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/** Capped, searchable buyer picker for the hold/reserve/contract flows. */
export async function searchBuyerContactsAction(query: string): Promise<ActionResult<{ id: string; name: string; email: string | null }[]>> {
  try {
    const { listContacts } = await import("@/lib/services/contacts")
    const contacts = await listContacts(undefined, { contact_type: "client", search: query.trim() || undefined })
    return { success: true, data: contacts.slice(0, 20).map((contact) => ({ id: contact.id, name: contact.full_name, email: contact.email ?? null })) }
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
export async function setLotAskingPriceAction(input: unknown) { return run(() => setLotAskingPrice(input)) }

/** Server-priced draft for the agreement configurator's running total (no writes). */
export async function priceAgreementDraftAction(input: AgreementConfigurationInput) {
  try {
    return { success: true as const, data: await priceAgreementDraft(input) }
  } catch (error) {
    return actionError(error)
  }
}

/** On-open read for the unit sheet overlay. */
export async function getUnitSheetDataAction(lotId: string) {
  try {
    return { success: true as const, data: await getUnitSheetData(lotId) }
  } catch (error) {
    return actionError(error)
  }
}

/** On-open read for the agreement configurator overlay. */
export async function getAgreementConfiguratorDataAction(lotId: string) {
  try {
    return { success: true as const, data: await getAgreementConfiguratorData(lotId) }
  } catch (error) {
    return actionError(error)
  }
}
