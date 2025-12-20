"use server"

import { revalidatePath } from "next/cache"

import { commitmentInputSchema, commitmentUpdateSchema } from "@/lib/validation/commitments"
import { vendorBillStatusUpdateSchema } from "@/lib/validation/vendor-bills"
import { createCommitment, listCompanyCommitments, updateCommitment } from "@/lib/services/commitments"
import { listVendorBillsForCompany, updateVendorBillStatus } from "@/lib/services/vendor-bills"

export async function listCompanyCommitmentsAction(companyId: string) {
  return listCompanyCommitments(companyId)
}

export async function createCompanyCommitmentAction(input: unknown) {
  const parsed = commitmentInputSchema.parse(input)
  const result = await createCommitment({ input: parsed })
  revalidatePath(`/companies/${parsed.company_id}`)
  revalidatePath("/directory")
  return result
}

export async function updateCompanyCommitmentAction(commitmentId: string, input: unknown) {
  const parsed = commitmentUpdateSchema.parse(input)
  const result = await updateCommitment({ commitmentId, input: parsed })
  revalidatePath("/directory")
  return result
}

export async function listCompanyVendorBillsAction(companyId: string) {
  return listVendorBillsForCompany(companyId)
}

export async function updateVendorBillStatusAction(billId: string, companyId: string, input: unknown) {
  const parsed = vendorBillStatusUpdateSchema.parse(input)
  const updated = await updateVendorBillStatus({ billId, input: parsed })
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/directory")
  return updated
}
