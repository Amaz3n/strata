"use server"

import { revalidatePath } from "next/cache"
import {
  awardBidSubmission,
  bulkCreateBidInvites,
  createBidAddendum,
  createBidInvite,
  createBidPackage,
  createManualBidSubmission,
  generateBidInviteLink,
  getBidPackage,
  getProjectBuyoutSummary,
  listBidAddenda,
  listBidInvites,
  listBidPackageActivity,
  listBidPackageRfiResponses,
  listBidPackageRfis,
  listBidPackages,
  listBidScopeItems,
  listBidSubmissions,
  listProspectBidPackages,
  listProspectBidQuotes,
  answerBidPackageRfi,
  pauseBidInviteAccess,
  rescindBidAward,
  resendBidInvite,
  resumeBidInviteAccess,
  revokeBidInviteAccess,
  saveBidScopeItems,
  setBidInviteRequireAccount,
  updateBidPackage,
  updateBidSubmissionItemLeveling,
  updateBidSubmissionLeveling,
} from "@/lib/services/bids"
import {
  getCostCodeBidHistory,
  getPackageIntelligence,
  getVendorBidStats,
} from "@/lib/services/bid-intelligence"
import {
  pauseBidInviteAccountGrants,
  resumeBidInviteAccountGrants,
  revokeBidInviteAccountGrants,
} from "@/lib/services/external-portal-auth"
import { actionError, type ActionResult } from "@/lib/action-result"

/** Where a bid package lives — drives cache revalidation for both route trees. */
export interface BidContext {
  projectId?: string | null
  prospectId?: string | null
  bidPackageId?: string | null
}

