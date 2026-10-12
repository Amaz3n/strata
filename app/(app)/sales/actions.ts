"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import type { SellableHome } from "@/lib/sales/inventory"
import {
  bulkRepriceCommunityPlans,
  convertHoldToReservation,
  registerReservationConversion,
  inspectReservationConversion,
  cancelReservationConversion,
  createPurchaseAgreement,
  resumePurchaseAgreementSigning,
  endIncentive,
  getAgreementDraftContext,
  listSpecInventoryPage,
  priceAgreementDraft,
  releaseReservation,
  offerPlanInCommunity,
  searchOfferablePlans,
  withdrawPlanFromCommunity,
  setCommunityPlanPrice,
  proposeSpecPriceChange,
  decideSpecPriceChange,
  withdrawSpecPriceChange,
  upsertIncentive,
  voidPurchaseAgreement,
  type AgreementDraftContext,
  type AgreementDraftPricing,
} from "@/lib/services/community-sales"
import { getSalesConfigurationFixes } from "@/lib/services/configuration-rules"
import {
  cancelSpecDisposition,
  decideSpecDisposition,
  executeSpecDisposition,
  proposeSpecDisposition,
  proposeSpecDispositionWriteDown,
  recordSpecCompletion,
} from "@/lib/services/spec-dispositions"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import {
  completeProspectFollowUp,
  logProspectContact,
  markProspectLost,
  deleteProspect,
  reopenProspect,
  setProspectFollowUp,
  updateDealDetails,
} from "@/lib/services/prospects"
import { registerProductionInquiry, searchBuyerContacts } from "@/lib/services/sales-inquiries"
import type { SearchPickerPage } from "@/components/ui/search-picker"
import { SEARCH_PICKER_PAGE_SIZE, searchPickerPage, searchPickerQuerySchema } from "@/lib/search-picker"
import {
  logProspectContactInputSchema,
  markProspectLostInputSchema,
  productionInquiryInputSchema,
  updateDealDetailsInputSchema,
} from "@/lib/validation/prospects"
import { createProspectLotHoldSchema, sellableHomesQuerySchema } from "@/lib/validation/community-sales"

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

