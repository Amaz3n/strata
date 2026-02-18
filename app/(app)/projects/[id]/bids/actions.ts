"use server"

import { revalidatePath } from "next/cache"
import {
  createBidPackage,
  updateBidPackage,
  listBidPackages,
  getBidPackage,
  listBidInvites,
  createBidInvite,
  bulkCreateBidInvites,
  generateBidInviteLink,
  listBidAddenda,
  createBidAddendum,
  listBidSubmissions,
  awardBidSubmission,
  pauseBidInviteAccess,
  resumeBidInviteAccess,
  revokeBidInviteAccess,
  setBidInviteRequireAccount,
} from "@/lib/services/bids"
import {
  pauseBidInviteAccountGrants,
  resumeBidInviteAccountGrants,
  revokeBidInviteAccountGrants,
} from "@/lib/services/external-portal-auth"

export async function listBidPackagesAction(projectId: string) {
  return listBidPackages(projectId)
}

export async function getBidPackageAction(bidPackageId: string) {
  return getBidPackage(bidPackageId)
}

export async function createBidPackageAction(projectId: string, input: unknown) {
  const created = await createBidPackage({
    input: { ...(input as any), project_id: projectId },
  })
  revalidatePath(`/projects/${projectId}/bids`)
  return created
}

export async function updateBidPackageAction(bidPackageId: string, projectId: string, input: unknown) {
  const updated = await updateBidPackage({ bidPackageId, input })
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return updated
}

export async function listBidInvitesAction(bidPackageId: string) {
  return listBidInvites(bidPackageId)
}

export async function createBidInviteAction(projectId: string, input: unknown) {
  const invite = await createBidInvite({ input })
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${invite.bid_package_id}`)
  return invite
}

export async function bulkCreateBidInvitesAction(projectId: string, bidPackageId: string, input: unknown) {
  const result = await bulkCreateBidInvites({ input })
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return result
}

export async function generateBidInviteLinkAction(projectId: string, bidPackageId: string, inviteId: string) {
  const result = await generateBidInviteLink(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return result
}

export async function pauseBidInviteAccessAction(projectId: string, bidPackageId: string, inviteId: string) {
  await pauseBidInviteAccess(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function resumeBidInviteAccessAction(projectId: string, bidPackageId: string, inviteId: string) {
  await resumeBidInviteAccess(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function revokeBidInviteAccessAction(projectId: string, bidPackageId: string, inviteId: string) {
  await revokeBidInviteAccess(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function setBidInviteRequireAccountAction(
  projectId: string,
  bidPackageId: string,
  inviteId: string,
  requireAccount: boolean,
) {
  await setBidInviteRequireAccount({ inviteId, requireAccount })
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function pauseBidInviteAccountGrantsAction(projectId: string, bidPackageId: string, inviteId: string) {
  await pauseBidInviteAccountGrants(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function resumeBidInviteAccountGrantsAction(projectId: string, bidPackageId: string, inviteId: string) {
  await resumeBidInviteAccountGrants(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function revokeBidInviteAccountGrantsAction(projectId: string, bidPackageId: string, inviteId: string) {
  await revokeBidInviteAccountGrants(inviteId)
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  return { success: true }
}

export async function listBidAddendaAction(bidPackageId: string) {
  return listBidAddenda(bidPackageId)
}

export async function createBidAddendumAction(projectId: string, input: unknown) {
  const addendum = await createBidAddendum({ input })
  revalidatePath(`/projects/${projectId}/bids/${addendum.bid_package_id}`)
  return addendum
}

export async function listBidSubmissionsAction(bidPackageId: string) {
  return listBidSubmissions(bidPackageId)
}

export async function awardBidSubmissionAction(
  projectId: string,
  bidPackageId: string,
  bidSubmissionId: string,
  notes?: string | null,
) {
  const result = await awardBidSubmission({
    input: {
      bid_submission_id: bidSubmissionId,
      notes: notes ?? null,
    },
  })
  revalidatePath(`/projects/${projectId}/bids`)
  revalidatePath(`/projects/${projectId}/bids/${bidPackageId}`)
  revalidatePath(`/projects/${projectId}/commitments`)
  return result
}
