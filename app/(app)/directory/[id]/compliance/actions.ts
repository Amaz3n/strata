"use server"

import { revalidatePath } from "next/cache"

import { runAction, type ActionResult } from "@/lib/action-result"
import {
  requestComplianceDocuments,
  revokeComplianceDecision,
  revokeCompanyRequirementWaiver,
  reviewComplianceDocument,
  setCompanyRequirements,
  uploadComplianceDocument,
  waiveAllCompanyRequirements,
  waiveCompanyRequirement,
} from "@/lib/services/compliance-documents"
import type { ComplianceDocument, ComplianceRequirement, ComplianceRequirementWaiver } from "@/lib/types"
import {
  complianceDocumentRequestSchema,
  complianceRequirementWaiverInputSchema,
  complianceRequirementWaiverRevokeSchema,
  complianceRequirementsBulkWaiverSchema,
  complianceReviewDecisionSchema,
  complianceRevokeDecisionSchema,
  complianceDocumentUploadSchema,
  type ComplianceRequirementInput,
} from "@/lib/validation/compliance-documents"

function revalidateCompany(companyId: string) {
  revalidatePath(`/directory/${companyId}/compliance`)
  revalidatePath(`/directory/${companyId}`)
  revalidatePath("/directory")
  // A decision changes what the payment gate sees, and the Control Tower
  // review count with it.
  revalidatePath("/control-tower")
}

export async function setCompanyRequirementsAction(
  companyId: string,
  requirements: ComplianceRequirementInput[],
): Promise<ActionResult<ComplianceRequirement[]>> {
  return runAction(async () => {
    const result = await setCompanyRequirements({ companyId, requirements })
    revalidateCompany(companyId)
    return result
  })
}

export async function waiveCompanyRequirementAction(
  companyId: string,
  input: unknown,
): Promise<ActionResult<ComplianceRequirementWaiver>> {
  return runAction(async () => {
    const parsed = complianceRequirementWaiverInputSchema.parse(input)
    const result = await waiveCompanyRequirement({ companyId, input: parsed })
    revalidateCompany(companyId)
    return result
  })
}

export async function revokeCompanyRequirementWaiverAction(
  waiverId: string,
  input?: unknown,
): Promise<ActionResult<ComplianceRequirementWaiver>> {
  return runAction(async () => {
    const parsed = complianceRequirementWaiverRevokeSchema.parse(input ?? {})
    const result = await revokeCompanyRequirementWaiver({ waiverId, input: parsed })
    revalidateCompany(result.company_id)
    return result
  })
}

export async function waiveAllCompanyRequirementsAction(
  companyId: string,
  input: unknown,
): Promise<ActionResult<ComplianceRequirementWaiver[]>> {
  return runAction(async () => {
    const parsed = complianceRequirementsBulkWaiverSchema.parse(input)
    const result = await waiveAllCompanyRequirements({ companyId, input: parsed })
    revalidateCompany(companyId)
    return result
  })
}

export async function uploadComplianceDocumentAction(params: {
  companyId: string
  fileId: string
  input: unknown
}): Promise<ActionResult<ComplianceDocument>> {
  return runAction(async () => {
    const parsed = complianceDocumentUploadSchema.parse(params.input)
    const result = await uploadComplianceDocument({
      companyId: params.companyId,
      input: parsed,
      fileId: params.fileId,
    })
    revalidateCompany(params.companyId)
    return result
  })
}

export async function reviewComplianceDocumentAction(
  documentId: string,
  decision: unknown,
): Promise<ActionResult<ComplianceDocument>> {
  return runAction(async () => {
    const parsed = complianceReviewDecisionSchema.parse(decision)
    const result = await reviewComplianceDocument({ documentId, decision: parsed })
    revalidateCompany(result.company_id)
    return result
  })
}

export async function revokeComplianceDecisionAction(
  documentId: string,
  input: unknown,
): Promise<ActionResult<ComplianceDocument>> {
  return runAction(async () => {
    const parsed = complianceRevokeDecisionSchema.parse(input)
    const result = await revokeComplianceDecision({ documentId, input: parsed })
    revalidateCompany(result.company_id)
    return result
  })
}

export async function requestComplianceDocumentsAction(
  companyId: string,
  input: unknown,
): Promise<ActionResult<{ sent: boolean; recipientEmail: string | null; documentCount: number }>> {
  return runAction(async () => {
    const parsed = complianceDocumentRequestSchema.parse(input)
    const result = await requestComplianceDocuments({ companyId, input: parsed })
    revalidateCompany(companyId)
    return result
  })
}