/** Saved review/recovery never creates another home or deposit. */
export async function registerReservationConversionAction(input: unknown) {
  return run(() => registerReservationConversion(input))
}
export async function inspectReservationConversionAction(input: unknown) {
  try { return { success: true as const, data: await inspectReservationConversion(input) } }
  catch (error) { return actionError(error) }
}
export async function cancelReservationConversionAction(input: unknown) {
  return run(() => cancelReservationConversion(input))
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

/**
 * Prices a configuration without writing anything, for the form's live total.
 * A configuration that breaks an option rule comes back with the rules it
 * broke and the draft changes that would make it valid.
 */
export async function priceAgreementDraftAction(
  input: unknown,
): Promise<ActionResult<AgreementDraftPricing>> {
  try {
    return {
      success: true,
      data: await priceAgreementDraft(input as Parameters<typeof priceAgreementDraft>[0]),
    }
  } catch (error) {
    const failure = actionError(error)
    if (!failure.violations) return failure
    const issues = await run(() => getSalesConfigurationFixes(input), [])
    return issues.success ? { ...failure, fixes: issues.data.fixes } : failure
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

export async function resumePurchaseAgreementSigningAction(input: unknown) {
  return run(() => resumePurchaseAgreementSigning(input))
}

/** Unwinds an agreement: releases the lot and un-wins the lead. */
export async function voidPurchaseAgreementAction(input: unknown) {
  return run(() => voidPurchaseAgreement(input))
}

export async function upsertIncentiveAction(input: unknown) { return run(() => upsertIncentive(input as Parameters<typeof upsertIncentive>[0])) }
export async function endIncentiveAction(id: string) { return run(() => endIncentive(z.string().uuid().parse(id))) }
export async function offerPlanInCommunityAction(communityId: string, input: unknown) {
  return run(() => offerPlanInCommunity(input), ["/sales", "/plans", `/communities/${communityId}/offering`])
}

/** Released plans the community does not sell yet, a page per search by code or name. Read-only. */
export async function searchOfferablePlansAction(communityId: string, input: unknown): Promise<ActionResult<SearchPickerPage>> {
  return run(async () => {
    const query = searchPickerQuerySchema.parse(input)
    const result = await searchOfferablePlans(z.string().uuid().parse(communityId), { search: query.search, page: query.page, pageSize: SEARCH_PICKER_PAGE_SIZE })
    return searchPickerPage(
      result.plans.map((plan) => ({ id: plan.id, name: plan.code ? `${plan.code} — ${plan.name}` : plan.name, detail: "Released" })),
      result.page,
      result.pageSize,
      result.total,
    )
  }, [])
}

export async function withdrawPlanFromCommunityAction(communityId: string, input: unknown) {
  return run(() => withdrawPlanFromCommunity(input), ["/sales", "/plans", `/communities/${communityId}/offering`])
}

export async function setCommunityPlanPriceAction(communityId: string, input: unknown) {
  return run(() => setCommunityPlanPrice(input), ["/sales", "/plans", `/communities/${communityId}/offering`])
}

export async function proposeSpecPriceChangeAction(communityId: string, input: unknown) {
  return run(() => proposeSpecPriceChange(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function decideSpecPriceChangeAction(communityId: string, input: unknown) {
  return run(() => decideSpecPriceChange(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function withdrawSpecPriceChangeAction(communityId: string, input: unknown) {
  return run(() => withdrawSpecPriceChange(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function recordSpecCompletionAction(communityId: string, input: unknown) {
  return run(() => recordSpecCompletion(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function proposeSpecDispositionAction(communityId: string, input: unknown) {
  return run(() => proposeSpecDisposition(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function decideSpecDispositionAction(communityId: string, input: unknown) {
  return run(() => decideSpecDisposition(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function proposeSpecDispositionWriteDownAction(communityId: string, input: unknown) {
  return run(() => proposeSpecDispositionWriteDown(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function executeSpecDispositionAction(communityId: string, input: unknown) {
  return run(() => executeSpecDisposition(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function cancelSpecDispositionAction(communityId: string, input: unknown) {
  return run(() => cancelSpecDisposition(input), ["/sales", `/communities/${communityId}/offering`])
}

export async function bulkRepriceCommunityPlansAction(communityId: string, input: unknown) {
  return run(() => bulkRepriceCommunityPlans(input), ["/sales", "/plans", `/communities/${communityId}/offering`])
}

const SELLABLE_HOME_PAGE_SIZE = 50

export interface SellableHomePage {
  homes: SellableHome[]
  /** More homes match than this page holds; ask again from `nextOffset`. */
  truncated: boolean
  /** Lots the scope and filters match before holds and sales are taken off, so it can only over-count. */
  total: number
  nextOffset: number | null
}

/**
 * One server-searched page of sellable inventory for the Find a home dialog, in
 * the caller's ambient scope (division and community lens, refused lens draws
 * nothing). Loaded on demand rather than with the board — a consultant opens the
 * picker a few times a day and the board a hundred.
 */
export async function searchSellableHomesAction(input: unknown): Promise<ActionResult<SellableHomePage>> {
  try {
    const query = sellableHomesQuerySchema.parse(input)
    const scope = await resolveProductionDeskScope({})
    if (scope.refused) return { success: true, data: { homes: [], truncated: false, total: 0, nextOffset: null } }
    const { lots, truncated, total, nextOffset } = await listSpecInventoryPage({
      communityId: scope.communityId,
      divisionId: scope.divisionId,
      includeToBeBuilt: true,
      limit: SELLABLE_HOME_PAGE_SIZE,
      order: query.sort,
      search: query.search,
      availability: query.availability,
      minBeds: query.minBeds,
      minPriceCents: query.minPriceCents,
      maxPriceCents: query.maxPriceCents,
      offset: query.offset,
    })
    return {
      success: true,
      data: { truncated, total, nextOffset, homes: lots.map((lot) => ({
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
      })) },
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

/** Existing people for the registration card's buyer lookup: a page per search, by name, email or phone. Read-only. */
export async function searchBuyersAction(input: unknown): Promise<ActionResult<SearchPickerPage>> {
  return run(async () => {
    const query = searchPickerQuerySchema.parse(input)
    const result = await searchBuyerContacts({ search: query.search, page: query.page, pageSize: SEARCH_PICKER_PAGE_SIZE })
    return searchPickerPage(
      result.buyers.map((buyer) => ({
        id: buyer.id,
        name: buyer.name,
        detail: [buyer.email, buyer.phone, buyer.roles.join(", ")].filter(Boolean).join(" · "),
      })),
      result.page,
      result.pageSize,
      result.total,
    )
  }, [])
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

export async function listSellableLotsAction(communityId: string, search?: string) {
  return run(async () => {
    const { listSellableLots } = await import("@/lib/services/community-sales")
    return listSellableLots(communityId, search)
  }, [])
}

export async function createProspectLotHoldAction(input: unknown) {
  return run(async () => {
    const parsed = createProspectLotHoldSchema.parse(input)
    const { createLotHoldFromProspect } = await import("@/lib/services/community-sales")
    const reservation = await createLotHoldFromProspect(parsed)
    revalidatePath(`/sales/${parsed.prospectId}`)
    revalidatePath(`/communities/${reservation.communityId}`)
    return reservation
  })
}
