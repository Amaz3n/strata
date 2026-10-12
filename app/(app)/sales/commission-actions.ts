"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, runAction, type ActionResult } from "@/lib/action-result"
import {
  approveCommissionPlan,
  getAgreementCommissionPlan,
  getClosingCommissions,
  markPayrollCommissionPaid,
  proposeCommissionPlan,
  searchCommissionConsultants,
  searchCommissionPayeeCompanies,
  type AgreementCommissionView,
} from "@/lib/services/sales-commissions"
import type { SearchPickerPage, SearchPickerQuery } from "@/components/ui/search-picker"

async function mutate(projectId: string, work: () => Promise<AgreementCommissionView>): Promise<ActionResult<AgreementCommissionView>> {
  try {
    const data = await work()
    revalidatePath(`/projects/${projectId}/closing`)
    revalidatePath("/sales")
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function getAgreementCommissionPlanAction(contractId: string) {
  return runAction(() => getAgreementCommissionPlan(z.string().uuid().parse(contractId)))
}

export async function getClosingCommissionsAction(projectId: string) {
  return runAction(() => getClosingCommissions(z.string().uuid().parse(projectId)))
}

export async function proposeCommissionPlanAction(projectId: string, input: unknown) {
  return mutate(z.string().uuid().parse(projectId), () => proposeCommissionPlan(input))
}

export async function approveCommissionPlanAction(projectId: string, input: unknown) {
  return mutate(z.string().uuid().parse(projectId), () => approveCommissionPlan(input))
}

export async function markPayrollCommissionPaidAction(projectId: string, input: unknown) {
  return runAction(async () => {
    const result = await markPayrollCommissionPaid(input)
    revalidatePath(`/projects/${z.string().uuid().parse(projectId)}/closing`)
    revalidatePath("/payables")
    return result
  })
}

export async function searchCommissionCompaniesAction(query: SearchPickerQuery): Promise<ActionResult<SearchPickerPage>> {
  return runAction(() => searchCommissionPayeeCompanies({ search: query.search, page: query.page ?? 1 }))
}

export async function searchCommissionConsultantsAction(query: SearchPickerQuery): Promise<ActionResult<SearchPickerPage>> {
  return runAction(() => searchCommissionConsultants({ search: query.search, page: query.page ?? 1 }))
}
