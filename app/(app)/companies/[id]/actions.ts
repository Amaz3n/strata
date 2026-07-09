"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentLineInputSchema, commitmentUpdateSchema } from "@/lib/validation/commitments"
import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { createCommitment, createCommitmentLine, listCompanyCommitments, updateCommitment } from "@/lib/services/commitments"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listVendorBillsForCompany, updateVendorBillStatus } from "@/lib/services/vendor-bills"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


export async function listCompanyCommitmentsAction(companyId: string) {
  return await listCompanyCommitments(companyId)
}

export async function createCompanyCommitmentAction(input: unknown) {
  return run(async () => {
    const parsed = commitmentInputSchema.parse(input)
    const result = await createCommitment({ input: parsed })
    revalidatePath(`/companies/${parsed.company_id}`)
    revalidatePath("/directory")
    return result
  })
}

export async function createCompanyCommitmentWithLineAction(input: unknown) {
  return run(async () => {
    const payload = input as { commitment?: unknown; line?: unknown }
    const commitmentInput = commitmentInputSchema.parse(payload.commitment)
    const lineInput = commitmentLineInputSchema.parse(payload.line)
    const result = await createCommitment({ input: commitmentInput })
    await createCommitmentLine(result.id, lineInput)
    revalidatePath(`/companies/${commitmentInput.company_id}`)
    revalidatePath(`/projects/${commitmentInput.project_id}/financials/budget`)
    revalidatePath(`/projects/${commitmentInput.project_id}/vendors`)
    revalidatePath("/directory")
    return result
  })
}

export async function listCompanyCommitmentCostCodesAction() {
  return await listCostCodes()
}

export async function updateCompanyCommitmentAction(commitmentId: string, input: unknown) {
  return run(async () => {
    const parsed = commitmentUpdateSchema.parse(input)
    const result = await updateCommitment({ commitmentId, input: parsed })
    revalidatePath("/directory")
    return result
  })
}

export async function listCompanyVendorBillsAction(companyId: string) {
  return await listVendorBillsForCompany(companyId)
}

export async function updateVendorBillStatusAction(billId: string, companyId: string, input: unknown) {
  return run(async () => {
    const parsed = vendorBillStatusUpdateSchema.parse(input)
    const updated = await updateVendorBillStatus({ billId, input: parsed })
    revalidatePath(`/companies/${companyId}`)
    revalidatePath("/directory")
    return updated
  })
}
