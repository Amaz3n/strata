"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import type { SellableHome } from "@/lib/sales/inventory"
import {
  convertHoldToReservation,
  createPurchaseAgreement,
  endIncentive,
  getAgreementDraftContext,
  listSpecInventory,
  priceAgreementDraft,
  releaseReservation,
  setCommunityPlanPrice,
  upsertIncentive,
  voidPurchaseAgreement,
  type AgreementDraftContext,
  type AgreementDraftPricing,
} from "@/lib/services/community-sales"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import {
  completeProspectFollowUp,
  logProspectContact,
  markProspectLost,
  deleteProspect,
  reopenProspect,
  setProspectFollowUp,
  updateDealDetails,
} from "@/lib/services/prospects"
import { registerProductionInquiry } from "@/lib/services/sales-inquiries"
import {
  logProspectContactInputSchema,
  markProspectLostInputSchema,
  productionInquiryInputSchema,
  updateDealDetailsInputSchema,
} from "@/lib/validation/prospects"

async function run<T>(operation: () => Promise<T>, paths: string[] = ["/sales"]): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    paths.forEach((path) => revalidatePath(path))
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

/* ================================================================
 * The lifecycle transitions the Sales desk owns
 *
 * Each of these used to live on the community Sales tab. That tab is gone, so
 * they are driven from the deal file — the one page that knows which transition
 * this buyer is actually due for.
 * ============================================================== */

/** hold → reserved: takes the deposit, opens the job, and makes the lot the buyer's. */
export async function convertHoldToReservationAction(input: unknown) {
  return run(() => convertHoldToReservation(input))
}

/** Puts the lot back on the shelf. The only thing that un-holds inventory. */
export async function releaseReservationAction(input: unknown) {
  return run(() => releaseReservation(input))
}

/** Everything the agreement form needs to open. Read-only. */
export async function getAgreementDraftContextAction(
  reservationId: string,
): Promise<ActionResult<AgreementDraftContext>> {
  try {
    return { success: true, data: await getAgreementDraftContext(z.string().uuid().parse(reservationId)) }
  } catch (error) {
    return actionError(error)
  }
}

/** Prices a configuration without writing anything, for the form's live total. */
export async function priceAgreementDraftAction(
  input: unknown,
): Promise<ActionResult<AgreementDraftPricing>> {
  try {
    return {
      success: true,
      data: await priceAgreementDraft(input as Parameters<typeof priceAgreementDraft>[0]),
    }
  } catch (error) {
    return actionError(error)
  }
}

/**
 * reserved → under contract. Writes the agreement at the configured price and
 * emails it to the buyer for signature; the envelope's execution webhook is what
 * later flips the contract active and wins the lead.
 */
export async function createPurchaseAgreementAction(input: unknown) {
  return run(() => createPurchaseAgreement(input))
}

/** Unwinds an agreement: releases the lot and un-wins the lead. */
export async function voidPurchaseAgreementAction(input: unknown) {
  return run(() => voidPurchaseAgreement(input))
}

export async function upsertIncentiveAction(input: unknown) { return run(() => upsertIncentive(input as Parameters<typeof upsertIncentive>[0])) }
export async function endIncentiveAction(id: string) { return run(() => endIncentive(z.string().uuid().parse(id))) }
export async function setCommunityPlanPriceAction(communityId: string, input: unknown) {
  return run(() => setCommunityPlanPrice(input), ["/sales", "/plans", `/communities/${communityId}/offering`])
}

/**
 * Sellable inventory for the Find a home dialog, in the caller's ambient scope.
 * Loaded on open rather than with the board — a consultant opens the picker a
 * few times a day and the board a hundred, so 250 lots do not ride along.
 */
export async function listSellableHomesAction(): Promise<ActionResult<SellableHome[]>> {
  try {
    const ambient = await getAmbientDeskContext()
    const lots = await listSpecInventory({
      communityId: ambient.communityId,
      divisionId: ambient.divisionId,
      includeToBeBuilt: true,
      limit: 250,
    })
    return {
      success: true,
      data: lots.map((lot) => ({
        lotId: lot.lotId,
        lotLabel: lot.lotLabel,
        communityId: lot.communityId,
        communityName: lot.communityName,
        planLabel: lot.planLabel,
        beds: lot.beds,
        baths: lot.baths,
        sqft: lot.sqft,
        isSpec: lot.isSpec,
        agingDays: lot.agingDays,
        askingPriceCents: lot.askingPriceCents,
      })),
    }
  } catch (error) {
    return actionError(error)
  }
}

const prospectIdSchema = z.string().uuid()
const followUpSchema = z.string().datetime().nullable()

/** Registers a model-home walk-in and moves the day's traffic tally with it. */
export async function registerInquiryAction(input: unknown) {
  return run(() => registerProductionInquiry(productionInquiryInputSchema.parse(input)))
}

export async function logDealActivityAction(prospectId: string, input: unknown) {
  return run(() =>
    logProspectContact({
      prospectId: prospectIdSchema.parse(prospectId),
      input: logProspectContactInputSchema.parse(input),
    }),
  )
}

export async function setDealFollowUpAction(prospectId: string, nextFollowUpAt: string | null) {
  return run(() =>
    setProspectFollowUp({
      prospectId: prospectIdSchema.parse(prospectId),
      nextFollowUpAt: followUpSchema.parse(nextFollowUpAt),
    }),
  )
}

/** Marks the touch and clears the reminder together — one click off the board. */
export async function completeDealFollowUpAction(prospectId: string, input: unknown) {
  return run(() =>
    completeProspectFollowUp({
      prospectId: prospectIdSchema.parse(prospectId),
      input: logProspectContactInputSchema.parse(input),
    }),
  )
}

export async function markDealLostAction(prospectId: string, input: unknown) {
  return run(() =>
    markProspectLost({
      prospectId: prospectIdSchema.parse(prospectId),
      input: markProspectLostInputSchema.parse(input),
    }),
  )
}

export async function reopenDealAction(prospectId: string) {
  return run(() => reopenProspect({ prospectId: prospectIdSchema.parse(prospectId) }))
}

export async function updateDealDetailsAction(prospectId: string, input: unknown) {
  return run(() =>
    updateDealDetails({
      prospectId: prospectIdSchema.parse(prospectId),
      input: updateDealDetailsInputSchema.parse(input),
    }),
  )
}

/**
 * Deletes a lead that never became anything. The service refuses once a project
 * exists, which is the line between "logged by mistake" and "real history" —
 * a deal that went anywhere gets marked lost instead.
 */
export async function deleteDealAction(prospectId: string) {
  return run(() => deleteProspect({ prospectId: prospectIdSchema.parse(prospectId) }))
}
