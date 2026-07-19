"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { actionError, type ActionResult } from "@/lib/action-result"
import { IMPORTER_KEYS, type ImporterKey } from "@/lib/services/import-definitions"
import { suggestImportColumnMapping } from "@/lib/services/import-mapping"
import { parseCsv } from "@/lib/services/import-parsers"
import { commitImportBatch, discardImportBatch, getImportMappingProfile, patchImportRow, setImportUpdateExisting, stageImportBatch } from "@/lib/services/imports"

const importerSchema = z.enum(IMPORTER_KEYS).refine((value) => value !== "open_wip", "Open-WIP is platform-only")
const uuid = z.string().uuid()

function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> { return fn().then((data) => ({ success: true as const, data })).catch((error) => actionError(error)) }
function path(importer: ImporterKey) { return `/settings/imports/${importer}` }

export async function previewOrgImportAction(input: { orgId?: string; importer: ImporterKey; csvText: string }) {
  return run(async () => {
    const parsedInput = z.object({ importer: importerSchema, csvText: z.string().min(1).max(10 * 1024 * 1024) }).parse(input)
    const parsed = parseCsv(parsedInput.csvText)
    const profile = await getImportMappingProfile(parsedInput.importer, parsed.headers)
    const suggestion = profile ? { mappings: Object.entries(profile).map(([target, source]) => ({ target, source, confidence: "high" as const, note: "Saved mapping profile" })), unmapped_sources: [], unmatched_targets: Object.entries(profile).filter(([, source]) => !source).map(([target]) => target) } : await suggestImportColumnMapping({ importer: parsedInput.importer, sourceHeaders: parsed.headers, sampleRows: parsed.rows.slice(0, 5) })
    return { headers: parsed.headers, rowCount: parsed.rows.length, suggestion, profileApplied: Boolean(profile) }
  })
}

export async function stageOrgImportAction(input: { orgId?: string; importer: ImporterKey; csvText: string; sourceFilename?: string; mapping: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }) {
  return run(async () => {
    const parsed = z.object({ importer: importerSchema, csvText: z.string().min(1).max(10 * 1024 * 1024), sourceFilename: z.string().max(255).optional(), mapping: z.record(z.string().nullable()), context: z.record(z.unknown()).optional() }).parse(input)
    const result = await stageImportBatch(parsed)
    revalidatePath(path(parsed.importer))
    return result
  })
}

export async function patchOrgImportRowAction(input: { orgId?: string; importer: ImporterKey; batchId: string; rowId: string; patch?: Record<string, string | number | boolean | null>; skip?: boolean }) {
  return run(async () => {
    const parsed = z.object({ importer: importerSchema, batchId: uuid, rowId: uuid, patch: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), skip: z.boolean().optional() }).parse(input)
    const result = await patchImportRow({ batchId: parsed.batchId, rowId: parsed.rowId, patch: parsed.patch ?? {}, skip: parsed.skip })
    revalidatePath(path(parsed.importer)); return result
  })
}

export async function setOrgImportUpdateExistingAction(input: { orgId?: string; importer: ImporterKey; batchId: string; updateExisting: boolean }) {
  return run(async () => { const parsed = z.object({ importer: importerSchema, batchId: uuid, updateExisting: z.boolean() }).parse(input); await setImportUpdateExisting(parsed.batchId, parsed.updateExisting); revalidatePath(path(parsed.importer)) })
}

export async function commitOrgImportAction(input: { orgId?: string; importer: ImporterKey; batchId: string }) {
  return run(async () => { const parsed = z.object({ importer: importerSchema, batchId: uuid }).parse(input); const result = await commitImportBatch(parsed.batchId); revalidatePath(path(parsed.importer)); return result })
}

export async function discardOrgImportAction(input: { orgId?: string; importer: ImporterKey; batchId: string }) {
  return run(async () => { const parsed = z.object({ importer: importerSchema, batchId: uuid }).parse(input); await discardImportBatch(parsed.batchId); revalidatePath(path(parsed.importer)) })
}
