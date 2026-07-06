"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentLineInputSchema, commitmentUpdateSchema } from "@/lib/validation/commitments"
import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { createCommitment, createCommitmentLine, listCompanyCommitments, updateCommitment } from "@/lib/services/commitments"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listVendorBillsForCompany, updateVendorBillStatus } from "@/lib/services/vendor-bills"
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function listCompanyCommitmentsAction(companyId: string) {
  try {
    return await listCompanyCommitments(companyId)
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createCompanyCommitmentAction(input: unknown) {
  try {
    const parsed = commitmentInputSchema.parse(input)
    const result = await createCommitment({ input: parsed })
    revalidatePath(`/companies/${parsed.company_id}`)
    revalidatePath("/directory")
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createCompanyCommitmentWithLineAction(input: unknown) {
  try {
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
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listCompanyCommitmentCostCodesAction() {
  try {
    return await listCostCodes()
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateCompanyCommitmentAction(commitmentId: string, input: unknown) {
  try {
    const parsed = commitmentUpdateSchema.parse(input)
    const result = await updateCommitment({ commitmentId, input: parsed })
    revalidatePath("/directory")
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listCompanyVendorBillsAction(companyId: string) {
  try {
    return await listVendorBillsForCompany(companyId)
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function updateVendorBillStatusAction(billId: string, companyId: string, input: unknown) {
  try {
    const parsed = vendorBillStatusUpdateSchema.parse(input)
    const updated = await updateVendorBillStatus({ billId, input: parsed })
    revalidatePath(`/companies/${companyId}`)
    revalidatePath("/directory")
    return updated
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
