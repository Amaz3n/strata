"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { parseCsv } from "@/lib/services/import-parsers"
import { suggestImportColumnMapping } from "@/lib/services/import-mapping"
import { commitImportBatch, discardImportBatch, getImportMappingProfile, patchImportRow, setImportUpdateExisting, stageImportBatch } from "@/lib/services/imports"
import { completeOnboardingStage, createOnboardingRun, getOnboardingRun, markRunLive, ONBOARDING_STAGE_KEYS, skipOnboardingStage, updateOnboardingRun } from "@/lib/services/onboarding"
import { ONBOARDING_READINESS_ITEMS } from "@/lib/data/onboarding-readiness"
import { deleteSampleCommunity, seedSampleCommunity } from "@/lib/services/demo-community-seed"

const uuid = z.string().uuid()
const importerSchema = z.enum(IMPORTER_KEYS)
const stageKeySchema = z.enum(ONBOARDING_STAGE_KEYS)

function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  return fn().then((data) => ({ success: true as const, data })).catch((error) => actionError(error))
}

function platformAccess(orgId: string) { return { platformOrgId: orgId } }

export async function createOnboardingRunAction(orgId: string) {
  return run(async () => {
    const parsed = uuid.parse(orgId)
    const result = await createOnboardingRun({ orgId: parsed })
    revalidatePath(`/admin/customers/${parsed}/onboarding`)
    return result
  })
}

export async function updateOnboardingRunAction(formData: FormData) {
  return run(async () => {
    const parsed = z.object({ runId: uuid, orgId: uuid, targetLiveDate: z.string().optional(), pilotCommunityId: z.string().uuid().optional(), pilotDivisionId: z.string().uuid().optional(), notes: z.string().max(5000).optional() }).parse({ runId: formData.get("runId"), orgId: formData.get("orgId"), targetLiveDate: formData.get("targetLiveDate") || undefined, pilotCommunityId: formData.get("pilotCommunityId") || undefined, pilotDivisionId: formData.get("pilotDivisionId") || undefined, notes: formData.get("notes") || undefined })
    const auditSubmitted = formData.get("readinessAuditSubmitted") === "true"
    const passed = new Set(formData.getAll("readinessPassed").map(String))
    const verifiedBy = String(formData.get("readinessVerifiedBy") ?? "").trim()
    const volume = String(formData.get("readinessVolume") ?? "").trim()
    const readinessAudit = auditSubmitted
      ? ONBOARDING_READINESS_ITEMS.map(([key, label]) => ({ key, label, passed: passed.has(key), verified_by: verifiedBy, volume }))
      : undefined
    const result = await updateOnboardingRun({ runId: parsed.runId, targetLiveDate: parsed.targetLiveDate, pilotCommunityId: parsed.pilotCommunityId, pilotDivisionId: parsed.pilotDivisionId, notes: parsed.notes, readinessAudit })
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding`)
    return result
  })
}

export async function completeOnboardingStageAction(formData: FormData) {
  return run(async () => {
    const parsed = z.object({ runId: uuid, orgId: uuid, stageKey: stageKeySchema, notes: z.string().max(5000).optional(), evidence: z.string().optional() }).parse({ runId: formData.get("runId"), orgId: formData.get("orgId"), stageKey: formData.get("stageKey"), notes: formData.get("notes") || undefined, evidence: formData.get("evidence") || undefined })
    const evidence = parsed.evidence ? z.record(z.unknown()).parse(JSON.parse(parsed.evidence)) : undefined
    const result = await completeOnboardingStage({ runId: parsed.runId, stageKey: parsed.stageKey, notes: parsed.notes, evidence })
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding`)
    return result
  })
}

export async function skipOnboardingStageAction(formData: FormData) {
  return run(async () => {
    const parsed = z.object({ runId: uuid, orgId: uuid, stageKey: stageKeySchema, reason: z.string().trim().min(3).max(1000) }).parse({ runId: formData.get("runId"), orgId: formData.get("orgId"), stageKey: formData.get("stageKey"), reason: formData.get("reason") })
    const result = await skipOnboardingStage({ runId: parsed.runId, stageKey: parsed.stageKey, reason: parsed.reason, evidence: parsed.stageKey === "accounting" ? { accounting_unconnected_acknowledged: true } : undefined })
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding`)
    return result
  })
}

export async function markRunLiveAction(formData: FormData) {
  return run(async () => {
    const parsed = z.object({ runId: uuid, orgId: uuid }).parse({ runId: formData.get("runId"), orgId: formData.get("orgId") })
    const result = await markRunLive(parsed.runId)
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding`)
    return result
  })
}

