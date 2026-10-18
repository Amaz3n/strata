"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import {
  assessPermitFee,
  assignPermitApplication,
  createPermitApplication,
  getPermitJurisdictionProfile,
  linkPermitFeePayment,
  payPermitFee,
  recordCorrectionRound,
  recordPermitDecision,
  recordPermitSubmission,
  searchPermitAuthorities,
  setPermitDocument,
  setPermitJurisdictionProfile,
  updateCorrectionRound,
  voidPermitFee,
} from "@/lib/services/permits"

// Inputs are Zod-validated by the service; each action names the home it revalidates.
async function run<T>(projectId: string, operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const home = z.string().uuid().parse(projectId)
    const data = await operation()
    revalidatePath(`/projects/${home}/permits`)
    revalidatePath("/starts")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function createPermitApplicationAction(projectId: string, input: unknown) { return run(projectId, () => createPermitApplication({ ...z.object({}).passthrough().parse(input), projectId })) }
export async function assignPermitApplicationAction(projectId: string, input: unknown) { return run(projectId, () => assignPermitApplication(input)) }
export async function setPermitDocumentAction(projectId: string, input: unknown) { return run(projectId, () => setPermitDocument(input)) }
export async function recordPermitSubmissionAction(projectId: string, input: unknown) { return run(projectId, () => recordPermitSubmission(input)) }
export async function recordCorrectionRoundAction(projectId: string, input: unknown) { return run(projectId, () => recordCorrectionRound(input)) }
export async function updateCorrectionRoundAction(projectId: string, input: unknown) { return run(projectId, () => updateCorrectionRound(input)) }
export async function recordPermitDecisionAction(projectId: string, input: unknown) { return run(projectId, () => recordPermitDecision(input)) }
export async function assessPermitFeeAction(projectId: string, input: unknown) { return run(projectId, () => assessPermitFee(input)) }
export async function voidPermitFeeAction(projectId: string, input: unknown) { return run(projectId, () => voidPermitFee(input)) }
export async function linkPermitFeePaymentAction(projectId: string, input: unknown) { return run(projectId, () => linkPermitFeePayment(input)) }
export async function payPermitFeeAction(projectId: string, input: unknown) { return run(projectId, () => payPermitFee(input)) }
export async function setPermitJurisdictionProfileAction(projectId: string, input: unknown) { return run(projectId, () => setPermitJurisdictionProfile(input)) }

export async function getPermitJurisdictionProfileAction(companyId: string) {
  try {
    return { success: true as const, data: await getPermitJurisdictionProfile(z.string().uuid().parse(companyId)) }
  } catch (error) {
    return actionError(error)
  }
}

export async function searchPermitAuthoritiesAction(query: { search: string; page?: number }) {
  try {
    const parsed = z.object({ search: z.string().max(120), page: z.number().int().positive().optional() }).parse(query)
    return { success: true as const, data: await searchPermitAuthorities(parsed) }
  } catch (error) {
    return actionError(error)
  }
}
