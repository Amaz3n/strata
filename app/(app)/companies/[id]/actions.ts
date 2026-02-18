"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentUpdateSchema } from "@/lib/validation/commitments"
import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { createCommitment, listCompanyCommitments, updateCommitment } from "@/lib/services/commitments"
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