export async function resetSampleCommunityAction(formData: FormData) {
  return run(async () => {
    const orgId = uuid.parse(formData.get("orgId"))
    await getOnboardingRun(orgId)
    const { user } = await requireAuth()
    const supabase = createServiceSupabaseClient()
    const { data: existing } = await supabase.from("communities").select("id").eq("org_id", orgId).contains("metadata", { is_sample: true }).maybeSingle()
    if (existing) await deleteSampleCommunity(orgId, existing.id, user.id)
    const result = await seedSampleCommunity(orgId, user.id)
    revalidatePath(`/admin/customers/${orgId}/onboarding`)
    return result
  })
}

export async function previewImportAction(input: { orgId: string; importer: ImporterKey; csvText: string }) {
  return run(async () => {
    const parsedInput = z.object({ orgId: uuid, importer: importerSchema, csvText: z.string().min(1).max(10 * 1024 * 1024) }).parse(input)
    const parsed = parseCsv(parsedInput.csvText)
    const profile = await getImportMappingProfile(parsedInput.importer, parsed.headers, platformAccess(parsedInput.orgId))
    const suggestion = profile
      ? { mappings: Object.entries(profile).map(([target, source]) => ({ target, source, confidence: "high" as const, note: "Saved mapping profile" })), unmapped_sources: [], unmatched_targets: Object.entries(profile).filter(([, source]) => !source).map(([target]) => target) }
      : await suggestImportColumnMapping({ importer: parsedInput.importer, sourceHeaders: parsed.headers, sampleRows: parsed.rows.slice(0, 5) })
    return { headers: parsed.headers, rowCount: parsed.rows.length, suggestion, profileApplied: Boolean(profile) }
  })
}

export async function stageImportAction(input: { orgId: string; importer: ImporterKey; csvText: string; sourceFilename?: string; mapping: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }) {
  return run(async () => {
    const parsed = z.object({ orgId: uuid, importer: importerSchema, csvText: z.string().min(1).max(10 * 1024 * 1024), sourceFilename: z.string().max(255).optional(), mapping: z.record(z.string().nullable()), context: z.record(z.unknown()).optional(), onboardingRunId: z.string().uuid().nullable().optional() }).parse(input)
    const result = await stageImportBatch({ importer: parsed.importer, csvText: parsed.csvText, sourceFilename: parsed.sourceFilename, mapping: parsed.mapping, context: parsed.context, onboardingRunId: parsed.onboardingRunId }, platformAccess(parsed.orgId))
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding/import/${parsed.importer}`)
    return result
  })
}

export async function patchImportRowAction(input: { orgId: string; importer: ImporterKey; batchId: string; rowId: string; patch?: Record<string, string | number | boolean | null>; skip?: boolean }) {
  return run(async () => {
    const parsed = z.object({ orgId: uuid, importer: importerSchema, batchId: uuid, rowId: uuid, patch: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), skip: z.boolean().optional() }).parse(input)
    const result = await patchImportRow({ batchId: parsed.batchId, rowId: parsed.rowId, patch: parsed.patch ?? {}, skip: parsed.skip }, platformAccess(parsed.orgId))
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding/import/${parsed.importer}`)
    return result
  })
}

export async function setImportUpdateExistingAction(input: { orgId: string; importer: ImporterKey; batchId: string; updateExisting: boolean }) {
  return run(async () => {
    const parsed = z.object({ orgId: uuid, importer: importerSchema, batchId: uuid, updateExisting: z.boolean() }).parse(input)
    await setImportUpdateExisting(parsed.batchId, parsed.updateExisting, platformAccess(parsed.orgId))
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding/import/${parsed.importer}`)
  })
}

export async function commitImportAction(input: { orgId: string; importer: ImporterKey; batchId: string }) {
  return run(async () => {
    const parsed = z.object({ orgId: uuid, importer: importerSchema, batchId: uuid }).parse(input)
    const result = await commitImportBatch(parsed.batchId, platformAccess(parsed.orgId))
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding/import/${parsed.importer}`)
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding`)
    return result
  })
}

export async function discardImportAction(input: { orgId: string; importer: ImporterKey; batchId: string }) {
  return run(async () => {
    const parsed = z.object({ orgId: uuid, importer: importerSchema, batchId: uuid }).parse(input)
    await discardImportBatch(parsed.batchId, platformAccess(parsed.orgId))
    revalidatePath(`/admin/customers/${parsed.orgId}/onboarding/import/${parsed.importer}`)
  })
}
