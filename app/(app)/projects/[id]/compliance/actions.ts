"use server"

import { revalidatePath } from "next/cache"

import { actionError, type ActionResult } from "@/lib/action-result"
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents"
import {
  listProjectComplianceRequirements,
  setProjectComplianceRequirements,
} from "@/lib/services/project-compliance-requirements"
import type { ComplianceDocumentType, ComplianceRequirement } from "@/lib/types"
import type { ProjectComplianceRequirementInput } from "@/lib/validation/compliance-documents"

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await work() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listProjectVendorRequirementsAction(
  projectId: string,
): Promise<
  ActionResult<{ requirements: ComplianceRequirement[]; documentTypes: ComplianceDocumentType[] }>
> {
  return run(async () => {
    const [requirements, documentTypes] = await Promise.all([
      listProjectComplianceRequirements(projectId),
      listComplianceDocumentTypes(),
    ])
    return { requirements, documentTypes }
  })
}

export async function setProjectVendorRequirementsAction(
  projectId: string,
  requirements: ProjectComplianceRequirementInput[],
): Promise<ActionResult<ComplianceRequirement[]>> {
  return run(async () => {
    const result = await setProjectComplianceRequirements({ projectId, requirements })
    // The overlay changes what every vendor on this job owes, so the payables
    // and directory views of their status are both stale now.
    revalidatePath(`/projects/${projectId}`)
    revalidatePath("/directory")
    return result
  })
}