function revalidateBids(context: BidContext) {
  revalidatePath("/bids")
  if (context.projectId) {
    revalidatePath(`/projects/${context.projectId}/bids`)
    if (context.bidPackageId) {
      revalidatePath(`/projects/${context.projectId}/bids/${context.bidPackageId}`)
    }
  }
  if (context.prospectId) {
    revalidatePath(`/pipeline/prospects/${context.prospectId}/bids`)
    if (context.bidPackageId) {
      revalidatePath(`/pipeline/prospects/${context.prospectId}/bids/${context.bidPackageId}`)
    }
  }
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

// ---------------------------------------------------------------- reads

export async function listBidPackagesAction(projectId: string) {
  return listBidPackages(projectId)
}

export async function listProspectBidPackagesAction(prospectId: string) {
  return listProspectBidPackages(prospectId)
}

export async function listProspectBidQuotesAction(prospectId: string) {
  return listProspectBidQuotes(prospectId)
}

export async function getBidPackageAction(bidPackageId: string) {
  return getBidPackage(bidPackageId)
}

export async function getProjectBuyoutSummaryAction(projectId: string) {
  return getProjectBuyoutSummary(projectId)
}

export async function listBidInvitesAction(bidPackageId: string) {
  return listBidInvites(bidPackageId)
}

export async function listBidAddendaAction(bidPackageId: string) {
  return listBidAddenda(bidPackageId)
}

export async function listBidSubmissionsAction(bidPackageId: string) {
  return listBidSubmissions(bidPackageId)
}

export async function listBidScopeItemsAction(bidPackageId: string) {
  return listBidScopeItems(bidPackageId)
}

export async function listBidPackageRfisAction(bidPackageId: string) {
  return listBidPackageRfis(bidPackageId)
}

export async function listBidPackageRfiResponsesAction(rfiId: string) {
  return listBidPackageRfiResponses({ rfiId })
}

export async function listBidPackageActivityAction(bidPackageId: string) {
  return listBidPackageActivity(bidPackageId)
}

export async function getPackageIntelligenceAction(bidPackageId: string) {
  return getPackageIntelligence(bidPackageId)
}

export async function getCostCodeBidHistoryAction(costCodeId: string) {
  return getCostCodeBidHistory(costCodeId)
}

export async function getVendorBidStatsAction(companyIds: string[]) {
  const stats = await getVendorBidStats(companyIds)
  return Object.fromEntries(stats)
}

// ---------------------------------------------------------------- writes

export async function createBidPackageAction(context: BidContext, input: unknown) {
  return run(async () => {
    const created = await createBidPackage({
      input: {
        ...(input as Record<string, unknown>),
        project_id: context.projectId ?? null,
        prospect_id: context.prospectId ?? null,
      },
    })
    revalidateBids({ ...context, bidPackageId: created.id })
    return created
  })
}

export async function updateBidPackageAction(context: BidContext, bidPackageId: string, input: unknown) {
  return run(async () => {
    const updated = await updateBidPackage({ bidPackageId, input })
    revalidateBids({ ...context, bidPackageId })
    return updated
  })
}

export async function saveBidScopeItemsAction(context: BidContext, input: unknown) {
  return run(async () => {
    const items = await saveBidScopeItems({ input })
    revalidateBids(context)
    return items
  })
}

export async function createBidInviteAction(context: BidContext, input: unknown) {
  return run(async () => {
    const invite = await createBidInvite({ input })
    revalidateBids({ ...context, bidPackageId: invite.bid_package_id })
    return invite
  })
}

export async function bulkCreateBidInvitesAction(context: BidContext, input: unknown) {
  return run(async () => {
    const result = await bulkCreateBidInvites({ input })
    revalidateBids(context)
    return result
  })
}

export async function generateBidInviteLinkAction(
  context: BidContext,
  inviteId: string,
  options?: { revokeExisting?: boolean },
) {
  return run(async () => {
    const link = await generateBidInviteLink(inviteId, undefined, options)
    revalidateBids(context)
    return link
  })
}

export async function resendBidInviteAction(context: BidContext, inviteId: string) {
  return run(async () => {
    const result = await resendBidInvite({ inviteId })
    revalidateBids(context)
    return result
  })
}

export async function pauseBidInviteAccessAction(context: BidContext, inviteId: string) {
  return run(async () => {
    await pauseBidInviteAccess(inviteId)
    await pauseBidInviteAccountGrants(inviteId)
    revalidateBids(context)
  })
}

export async function resumeBidInviteAccessAction(context: BidContext, inviteId: string) {
  return run(async () => {
    await resumeBidInviteAccess(inviteId)
    await resumeBidInviteAccountGrants(inviteId)
    revalidateBids(context)
  })
}

export async function revokeBidInviteAccessAction(context: BidContext, inviteId: string) {
  return run(async () => {
    await revokeBidInviteAccess(inviteId)
    await revokeBidInviteAccountGrants(inviteId)
    revalidateBids(context)
  })
}

export async function setBidInviteRequireAccountAction(
  context: BidContext,
  inviteId: string,
  requireAccount: boolean,
) {
  return run(async () => {
    await setBidInviteRequireAccount({ inviteId, requireAccount })
    revalidateBids(context)
  })
}

export async function createBidAddendumAction(context: BidContext, input: unknown) {
  return run(async () => {
    const addendum = await createBidAddendum({ input })
    revalidateBids(context)
    return addendum
  })
}

export async function createManualBidSubmissionAction(context: BidContext, input: unknown) {
  return run(async () => {
    const submission = await createManualBidSubmission({ input })
    revalidateBids(context)
    return submission
  })
}

export async function updateBidSubmissionLevelingAction(context: BidContext, input: unknown) {
  return run(async () => {
    const submission = await updateBidSubmissionLeveling({ input })
    revalidateBids(context)
    return submission
  })
}

export async function updateBidSubmissionItemLevelingAction(context: BidContext, input: unknown) {
  return run(async () => {
    const item = await updateBidSubmissionItemLeveling({ input })
    revalidateBids(context)
    return item
  })
}

export async function answerBidPackageRfiAction(context: BidContext, input: unknown) {
  return run(async () => {
    const result = await answerBidPackageRfi({ input })
    revalidateBids(context)
    return result
  })
}

export async function awardBidSubmissionAction(context: BidContext, input: unknown) {
  return run(async () => {
    const result = await awardBidSubmission({ input })
    revalidateBids(context)
    if (context.projectId) {
      revalidatePath(`/projects/${context.projectId}/financials/budget`)
    }
    return result
  })
}

export async function rescindBidAwardAction(context: BidContext, input: unknown) {
  return run(async () => {
    const result = await rescindBidAward({ input })
    revalidateBids(context)
    if (context.projectId) {
      revalidatePath(`/projects/${context.projectId}/financials/budget`)
    }
    return result
  })
}
