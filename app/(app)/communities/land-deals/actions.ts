"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  attachDiligenceEvidence,
  createCommunityFromLandOpportunity,
  createDiligenceItem,
  createLandOpportunity,
  decideAcquisitionApproval,
  deleteDiligenceItem,
  dropLandOpportunity,
  linkLandOpportunityCommunity,
  removeDiligenceEvidence,
  reopenDiligenceItem,
  reopenLandOpportunity,
  resolveDiligenceItem,
  seedDiligenceChecklist,
  submitAcquisitionReview,
  updateDiligenceItem,
  updateLandOpportunity,
  withdrawAcquisitionReview,
} from "@/lib/services/land-opportunities"
import type {
  AcquisitionDecisionInput,
  AcquisitionReviewSubmit,
  DiligenceItemInput,
  DiligenceResolution,
  LandOpportunityInput,
  LandOpportunityUpdate,
} from "@/lib/validation/land-opportunities"

const DESK = "/communities/land-deals"

async function run<T>(operation: () => Promise<T>, paths: string[] = []): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    for (const path of paths) revalidatePath(path)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

const dealPaths = (dealId: string) => [DESK, `${DESK}/${dealId}`]

export async function createLandOpportunityAction(input: LandOpportunityInput) {
  return run(() => createLandOpportunity(input), [DESK])
}

export async function updateLandOpportunityAction(dealId: string, input: LandOpportunityUpdate) {
  return run(() => updateLandOpportunity(dealId, input), dealPaths(dealId))
}

export async function dropLandOpportunityAction(dealId: string, reason: string) {
  return run(() => dropLandOpportunity(dealId, { reason }), dealPaths(dealId))
}

export async function reopenLandOpportunityAction(dealId: string) {
  return run(() => reopenLandOpportunity(dealId), dealPaths(dealId))
}

export async function createDiligenceItemAction(dealId: string, input: DiligenceItemInput) {
  return run(() => createDiligenceItem(dealId, input), dealPaths(dealId))
}

export async function seedDiligenceChecklistAction(dealId: string) {
  return run(() => seedDiligenceChecklist(dealId), dealPaths(dealId))
}

export async function updateDiligenceItemAction(dealId: string, itemId: string, input: Partial<DiligenceItemInput>) {
  return run(() => updateDiligenceItem(itemId, input), dealPaths(dealId))
}

export async function deleteDiligenceItemAction(dealId: string, itemId: string) {
  return run(() => deleteDiligenceItem(itemId), dealPaths(dealId))
}

export async function resolveDiligenceItemAction(dealId: string, itemId: string, input: DiligenceResolution) {
  return run(() => resolveDiligenceItem(itemId, input), dealPaths(dealId))
}

export async function reopenDiligenceItemAction(dealId: string, itemId: string) {
  return run(() => reopenDiligenceItem(itemId), dealPaths(dealId))
}

export async function attachDiligenceEvidenceAction(dealId: string, itemId: string, formData: FormData) {
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { success: false as const, error: "Choose a file to attach" }
  return run(() => attachDiligenceEvidence(itemId, file), dealPaths(dealId))
}

export async function removeDiligenceEvidenceAction(dealId: string, itemId: string, linkId: string) {
  return run(() => removeDiligenceEvidence(itemId, linkId), dealPaths(dealId))
}

export async function submitAcquisitionReviewAction(dealId: string, input: AcquisitionReviewSubmit) {
  return run(() => submitAcquisitionReview(dealId, input), dealPaths(dealId))
}

export async function withdrawAcquisitionReviewAction(dealId: string, reviewId: string) {
  return run(() => withdrawAcquisitionReview(reviewId), dealPaths(dealId))
}

export async function decideAcquisitionApprovalAction(dealId: string, approvalId: string, input: AcquisitionDecisionInput) {
  return run(() => decideAcquisitionApproval(approvalId, input), dealPaths(dealId))
}

export async function createCommunityFromLandOpportunityAction(dealId: string) {
  return run(() => createCommunityFromLandOpportunity(dealId), [...dealPaths(dealId), "/communities"])
}

export async function linkLandOpportunityCommunityAction(dealId: string, communityId: string) {
  return run(() => linkLandOpportunityCommunity(dealId, { communityId }), dealPaths(dealId))
}
