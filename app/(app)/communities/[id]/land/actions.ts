"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { SearchPickerPage } from "@/components/ui/search-picker"
import { actionError, type ActionResult } from "@/lib/action-result"
import { linkPhaseDevelopmentProject } from "@/lib/services/communities"
import { listDirectoryPage } from "@/lib/services/directory"
import {
  closeOutLandContract,
  createLandContract,
  executeLandContract,
  recordLandContractAmendment,
  recordLandContractDepositPayment,
  recordLandContractExtension,
  recordLandContractFeePayment,
  removeLandContractDeposit,
  scheduleLandContractDeposit,
  settleLandContractDeposit,
  updateLandContract,
} from "@/lib/services/land-contracts"
import {
  landAmendmentSchema,
  landContractCloseOutSchema,
  landContractExecutionSchema,
  landContractInputSchema,
  landContractUpdateSchema,
  landDepositInputSchema,
  landDepositPaymentSchema,
  landDepositSettlementSchema,
  landExtensionSchema,
  landFeePaymentSchema,
  phaseDevelopmentLinkSchema,
} from "@/lib/validation/land-contracts"

const uuid = z.string().uuid()

/** Every land mutation refreshes the Land tab and the board that sums its cash. */
async function run<T>(communityId: string, operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const community = uuid.parse(communityId)
    const data = await operation()
    revalidatePath(`/communities/${community}/land`)
    revalidatePath("/communities")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createLandContractAction(communityId: string, input: unknown) {
  return run(communityId, () => createLandContract(uuid.parse(communityId), landContractInputSchema.parse(input)))
}

export async function updateLandContractAction(communityId: string, contractId: string, input: unknown) {
  return run(communityId, () => updateLandContract(uuid.parse(contractId), landContractUpdateSchema.parse(input)))
}

export async function executeLandContractAction(communityId: string, contractId: string, input: unknown) {
  return run(communityId, () => executeLandContract(uuid.parse(contractId), landContractExecutionSchema.parse(input)))
}

export async function closeOutLandContractAction(communityId: string, contractId: string, input: unknown) {
  return run(communityId, () => closeOutLandContract(uuid.parse(contractId), landContractCloseOutSchema.parse(input)))
}

export async function scheduleLandContractDepositAction(communityId: string, contractId: string, input: unknown) {
  return run(communityId, () => scheduleLandContractDeposit(uuid.parse(contractId), landDepositInputSchema.parse(input)))
}

export async function removeLandContractDepositAction(communityId: string, depositId: string) {
  return run(communityId, () => removeLandContractDeposit(uuid.parse(depositId)))
}

export async function recordLandContractDepositPaymentAction(communityId: string, depositId: string, input: unknown) {
  return run(communityId, () => recordLandContractDepositPayment(uuid.parse(depositId), landDepositPaymentSchema.parse(input)))
}

export async function settleLandContractDepositAction(communityId: string, depositId: string, input: unknown) {
  return run(communityId, () => settleLandContractDeposit(uuid.parse(depositId), landDepositSettlementSchema.parse(input)))
}

export async function recordLandContractFeePaymentAction(communityId: string, amendmentId: string, input: unknown) {
  return run(communityId, () => recordLandContractFeePayment(uuid.parse(amendmentId), landFeePaymentSchema.parse(input)))
}

export async function recordLandContractExtensionAction(communityId: string, input: unknown) {
  return run(communityId, () => recordLandContractExtension(landExtensionSchema.parse(input)))
}

export async function recordLandContractAmendmentAction(communityId: string, contractId: string, input: unknown) {
  return run(communityId, () => recordLandContractAmendment(uuid.parse(contractId), landAmendmentSchema.parse(input)))
}

export async function linkPhaseDevelopmentProjectAction(communityId: string, phaseId: string, input: unknown) {
  return run(communityId, () => linkPhaseDevelopmentProject(uuid.parse(phaseId), phaseDevelopmentLinkSchema.parse(input)))
}

const sellerSearchSchema = z.object({
  search: z.string().max(80).default(""),
  page: z.number().int().min(1).max(100_000).default(1),
})

/** Seller picker: one scoped page of directory companies per search, never the roster. */
export async function searchLandSellersAction(input: unknown): Promise<ActionResult<SearchPickerPage>> {
  try {
    const query = sellerSearchSchema.parse(input)
    const pageSize = 25
    const result = await listDirectoryPage({ kind: "company", page: query.page, pageSize, search: query.search || undefined, sort: "name", direction: "asc" })
    return {
      success: true,
      data: {
        items: result.entries.map((row) => ({ id: row.id, name: row.name, detail: row.detail ?? "" })),
        nextCursor: null,
        nextPage: result.page * result.pageSize < result.total ? result.page + 1 : null,
      },
    }
  } catch (error) {
    return actionError(error)
  }
}
