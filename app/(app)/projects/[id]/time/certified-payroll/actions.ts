"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import {
  certifiedPayrollRegisterCsv,
  createCertifiedPayrollReport,
  createWageClassification,
  createWageDetermination,
  finalizeCertifiedPayroll,
  savePayrollWorkerProfile,
  updateCertifiedPayrollLine,
} from "@/lib/services/certified-payroll"
import type {
  CertifiedPayrollLineUpdate,
  CreateCertifiedPayrollInput,
  WageClassificationInput,
  WageDeterminationInput,
  WorkerProfileInput,
} from "@/lib/validation/certified-payroll"

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await work() } } catch (error) { return actionError(error) }
}

function refresh(projectId: string) {
  revalidatePath(`/projects/${projectId}/time`)
  revalidatePath(`/projects/${projectId}/time/certified-payroll`)
}

export async function createWageDeterminationAction(input: WageDeterminationInput) {
  return run(async () => { const result = await createWageDetermination(input); refresh(input.project_id); return result })
}

export async function createWageClassificationAction(projectId: string, input: WageClassificationInput) {
  return run(async () => { const result = await createWageClassification(input); refresh(projectId); return result })
}

export async function savePayrollWorkerProfileAction(projectId: string, input: WorkerProfileInput, profileId?: string) {
  return run(async () => { const result = await savePayrollWorkerProfile(input, profileId); refresh(projectId); return result })
}

export async function createCertifiedPayrollAction(input: CreateCertifiedPayrollInput) {
  return run(async () => { const result = await createCertifiedPayrollReport(input); refresh(input.project_id); return result })
}

export async function updateCertifiedPayrollLineAction(projectId: string, lineId: string, input: CertifiedPayrollLineUpdate) {
  return run(async () => { const result = await updateCertifiedPayrollLine(lineId, input); refresh(projectId); return result })
}

export async function finalizeCertifiedPayrollAction(projectId: string, reportId: string) {
  return run(async () => { const result = await finalizeCertifiedPayroll(reportId); refresh(projectId); return result })
}

export async function certifiedPayrollRegisterCsvAction(projectId: string) {
  return run(() => certifiedPayrollRegisterCsv(projectId))
}
