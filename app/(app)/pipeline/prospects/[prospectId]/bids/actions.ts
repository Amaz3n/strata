"use server"

import { revalidatePath } from "next/cache"

import {
  bulkCreateBidInvites,
  createBidAddendum,
  createBidInvite,
  createBidPackage,
  generateBidInviteLink,
  resendBidInvite,
  getBidPackage,
  listBidAddenda,
  listBidInvites,
  listBidPackages,
  listProspectBidPackages,
  listBidSubmissions,
  createManualBidSubmission,
  updateBidSubmissionLeveling,
  updateBidPackage,
  pauseBidInviteAccess,
  resumeBidInviteAccess,
  revokeBidInviteAccess,
  setBidInviteRequireAccount,
  awardBidSubmission,
  listBidPackageRfis,
  listBidPackageRfiResponses,
  answerBidPackageRfi,
  listBidPackageActivity,
  listProspectBidQuotes,
} from "@/lib/services/bids"
import {
  pauseBidInviteAccountGrants,
  resumeBidInviteAccountGrants,
  revokeBidInviteAccountGrants,
} from "@/lib/services/external-portal-auth"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

function prospectBidsPath(prospectId: string) {
  return `/pipeline/prospects/${prospectId}/bids`
}

export async function listProspectBidPackagesAction(prospectId: string) {
      return listProspectBidPackages(prospectId)
}

export async function listProspectBidQuotesAction(prospectId: string) {
      return listProspectBidQuotes(prospectId)
}

export async function listLinkedProjectBidPackagesAction(projectId: string) {
      return listBidPackages(projectId)
}

export async function getProspectBidPackageAction(bidPackageId: string) {
      return getBidPackage(bidPackageId)
}

export async function createProspectBidPackageAction(prospectId: string, input: unknown) {
  return run(async () => {
      const created = await createBidPackage({
        input: { ...(input as Record<string, unknown>), prospect_id: prospectId, project_id: null },
      })
      revalidatePath(prospectBidsPath(prospectId))
      return created
  })
}

export async function updateProspectBidPackageAction(bidPackageId: string, prospectId: string, input: unknown) {
  return run(async () => {
      const updated = await updateBidPackage({ bidPackageId, input })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      if (updated.project_id) {
        revalidatePath(`/projects/${updated.project_id}/bids`)
        revalidatePath(`/projects/${updated.project_id}/bids/${bidPackageId}`)
      }
      return updated
  })
}

export async function listProspectBidInvitesAction(bidPackageId: string) {
      return listBidInvites(bidPackageId)
}

export async function createProspectBidInviteAction(prospectId: string, input: unknown) {
  return run(async () => {
      const invite = await createBidInvite({ input })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${invite.bid_package_id}`)
      return invite
  })
}

export async function bulkCreateProspectBidInvitesAction(prospectId: string, bidPackageId: string, input: unknown) {
  return run(async () => {
      const result = await bulkCreateBidInvites({ input })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return result
  })
}

export async function generateProspectBidInviteLinkAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      const result = await generateBidInviteLink(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return result
  })
}

export async function resendProspectBidInviteAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      const result = await resendBidInvite({ inviteId })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return result
  })
}

export async function pauseProspectBidInviteAccessAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await pauseBidInviteAccess(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function resumeProspectBidInviteAccessAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await resumeBidInviteAccess(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function revokeProspectBidInviteAccessAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await revokeBidInviteAccess(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function setProspectBidInviteRequireAccountAction(
  prospectId: string,
  bidPackageId: string,
  inviteId: string,
  requireAccount: boolean
) {
  return run(async () => {
      await setBidInviteRequireAccount({ inviteId, requireAccount })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function pauseProspectBidInviteAccountGrantsAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await pauseBidInviteAccountGrants(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function resumeProspectBidInviteAccountGrantsAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await resumeBidInviteAccountGrants(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function revokeProspectBidInviteAccountGrantsAction(prospectId: string, bidPackageId: string, inviteId: string) {
  return run(async () => {
      await revokeBidInviteAccountGrants(inviteId)
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return { success: true }
  })
}

export async function listProspectBidAddendaAction(bidPackageId: string) {
      return listBidAddenda(bidPackageId)
}

export async function createProspectBidAddendumAction(prospectId: string, input: unknown) {
  return run(async () => {
      const addendum = await createBidAddendum({ input })
      revalidatePath(`${prospectBidsPath(prospectId)}/${addendum.bid_package_id}`)
      return addendum
  })
}

export async function listProspectBidSubmissionsAction(bidPackageId: string) {
      return listBidSubmissions(bidPackageId)
}

export async function createProspectManualBidSubmissionAction(prospectId: string, bidPackageId: string, input: unknown) {
  return run(async () => {
      const submission = await createManualBidSubmission({ input })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return submission
  })
}

export async function updateProspectBidSubmissionLevelingAction(prospectId: string, bidPackageId: string, input: unknown) {
  return run(async () => {
      const submission = await updateBidSubmissionLeveling({ input })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return submission
  })
}

export async function listProspectBidPackageRfisAction(bidPackageId: string) {
      return listBidPackageRfis(bidPackageId)
}

export async function listProspectBidPackageRfiResponsesAction(rfiId: string) {
      return listBidPackageRfiResponses({ rfiId })
}

export async function answerProspectBidPackageRfiAction(prospectId: string, bidPackageId: string, input: unknown) {
  return run(async () => {
      const result = await answerBidPackageRfi({ input })
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return result
  })
}

export async function listProspectBidPackageActivityAction(bidPackageId: string) {
      return listBidPackageActivity(bidPackageId)
}

export async function awardProspectBidSubmissionAction(
  prospectId: string,
  bidPackageId: string,
  bidSubmissionId: string,
  notes?: string | null
) {
  return run(async () => {
      const result = await awardBidSubmission({
        input: {
          bid_submission_id: bidSubmissionId,
          notes: notes ?? null,
        },
      })
      revalidatePath(prospectBidsPath(prospectId))
      revalidatePath(`${prospectBidsPath(prospectId)}/${bidPackageId}`)
      return result
  })
}
