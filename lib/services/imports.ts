import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireAuth } from "@/lib/auth/context"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createOrgMemberInvite } from "@/lib/services/team"
import {
  IMPORTER_DEFINITIONS,
  IMPORTER_KEYS,
  parseImporterRow,
  type ImporterKey,
} from "@/lib/services/import-definitions"
import {
  normalizeKey,
  normalizeVendorName,
  parseCsv,
  similarity,
  sourceSignature,
  topologicalOrder,
  type ImportIssue,
  type ImportParsedRow,
} from "@/lib/services/import-parsers"

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 10_000
const INSERT_CHUNK = 500

export interface ImportAccess {
  orgId?: string
  platformOrgId?: string
}

interface ResolvedImportContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
  platform: boolean
}

export interface ImportBatchSummary {
  id: string
  importer: ImporterKey
  status: string
  source_filename: string | null
  row_count: number
  valid_count: number
  warning_count: number
  error_count: number
  committed_count: number
  skipped_count: number
  report: Record<string, unknown>
  context: Record<string, unknown>
  update_existing: boolean
  onboarding_run_id: string | null
  created_at: string
  committed_at: string | null
}

export interface ImportRowRecord {
  id: string
  row_number: number
  raw: Record<string, string>
  parsed: ImportParsedRow
  status: string
  issues: ImportIssue[]
  natural_key: string
  target_entity_type: string | null
  target_entity_id: string | null
  action: string | null
}

async function resolveImportContext(access: ImportAccess = {}): Promise<ResolvedImportContext> {
  if (access.platformOrgId) {
    const [platformAccess, auth] = await Promise.all([getCurrentPlatformAccess(), requireAuth()])
    if (!platformAccess.canAccessPlatform) throw new Error("Platform access is required")
    const supabase = createServiceSupabaseClient()
    const { data: org, error } = await supabase.from("orgs").select("id").eq("id", access.platformOrgId).maybeSingle()
    if (error || !org) throw new Error("Organization not found")
    return { supabase, orgId: org.id, userId: auth.user.id, platform: true }
  }

  const context = await requireOrgContext(access.orgId)
  await requirePermission("import.manage", context)
  return { ...context, supabase: createServiceSupabaseClient(), platform: false }
}

async function requireImporterPermission(importer: ImporterKey, context: ResolvedImportContext) {
  if (context.platform) return
  if (importer === "open_wip") throw new Error("Open-WIP cutover is restricted to the platform onboarding workbench")
  if (importer === "price_book") await requireAnyPermission(["price_book.write", "commitment.write"], context)
  if (importer === "plan_library") await requirePermission("plan.write", context)
  if (importer === "option_catalog") await requirePermission("selections.catalog.manage", context)
  if (importer === "communities_lots") await requireAnyPermission(["community.write", "lot.write"], context)
  if (importer === "team") await requirePermission("members.manage", context)
}

function mapBatch(row: Record<string, unknown>): ImportBatchSummary {
  return {
    id: String(row.id), importer: row.importer as ImporterKey, status: String(row.status),
    source_filename: typeof row.source_filename === "string" ? row.source_filename : null,
    row_count: Number(row.row_count ?? 0), valid_count: Number(row.valid_count ?? 0),
    warning_count: Number(row.warning_count ?? 0), error_count: Number(row.error_count ?? 0),
    committed_count: Number(row.committed_count ?? 0), skipped_count: Number(row.skipped_count ?? 0),
    report: (row.report ?? {}) as Record<string, unknown>, context: (row.context ?? {}) as Record<string, unknown>,
    update_existing: Boolean(row.update_existing),
    onboarding_run_id: typeof row.onboarding_run_id === "string" ? row.onboarding_run_id : null,
    created_at: String(row.created_at), committed_at: typeof row.committed_at === "string" ? row.committed_at : null,
  }
}

function mapImportRow(row: Record<string, unknown>): ImportRowRecord {
  return {
    id: String(row.id), row_number: Number(row.row_number),
    raw: (row.raw ?? {}) as Record<string, string>, parsed: (row.parsed ?? {}) as ImportParsedRow,
    status: String(row.status), issues: (row.issues ?? []) as ImportIssue[], natural_key: String(row.natural_key),
    target_entity_type: typeof row.target_entity_type === "string" ? row.target_entity_type : null,
    target_entity_id: typeof row.target_entity_id === "string" ? row.target_entity_id : null,
    action: typeof row.action === "string" ? row.action : null,
  }
}

export async function listImportBatches(input: { importer?: ImporterKey; page?: number; limit?: number } = {}, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  if (input.importer) await requireImporterPermission(input.importer, context)
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const page = Math.max(input.page ?? 1, 1)
  let query = context.supabase.from("import_batches").select("*", { count: "exact" }).eq("org_id", context.orgId).order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1)
  if (input.importer) query = query.eq("importer", input.importer)
  const { data, error, count } = await query
  if (error) throw new Error(`Failed to list import batches: ${error.message}`)
  return { batches: (data ?? []).map(mapBatch), total: count ?? 0, page, limit }
}

export async function getImportBatch(batchId: string, input: { page?: number; limit?: number; status?: string } = {}, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: batch, error: batchError } = await context.supabase.from("import_batches").select("*").eq("org_id", context.orgId).eq("id", batchId).maybeSingle()
  if (batchError || !batch) throw new Error("Import batch not found")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500)
  const page = Math.max(input.page ?? 1, 1)
  let query = context.supabase.from("import_rows").select("*", { count: "exact" }).eq("org_id", context.orgId).eq("batch_id", batchId).order("row_number").range((page - 1) * limit, page * limit - 1)
  if (input.status && input.status !== "all") query = query.eq("status", input.status)
  const { data: rows, error: rowsError, count } = await query
  if (rowsError) throw new Error(`Failed to list import rows: ${rowsError.message}`)
  return { batch: mapBatch(batch), rows: (rows ?? []).map(mapImportRow), total: count ?? 0, page, limit }
}

function exactColumnMapping(importer: ImporterKey, headers: string[]) {
  const byNormalized = new Map(headers.map((header) => [normalizeKey(header), header]))
  return Object.fromEntries(IMPORTER_DEFINITIONS[importer].columns.map((column) => [column.key, byNormalized.get(normalizeKey(column.key)) ?? null]))
}

async function saveMappingProfile(context: ResolvedImportContext, importer: ImporterKey, headers: string[], mapping: Record<string, string | null>) {
  const signature = sourceSignature(headers)
  const { error } = await context.supabase.from("import_mapping_profiles").upsert({ org_id: context.orgId, importer, source_signature: signature, column_mapping: mapping, created_by: context.userId, last_used_at: new Date().toISOString() }, { onConflict: "org_id,importer,source_signature" })
  if (error) throw new Error(`Failed to save import mapping profile: ${error.message}`)
}

export async function getImportMappingProfile(importer: ImporterKey, headers: string[], access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const signature = sourceSignature(headers)
  const { data, error } = await context.supabase.from("import_mapping_profiles").select("column_mapping").eq("org_id", context.orgId).eq("importer", importer).eq("source_signature", signature).maybeSingle()
  if (error) throw new Error(`Failed to load import mapping profile: ${error.message}`)
  return data?.column_mapping as Record<string, string | null> | null
}

async function loadValidationLookups(context: ResolvedImportContext) {
  const [costCodes, companies, plans, communities, divisions, roles, lots] = await Promise.all([
    context.supabase.from("cost_codes").select("id,code,parent_id").eq("org_id", context.orgId).limit(10000),
    context.supabase.from("companies").select("id,name").eq("org_id", context.orgId).limit(5000),
    context.supabase.from("house_plans").select("id,code,versions:house_plan_versions(id,status,version_number,schedule_template_id),elevations:house_plan_elevations(id,code)").eq("org_id", context.orgId).limit(1000),
    context.supabase.from("communities").select("id,name,code,division_id").eq("org_id", context.orgId).limit(1000),
    context.supabase.from("divisions").select("id,name,code").eq("org_id", context.orgId).limit(200),
    context.supabase.from("roles").select("id,key").eq("scope", "org").limit(100),
    context.supabase.from("lots").select("id,community_id,lot_number,block,project_id").eq("org_id", context.orgId).limit(10000),
  ])
  for (const result of [costCodes, companies, plans, communities, divisions, roles, lots]) {
    if (result.error) throw new Error(`Failed to preload import validation data: ${result.error.message}`)
  }
  return { costCodes: costCodes.data ?? [], companies: companies.data ?? [], plans: plans.data ?? [], communities: communities.data ?? [], divisions: divisions.data ?? [], roles: roles.data ?? [], lots: lots.data ?? [] }
}

function withIssue(row: ImportRowRecord, issue: ImportIssue) {
  row.issues.push(issue)
}

async function validateRows(importer: ImporterKey, rows: ImportRowRecord[], context: ResolvedImportContext) {
  const lookups = await loadValidationLookups(context)
  const duplicates = new Map<string, number>()
  rows.forEach((row) => duplicates.set(row.natural_key, (duplicates.get(row.natural_key) ?? 0) + 1))
  for (const row of rows) if ((duplicates.get(row.natural_key) ?? 0) > 1) withIssue(row, { level: "error", code: "duplicate_natural_key", message: "Natural key appears more than once in this file" })

  const costCodeByCode = new Map(lookups.costCodes.map((row) => [normalizeKey(row.code), row]))
  const planByCode = new Map(lookups.plans.map((row) => [normalizeKey(row.code), row]))
  const communityByKey = new Map(lookups.communities.flatMap((row) => [[normalizeKey(row.name), row], ...(row.code ? [[normalizeKey(row.code), row] as const] : [])]))
  const divisionByKey = new Map(lookups.divisions.flatMap((row) => [[normalizeKey(row.name), row], ...(row.code ? [[normalizeKey(row.code), row] as const] : [])]))
  const roleByKey = new Map(lookups.roles.map((row) => [normalizeKey(row.key), row]))
  const companyByNormalized = new Map(lookups.companies.map((row) => [normalizeVendorName(row.name), row]))

  for (const row of rows) {
    const parsed = row.parsed
    const costCodeText = typeof parsed.cost_code === "string" ? parsed.cost_code : typeof parsed.code === "string" && importer === "open_wip" ? parsed.code : null
    if (costCodeText) {
      const match = costCodeByCode.get(normalizeKey(costCodeText))
      if (match) parsed.cost_code_id = match.id
      else withIssue(row, { level: "error", code: "unresolved_cost_code", message: `Cost code ${costCodeText} was not found`, column: "cost_code" })
    }
    if (typeof parsed.plan_code === "string" && parsed.plan_code) {
      const plan = planByCode.get(normalizeKey(parsed.plan_code))
      if (!plan && !(importer === "plan_library" && parsed.plan_name)) withIssue(row, { level: "error", code: "unresolved_plan", message: `Plan ${parsed.plan_code} was not found`, column: "plan_code" })
      if (plan) {
        parsed.house_plan_id = plan.id
        const versions = Array.isArray(plan.versions) ? plan.versions : []
        const released = versions.find((version) => version.status === "released") ?? versions.find((version) => version.status === "draft")
        if (released) { parsed.house_plan_version_id = released.id; if (released.schedule_template_id) parsed.schedule_template_id = released.schedule_template_id }
        const elevations = Array.isArray(plan.elevations) ? plan.elevations : []
        if (parsed.elevation_code) {
          const elevation = elevations.find((item) => normalizeKey(item.code) === normalizeKey(parsed.elevation_code))
          if (elevation) parsed.elevation_id = elevation.id
          else if (!(importer === "plan_library" && row.parsed.description == null)) withIssue(row, { level: "error", code: "unresolved_elevation", message: `Elevation ${parsed.elevation_code} was not found`, column: "elevation_code" })
        }
      }
    }
    if (typeof parsed.community === "string" && parsed.community) {
      const community = communityByKey.get(normalizeKey(parsed.community))
      if (community) parsed.community_id = community.id
      else if (importer !== "communities_lots") withIssue(row, { level: "error", code: "unresolved_community", message: `Community ${parsed.community} was not found`, column: "community" })
    }
    if (typeof parsed.division === "string" && parsed.division) {
      const division = divisionByKey.get(normalizeKey(parsed.division))
      if (division) parsed.division_id = division.id
      else withIssue(row, { level: "error", code: "unresolved_division", message: `Division ${parsed.division} was not found`, column: "division" })
    }
    if (typeof parsed.role === "string" && !roleByKey.has(normalizeKey(parsed.role))) withIssue(row, { level: "error", code: "unresolved_role", message: `Role ${parsed.role} was not found`, column: "role" })
    if (typeof parsed.vendor === "string" && parsed.vendor) {
      const exact = companyByNormalized.get(normalizeVendorName(parsed.vendor))
      if (exact) parsed.company_id = exact.id
      else {
        const candidates = lookups.companies.map((company) => ({ company, score: similarity(parsed.vendor as string, company.name) })).sort((a, b) => b.score - a.score)
        if (candidates[0]?.score >= 0.85) {
          parsed.company_id = candidates[0].company.id
          withIssue(row, { level: "warning", code: "vendor_fuzzy_match", message: `Suggested vendor ${candidates[0].company.name}; confirm before commit`, column: "vendor" })
        } else withIssue(row, { level: "warning", code: "vendor_unmatched", message: "Vendor will be created on commit unless matched in the review grid", column: "vendor" })
      }
    }
  }

  if (importer === "cost_codes") {
    const batchCodes = new Set(rows.map((row) => normalizeKey(row.parsed.code)))
    for (const row of rows) {
      const parent = typeof row.parsed.parent_code === "string" ? row.parsed.parent_code : null
      if (parent && !batchCodes.has(normalizeKey(parent)) && !costCodeByCode.has(normalizeKey(parent))) withIssue(row, { level: "error", code: "unresolved_parent", message: `Parent cost code ${parent} was not found`, column: "parent_code" })
    }
    try { topologicalOrder(rows.map((row) => ({ code: String(row.parsed.code ?? ""), parent_code: typeof row.parsed.parent_code === "string" ? row.parsed.parent_code : null }))) } catch (error) { rows.forEach((row) => withIssue(row, { level: "error", code: "parent_cycle", message: error instanceof Error ? error.message : "Cost-code hierarchy contains a cycle" })) }
  }

  for (const row of rows) {
    if (row.status === "skipped") continue
    row.status = row.issues.some((issue) => issue.level === "error") ? "error" : row.issues.some((issue) => issue.level === "warning") ? "warning" : "valid"
  }
  return rows
}

async function persistValidatedRows(context: ResolvedImportContext, batchId: string, rows: ImportRowRecord[]) {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
    const chunk = rows.slice(index, index + INSERT_CHUNK)
    const { error } = await context.supabase.from("import_rows").upsert(chunk.map((row) => ({ id: row.id, org_id: context.orgId, batch_id: batchId, row_number: row.row_number, raw: row.raw, parsed: row.parsed, status: row.status, issues: row.issues, natural_key: row.natural_key })), { onConflict: "batch_id,row_number" })
    if (error) throw new Error(`Failed to stage import rows: ${error.message}`)
  }
}

async function validateOpenWipCompanions(rows: ImportRowRecord[], context: ResolvedImportContext, batchContext: Record<string, unknown>) {
  if (batchContext.file_kind !== "houses") return rows
  const asOfDate = typeof batchContext.as_of_date === "string" ? batchContext.as_of_date : null
  if (!asOfDate) {
    rows.forEach((row) => withIssue(row, { level: "error", code: "missing_as_of_date", message: "Open-WIP houses require an as-of date" }))
    return rows
  }
  const { data: batches, error: batchError } = await context.supabase.from("import_batches").select("id,context").eq("org_id", context.orgId).eq("importer", "open_wip").in("status", ["staged", "committed"])
  if (batchError) throw new Error(`Unable to validate Open-WIP companion files: ${batchError.message}`)
  const budgetBatchIds = (batches ?? []).filter((batch) => batch.context?.file_kind === "budgets" && batch.context?.as_of_date === asOfDate).map((batch) => batch.id)
  if (!budgetBatchIds.length) {
    rows.forEach((row) => withIssue(row, { level: "error", code: "missing_budget_file", message: `Stage the ${asOfDate} budget snapshot before the house file` }))
    return rows
  }
  const { data: budgetRows, error: budgetError } = await context.supabase.from("import_rows").select("natural_key,parsed").eq("org_id", context.orgId).in("batch_id", budgetBatchIds).in("status", ["valid", "warning", "committed"])
  if (budgetError) throw new Error(`Unable to validate Open-WIP budgets: ${budgetError.message}`)
  for (const row of rows) {
    const houseKey = [row.parsed.community, row.parsed.block, row.parsed.lot_number].map(normalizeKey).filter(Boolean).join(":")
    const sum = (budgetRows ?? []).filter((item) => String(item.natural_key).startsWith(`${houseKey}:`)).reduce((total, item) => total + Number(item.parsed?.budget_cents ?? 0), 0)
    if (sum !== Number(row.parsed.budget_total_cents)) withIssue(row, { level: "error", code: "budget_total_mismatch", message: `Budget snapshot totals ${sum} cents; the house row declares ${Number(row.parsed.budget_total_cents)} cents`, column: "budget_total_cents" })
  }
  return rows
}

function rowCounts(rows: ImportRowRecord[]) {
  return {
    row_count: rows.length,
    valid_count: rows.filter((row) => row.status === "valid").length,
    warning_count: rows.filter((row) => row.status === "warning").length,
    error_count: rows.filter((row) => row.status === "error").length,
    skipped_count: rows.filter((row) => row.status === "skipped").length,
  }
}

export async function stageImportBatch(input: { importer: ImporterKey; csvText: string; sourceFilename?: string; mapping?: Record<string, string | null>; context?: Record<string, unknown>; onboardingRunId?: string | null }, access: ImportAccess = {}) {
  if (!IMPORTER_KEYS.includes(input.importer)) throw new Error("Unknown importer")
  if (Buffer.byteLength(input.csvText, "utf8") > MAX_FILE_BYTES) throw new Error("Imports are limited to 10MB")
  const resolved = await resolveImportContext(access)
  await requireImporterPermission(input.importer, resolved)
  const { headers, rows: rawRows } = parseCsv(input.csvText)
  if (rawRows.length === 0) throw new Error("The CSV has no data rows")
  if (rawRows.length > MAX_ROWS) throw new Error("Imports are limited to 10,000 rows per batch")
  let mapping = input.mapping ?? await getImportMappingProfile(input.importer, headers, access) ?? exactColumnMapping(input.importer, headers)
  mapping = Object.fromEntries(IMPORTER_DEFINITIONS[input.importer].columns.map((column) => [column.key, mapping[column.key] ?? null]))
  const contextPayload: Record<string, unknown> = { ...(input.context ?? {}), source_headers: headers }
  const { data: batch, error: batchError } = await resolved.supabase.from("import_batches").insert({ org_id: resolved.orgId, importer: input.importer, status: "parsing", source_filename: input.sourceFilename ?? null, column_mapping: mapping, context: contextPayload, onboarding_run_id: input.onboardingRunId ?? null, created_by: resolved.userId }).select("*").single()
  if (batchError || !batch) throw new Error(`Failed to create import batch: ${batchError?.message}`)
  try {
    let staged: ImportRowRecord[] = rawRows.map((raw, index) => {
      const result = parseImporterRow({ importer: input.importer, raw, mapping, context: contextPayload })
      return { id: crypto.randomUUID(), row_number: index + 1, raw, parsed: result.parsed, status: "pending", issues: result.issues, natural_key: result.naturalKey, target_entity_type: null, target_entity_id: null, action: null }
    })
    staged = await validateRows(input.importer, staged, resolved)
    if (input.importer === "open_wip") staged = await validateOpenWipCompanions(staged, resolved, contextPayload)
    await persistValidatedRows(resolved, batch.id, staged)
    const counts = rowCounts(staged)
    const report = { source_headers: headers, file_kind: contextPayload.file_kind ?? null, duplicate_rows: staged.filter((row) => row.issues.some((issue) => issue.code === "duplicate_natural_key")).length, unmatched_vendors: staged.filter((row) => row.issues.some((issue) => issue.code === "vendor_unmatched")).length }
    const { data: saved, error: saveError } = await resolved.supabase.from("import_batches").update({ ...counts, status: "staged", report }).eq("org_id", resolved.orgId).eq("id", batch.id).select("*").single()
    if (saveError || !saved) throw new Error(`Failed to finalize import batch: ${saveError?.message}`)
    if (input.mapping) await saveMappingProfile(resolved, input.importer, headers, mapping)
    await recordEvent({ orgId: resolved.orgId, actorId: resolved.userId, eventType: "import_batch_staged", entityType: "import_batch", entityId: batch.id, payload: { importer: input.importer, ...counts }, channel: "activity" })
    return mapBatch(saved)
  } catch (error) {
    await resolved.supabase.from("import_batches").update({ status: "failed", report: { error: error instanceof Error ? error.message : "Staging failed" } }).eq("id", batch.id)
    throw error
  }
}

export async function patchImportRow(input: { batchId: string; rowId: string; patch: ImportParsedRow; skip?: boolean }, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: batch } = await context.supabase.from("import_batches").select("*").eq("org_id", context.orgId).eq("id", input.batchId).eq("status", "staged").maybeSingle()
  if (!batch) throw new Error("Only staged batches can be edited")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  const { data: existing } = await context.supabase.from("import_rows").select("*").eq("org_id", context.orgId).eq("batch_id", input.batchId).eq("id", input.rowId).maybeSingle()
  if (!existing) throw new Error("Import row not found")
  const parsed = { ...(existing.parsed ?? {}), ...input.patch }
  const reparsed = parseImporterRow({ importer: batch.importer as ImporterKey, raw: parsed as Record<string, string>, mapping: Object.fromEntries(Object.keys(parsed).map((key) => [key, key])), context: batch.context ?? {} })
  let rows = [mapImportRow({ ...existing, parsed: reparsed.parsed, issues: reparsed.issues, natural_key: reparsed.naturalKey, status: input.skip ? "skipped" : "pending" })]
  rows = input.skip ? rows : await validateRows(batch.importer as ImporterKey, rows, context)
  if (!input.skip && batch.importer === "open_wip") rows = await validateOpenWipCompanions(rows, context, batch.context ?? {})
  await persistValidatedRows(context, input.batchId, rows)
  await refreshBatchCounts(context, input.batchId)
  return rows[0]
}

async function refreshBatchCounts(context: ResolvedImportContext, batchId: string) {
  const { data, error } = await context.supabase.from("import_rows").select("status").eq("org_id", context.orgId).eq("batch_id", batchId)
  if (error) throw new Error(`Failed to recount import batch: ${error.message}`)
  const statuses = data ?? []
  const counts = { row_count: statuses.length, valid_count: statuses.filter((row) => row.status === "valid").length, warning_count: statuses.filter((row) => row.status === "warning").length, error_count: statuses.filter((row) => row.status === "error").length, skipped_count: statuses.filter((row) => row.status === "skipped").length }
  await context.supabase.from("import_batches").update(counts).eq("org_id", context.orgId).eq("id", batchId)
  return counts
}

export async function setImportUpdateExisting(batchId: string, updateExisting: boolean, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: batch } = await context.supabase.from("import_batches").select("importer").eq("org_id", context.orgId).eq("id", batchId).eq("status", "staged").maybeSingle()
  if (!batch) throw new Error("Only staged batches can change update mode")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  const { error } = await context.supabase.from("import_batches").update({ update_existing: updateExisting }).eq("org_id", context.orgId).eq("id", batchId).eq("status", "staged")
  if (error) throw new Error(`Failed to update import mode: ${error.message}`)
}

export async function discardImportBatch(batchId: string, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: batch } = await context.supabase.from("import_batches").select("importer").eq("org_id", context.orgId).eq("id", batchId).in("status", ["parsing", "staged", "failed"]).maybeSingle()
  if (!batch) throw new Error("Import batch cannot be discarded")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  const { data, error } = await context.supabase.from("import_batches").update({ status: "discarded" }).eq("org_id", context.orgId).eq("id", batchId).in("status", ["parsing", "staged", "failed"]).select("importer").maybeSingle()
  if (error || !data) throw new Error("Import batch cannot be discarded")
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "import_batch_discarded", entityType: "import_batch", entityId: batchId, payload: { importer: data.importer } })
}

async function ensureCompany(context: ResolvedImportContext, row: ImportRowRecord) {
  if (typeof row.parsed.company_id === "string") return row.parsed.company_id
  const name = String(row.parsed.vendor ?? "").trim()
  if (!name) throw new Error("Vendor is required")
  const { data: existing } = await context.supabase.from("companies").select("id,name").eq("org_id", context.orgId).ilike("name", name).limit(1).maybeSingle()
  if (existing) return existing.id
  const { data, error } = await context.supabase.from("companies").insert({ org_id: context.orgId, name, company_type: "subcontractor", metadata: { created_by_import_batch: true } }).select("id").single()
  if (error || !data) throw new Error(`Failed to create vendor ${name}: ${error?.message}`)
  return data.id
}

async function commitCostCodes(rows: ImportRowRecord[], context: ResolvedImportContext, updateExisting: boolean) {
  const ordered = topologicalOrder(rows.map((row) => ({ row, code: String(row.parsed.code ?? ""), parent_code: typeof row.parsed.parent_code === "string" ? row.parsed.parent_code : null })))
  const { data: existingRows } = await context.supabase.from("cost_codes").select("*").eq("org_id", context.orgId)
  const byCode = new Map((existingRows ?? []).map((row) => [normalizeKey(row.code), row]))
  const results = new Map<string, { id: string; action: string }>()
  for (const item of ordered) {
    const row = item.row
    const existing = byCode.get(normalizeKey(item.code))
    const parent = item.parent_code ? byCode.get(normalizeKey(item.parent_code)) : null
    if (existing && !updateExisting) { results.set(row.id, { id: existing.id, action: "skipped_existing" }); continue }
    const payload = { org_id: context.orgId, code: item.code, name: row.parsed.name, parent_id: parent?.id ?? null, division: row.parsed.division, category: row.parsed.category, cost_type: row.parsed.cost_type, unit: row.parsed.unit, default_unit_cost_cents: row.parsed.default_unit_cost_cents, standard: "custom", is_active: true }
    const query = existing ? context.supabase.from("cost_codes").update(payload).eq("org_id", context.orgId).eq("id", existing.id) : context.supabase.from("cost_codes").insert(payload)
    const { data, error } = await query.select("id,code").single()
    if (error || !data) throw new Error(`Failed to commit cost code ${item.code}: ${error?.message}`)
    byCode.set(normalizeKey(item.code), { ...payload, id: data.id })
    results.set(row.id, { id: data.id, action: existing ? "updated" : "created" })
  }
  return results
}

async function commitPlans(rows: ImportRowRecord[], context: ResolvedImportContext, updateExisting: boolean, fileKind: string) {
  const results = new Map<string, { id: string; action: string }>()
  const { data: plans } = await context.supabase.from("house_plans").select("id,code,versions:house_plan_versions(id,status,version_number),elevations:house_plan_elevations(id,code)").eq("org_id", context.orgId)
  const byCode = new Map((plans ?? []).map((plan) => [normalizeKey(plan.code), plan]))
  if (fileKind === "takeoffs") {
    const { data: costCodes } = await context.supabase.from("cost_codes").select("id,code,cost_type").eq("org_id", context.orgId)
    const costs = new Map((costCodes ?? []).map((row) => [normalizeKey(row.code), row]))
    for (const row of rows) {
      const plan = byCode.get(normalizeKey(row.parsed.plan_code))
      const version = Array.isArray(plan?.versions) ? plan.versions.find((item) => item.status === "draft") : null
      if (!plan || !version) throw new Error(`Plan ${row.parsed.plan_code} does not have a draft version`)
      const elevation = row.parsed.elevation_code && Array.isArray(plan.elevations) ? plan.elevations.find((item) => normalizeKey(item.code) === normalizeKey(row.parsed.elevation_code)) : null
      const costCode = costs.get(normalizeKey(row.parsed.cost_code))
      const { data: existing } = await context.supabase.from("house_plan_takeoff_lines").select("id").eq("org_id", context.orgId).eq("house_plan_version_id", version.id).eq("cost_code_id", costCode?.id).eq("description", row.parsed.description).is("elevation_id", elevation?.id ?? null).maybeSingle()
      if (existing && !updateExisting) { results.set(row.id, { id: existing.id, action: "skipped_existing" }); continue }
      const payload = { org_id: context.orgId, house_plan_version_id: version.id, elevation_id: elevation?.id ?? null, cost_code_id: costCode?.id, cost_type: costCode?.cost_type ?? null, description: row.parsed.description, quantity: row.parsed.quantity, uom: row.parsed.uom, unit_cost_cents: row.parsed.unit_cost_cents, metadata: { imported: true } }
      const query = existing ? context.supabase.from("house_plan_takeoff_lines").update(payload).eq("id", existing.id) : context.supabase.from("house_plan_takeoff_lines").insert(payload)
      const { data, error } = await query.select("id").single()
      if (error || !data) throw new Error(`Failed to import takeoff line: ${error?.message}`)
      results.set(row.id, { id: data.id, action: existing ? "updated" : "created" })
    }
    return results
  }
  for (const row of rows) {
    const code = String(row.parsed.plan_code)
    let plan = byCode.get(normalizeKey(code))
    if (!plan) {
      const { data, error } = await context.supabase.from("house_plans").insert({ org_id: context.orgId, code, name: row.parsed.plan_name, series: row.parsed.series, status: "draft", heated_sqft: row.parsed.heated_sqft, total_sqft: row.parsed.total_sqft, beds: row.parsed.beds, baths: row.parsed.baths, stories: row.parsed.stories, garage_bays: row.parsed.garage_bays, created_by: context.userId, metadata: { imported: true } }).select("id,code").single()
      if (error || !data) throw new Error(`Failed to create plan ${code}: ${error?.message}`)
      const { data: version, error: versionError } = await context.supabase.from("house_plan_versions").insert({ org_id: context.orgId, house_plan_id: data.id, version_number: 1, status: "draft", created_by: context.userId }).select("id,status,version_number").single()
      if (versionError || !version) throw new Error(`Failed to create plan version: ${versionError?.message}`)
      plan = { ...data, versions: [version], elevations: [] }
      byCode.set(normalizeKey(code), plan)
    } else if (updateExisting) {
      await context.supabase.from("house_plans").update({ name: row.parsed.plan_name, series: row.parsed.series, heated_sqft: row.parsed.heated_sqft, total_sqft: row.parsed.total_sqft, beds: row.parsed.beds, baths: row.parsed.baths, stories: row.parsed.stories, garage_bays: row.parsed.garage_bays }).eq("org_id", context.orgId).eq("id", plan.id)
    }
    const elevationCode = String(row.parsed.elevation_code)
    const elevations = Array.isArray(plan.elevations) ? plan.elevations : []
    let elevation = elevations.find((item) => normalizeKey(item.code) === normalizeKey(elevationCode))
    if (!elevation) {
      const { data, error } = await context.supabase.from("house_plan_elevations").insert({ org_id: context.orgId, house_plan_id: plan.id, code: elevationCode, name: row.parsed.elevation_name, swing_applicable: row.parsed.swing_applicable ?? true, heated_sqft_delta: row.parsed.elevation_sqft_delta ?? 0, metadata: { imported: true } }).select("id,code").single()
      if (error || !data) throw new Error(`Failed to create elevation ${elevationCode}: ${error?.message}`)
      elevation = data; elevations.push(data); plan.elevations = elevations
      results.set(row.id, { id: data.id, action: "created" })
    } else results.set(row.id, { id: elevation.id, action: updateExisting ? "updated" : "skipped_existing" })
  }
  return results
}

async function commitOptions(rows: ImportRowRecord[], context: ResolvedImportContext, updateExisting: boolean) {
  const results = new Map<string, { id: string; action: string }>()
  const { data: categories } = await context.supabase.from("selection_categories").select("id,name,parent_category_id").eq("org_id", context.orgId).is("community_id", null)
  const categoryByName = new Map((categories ?? []).map((row) => [normalizeKey(row.name), row]))
  const { data: options } = await context.supabase.from("selection_options").select("id,sku").eq("org_id", context.orgId).is("community_id", null)
  const optionBySku = new Map((options ?? []).map((row) => [normalizeKey(row.sku), row]))
  for (const row of rows) {
    const categoryName = String(row.parsed.category)
    let category = categoryByName.get(normalizeKey(categoryName))
    if (!category) {
      const { data, error } = await context.supabase.from("selection_categories").insert({ org_id: context.orgId, name: categoryName, community_id: null, is_template: false }).select("id,name,parent_category_id").single()
      if (error || !data) throw new Error(`Failed to create selection category: ${error?.message}`)
      category = data; categoryByName.set(normalizeKey(categoryName), data)
    }
    const sku = String(row.parsed.option_code)
    const existing = optionBySku.get(normalizeKey(sku))
    if (existing && !updateExisting) { results.set(row.id, { id: existing.id, action: "skipped_existing" }); continue }
    const payload = { org_id: context.orgId, category_id: category.id, name: row.parsed.option_name, sku, option_scope: row.parsed.scope, price_cents: row.parsed.price_cents, price_delta_cents: row.parsed.price_cents, cost_cents: row.parsed.cost_cents, cost_code_id: row.parsed.cost_code_id, vendor: row.parsed.vendor, lead_time_days: row.parsed.lead_time_days, is_default: row.parsed.is_default ?? false, is_available: true, community_id: null }
    const query = existing ? context.supabase.from("selection_options").update(payload).eq("org_id", context.orgId).eq("id", existing.id) : context.supabase.from("selection_options").insert(payload)
    const { data, error } = await query.select("id").single()
    if (error || !data) throw new Error(`Failed to commit option ${sku}: ${error?.message}`)
    const planCodes = typeof row.parsed.applicable_plans === "string" ? row.parsed.applicable_plans.split(";").map((value) => value.trim()).filter(Boolean) : []
    if (planCodes.length > 0) {
      const { data: plans } = await context.supabase.from("house_plans").select("code,versions:house_plan_versions(id,status)").eq("org_id", context.orgId).in("code", planCodes)
      const prices = (plans ?? []).flatMap((plan) => (Array.isArray(plan.versions) ? plan.versions : []).filter((version) => version.status === "released").map((version) => ({ org_id: context.orgId, option_id: data.id, house_plan_version_id: version.id, community_id: null, price_cents: row.parsed.price_cents, cost_cents: row.parsed.cost_cents, is_available: true })))
      if (prices.length) await context.supabase.from("selection_catalog_prices").upsert(prices, { onConflict: "option_id,house_plan_version_id,community_id" })
    }
    results.set(row.id, { id: data.id, action: existing ? "updated" : "created" })
  }
  return results
}

async function commitPriceBook(rows: ImportRowRecord[], context: ResolvedImportContext) {
  const results = new Map<string, { id: string; action: string }>()
  for (const row of rows) {
    const companyId = await ensureCompany(context, row)
    let query = context.supabase.from("vendor_price_agreements").select("id").eq("org_id", context.orgId).eq("company_id", companyId).eq("cost_code_id", row.parsed.cost_code_id).eq("effective_from", row.parsed.effective_start ?? new Date().toISOString().slice(0, 10))
    query = row.parsed.community_id ? query.eq("community_id", row.parsed.community_id) : query.is("community_id", null)
    query = row.parsed.division_id ? query.eq("division_id", row.parsed.division_id) : query.is("division_id", null)
    query = row.parsed.house_plan_id ? query.eq("house_plan_id", row.parsed.house_plan_id) : query.is("house_plan_id", null)
    const { data: existing } = await query.maybeSingle()
    if (existing) { results.set(row.id, { id: existing.id, action: "skipped_existing" }); continue }
    const { data, error } = await context.supabase.from("vendor_price_agreements").insert({ org_id: context.orgId, company_id: companyId, cost_code_id: row.parsed.cost_code_id, division_id: row.parsed.division_id, community_id: row.parsed.community_id, house_plan_id: row.parsed.house_plan_id, house_plan_version_id: row.parsed.house_plan_version_id, pricing_kind: "unit", uom: row.parsed.uom, unit_cost_cents: row.parsed.unit_price_cents, scope_of_work: row.parsed.description, effective_from: row.parsed.effective_start ?? new Date().toISOString().slice(0, 10), effective_to: row.parsed.effective_end, status: "active", source: "import", metadata: { imported: true }, created_by: context.userId }).select("id").single()
    if (error || !data) throw new Error(`Failed to import price agreement: ${error?.message}`)
    results.set(row.id, { id: data.id, action: "created" })
  }
  return results
}

async function commitCommunitiesLots(rows: ImportRowRecord[], context: ResolvedImportContext, updateExisting: boolean) {
  const results = new Map<string, { id: string; action: string }>()
  const { data: existingCommunities } = await context.supabase.from("communities").select("id,name,code,division_id").eq("org_id", context.orgId)
  const communities = new Map((existingCommunities ?? []).map((row) => [normalizeKey(row.name), row]))
  const phaseCache = new Map<string, { id: string }>()
  const takedownCache = new Map<string, { id: string }>()
  for (const row of rows) {
    const communityName = String(row.parsed.community)
    let community = communities.get(normalizeKey(communityName))
    if (!community) {
      const { data, error } = await context.supabase.from("communities").insert({ org_id: context.orgId, name: communityName, code: row.parsed.community_code, division_id: row.parsed.division_id, city: row.parsed.city, state: row.parsed.state, postal_code: row.parsed.postal_code, status: "active", metadata: { imported: true } }).select("id,name,code,division_id").single()
      if (error || !data) throw new Error(`Failed to create community ${communityName}: ${error?.message}`)
      community = data; communities.set(normalizeKey(communityName), data)
    }
    let phaseId: string | null = null
    if (row.parsed.phase) {
      const phaseKey = `${community.id}:${normalizeKey(row.parsed.phase)}`
      let phase = phaseCache.get(phaseKey)
      if (!phase) {
        const { data: existing } = await context.supabase.from("community_phases").select("id").eq("org_id", context.orgId).eq("community_id", community.id).ilike("name", String(row.parsed.phase)).maybeSingle()
        if (existing) phase = existing
        else {
          const trailing = /(\d+)\s*$/.exec(String(row.parsed.phase))
          const { data, error } = await context.supabase.from("community_phases").insert({ org_id: context.orgId, community_id: community.id, name: row.parsed.phase, phase_number: trailing ? Number(trailing[1]) : phaseCache.size + 1, status: "open", metadata: { imported: true } }).select("id").single()
          if (error || !data) throw new Error(`Failed to create phase: ${error?.message}`)
          phase = data
        }
        phaseCache.set(phaseKey, phase)
      }
      phaseId = phase.id
    }
    let takedownId: string | null = null
    if (row.parsed.takedown) {
      const key = `${community.id}:${normalizeKey(row.parsed.takedown)}`
      let takedown = takedownCache.get(key)
      if (!takedown) {
        const { data: existing } = await context.supabase.from("lot_takedowns").select("id").eq("org_id", context.orgId).eq("community_id", community.id).ilike("name", String(row.parsed.takedown)).maybeSingle()
        if (existing) takedown = existing
        else {
          const { data, error } = await context.supabase.from("lot_takedowns").insert({ org_id: context.orgId, community_id: community.id, community_phase_id: phaseId, name: row.parsed.takedown, scheduled_date: row.parsed.takedown_date, metadata: { imported: true } }).select("id").single()
          if (error || !data) throw new Error(`Failed to create takedown: ${error?.message}`)
          takedown = data
        }
        takedownCache.set(key, takedown)
      }
      takedownId = takedown.id
    }
    let lotQuery = context.supabase.from("lots").select("id").eq("org_id", context.orgId).eq("community_id", community.id).eq("lot_number", row.parsed.lot_number)
    lotQuery = row.parsed.block ? lotQuery.eq("block", row.parsed.block) : lotQuery.is("block", null)
    const { data: existingLot } = await lotQuery.maybeSingle()
    if (existingLot && !updateExisting) { results.set(row.id, { id: existingLot.id, action: "skipped_existing" }); continue }
    const payload = { org_id: context.orgId, community_id: community.id, community_phase_id: phaseId, division_id: community.division_id, lot_number: row.parsed.lot_number, block: row.parsed.block, status: row.parsed.status, address: row.parsed.address, dimensions: { width_ft: row.parsed.width_ft, depth_ft: row.parsed.depth_ft, acreage: row.parsed.acreage, city: row.parsed.city, state: row.parsed.state, postal_code: row.parsed.postal_code }, swing: row.parsed.swing ?? "either", premium_cents: row.parsed.premium_cents ?? 0, cost_basis_cents: row.parsed.cost_basis_cents, takedown_id: takedownId, house_plan_id: row.parsed.house_plan_id, house_plan_version_id: row.parsed.house_plan_version_id, house_plan_elevation_id: row.parsed.elevation_id, metadata: { imported: true } }
    const query = existingLot ? context.supabase.from("lots").update(payload).eq("org_id", context.orgId).eq("id", existingLot.id) : context.supabase.from("lots").insert(payload)
    const { data, error } = await query.select("id").single()
    if (error || !data) throw new Error(`Failed to commit lot ${row.parsed.lot_number}: ${error?.message}`)
    results.set(row.id, { id: data.id, action: existingLot ? "updated" : "created" })
  }
  return results
}

async function commitTeam(rows: ImportRowRecord[], context: ResolvedImportContext) {
  const results = new Map<string, { id: string; action: string }>()
  const { data: existing } = await context.supabase.from("memberships").select("id,user:app_users(email)").eq("org_id", context.orgId)
  const byEmail = new Map((existing ?? []).map((row) => {
    const user = Array.isArray(row.user) ? row.user[0] : row.user
    return [normalizeKey(user?.email), row]
  }))
  for (const row of rows) {
    const email = String(row.parsed.email).toLowerCase()
    const member = byEmail.get(email)
    if (member) { results.set(row.id, { id: member.id, action: "skipped_existing" }); continue }
    const created = await createOrgMemberInvite({ supabase: context.supabase, orgId: context.orgId, actorUserId: context.userId, email, fullName: String(row.parsed.full_name), role: row.parsed.role as Parameters<typeof createOrgMemberInvite>[0]["role"], sendEmail: false })
    if (row.parsed.division_id) {
      await context.supabase.from("memberships").update({ division_scope: "assigned" }).eq("org_id", context.orgId).eq("id", created.id)
      await context.supabase.from("membership_divisions").upsert({ org_id: context.orgId, membership_id: created.id, division_id: row.parsed.division_id }, { onConflict: "membership_id,division_id" })
    }
    results.set(row.id, { id: created.id, action: "created" })
  }
  return results
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10)
}

async function commitOpenWip(rows: ImportRowRecord[], context: ResolvedImportContext, batchId: string, batchContext: Record<string, unknown>, fileKind: string) {
  const results = new Map<string, { id: string; action: string }>()
  if (fileKind !== "houses") {
    rows.forEach((row) => results.set(row.id, { id: row.id, action: "created" }))
    return results
  }
  const asOfDate = typeof batchContext.as_of_date === "string" ? batchContext.as_of_date : null
  if (!asOfDate) throw new Error("Open-WIP house imports require an as-of date")
  const { data: siblingBatches } = await context.supabase.from("import_batches").select("id,context").eq("org_id", context.orgId).eq("importer", "open_wip").in("status", ["staged", "committed"]).neq("id", batchId)
  const budgetBatchIds = (siblingBatches ?? []).filter((batch) => batch.context?.file_kind === "budgets" && batch.context?.as_of_date === asOfDate).map((batch) => batch.id)
  const poBatchIds = (siblingBatches ?? []).filter((batch) => batch.context?.file_kind === "purchase_orders" && batch.context?.as_of_date === asOfDate).map((batch) => batch.id)
  const [budgetResult, poResult] = await Promise.all([
    budgetBatchIds.length ? context.supabase.from("import_rows").select("parsed,natural_key").eq("org_id", context.orgId).in("batch_id", budgetBatchIds).in("status", ["valid", "warning", "committed"]) : Promise.resolve({ data: [], error: null }),
    poBatchIds.length ? context.supabase.from("import_rows").select("parsed,natural_key").eq("org_id", context.orgId).in("batch_id", poBatchIds).in("status", ["valid", "warning", "committed"]) : Promise.resolve({ data: [], error: null }),
  ])
  if (budgetResult.error || poResult.error) throw new Error("Unable to load Open-WIP companion files")
  for (const row of rows) {
    const houseKey = [row.parsed.community, row.parsed.block, row.parsed.lot_number].map(normalizeKey).filter(Boolean).join(":")
    const budgetRows = (budgetResult.data ?? []).filter((item) => String(item.natural_key).startsWith(`${houseKey}:`))
    const poRows = (poResult.data ?? []).filter((item) => String(item.natural_key).startsWith(`${houseKey}:`))
    const budgetSum = budgetRows.reduce((sum, item) => sum + Number(item.parsed?.budget_cents ?? 0), 0)
    if (budgetSum !== Number(row.parsed.budget_total_cents)) throw new Error(`Lot ${row.parsed.lot_number}: budget lines total does not match the house total`)
    const { data: community, error: communityError } = await context.supabase.from("communities").select("id,name,division_id").eq("org_id", context.orgId).eq("id", row.parsed.community_id).single()
    let lotQuery = context.supabase.from("lots").select("id,project_id").eq("org_id", context.orgId).eq("community_id", row.parsed.community_id).eq("lot_number", row.parsed.lot_number)
    lotQuery = row.parsed.block ? lotQuery.eq("block", row.parsed.block) : lotQuery.is("block", null)
    const { data: lot, error: lotError } = await lotQuery.single()
    if (communityError || !community) throw new Error(`Unable to resolve the Open-WIP community: ${communityError?.message}`)
    if (lotError || !lot) throw new Error(`Unable to resolve the Open-WIP lot: ${lotError?.message}`)
    if (lot.project_id) { results.set(row.id, { id: lot.project_id, action: "skipped_existing" }); continue }
    let projectId: string | null = null
    try {
      const { data: project, error: projectError } = await context.supabase.from("projects").insert({ org_id: context.orgId, name: `${community.name} — Lot ${row.parsed.lot_number}`, status: "active", property_type: "production", division_id: community.division_id, created_by: context.userId, metadata: { wip_cutover: { as_of_date: asOfDate, batch_id: batchId }, imported_open_wip: true } }).select("id").single()
      if (projectError || !project) throw new Error(`Failed to create project: ${projectError?.message}`)
      projectId = project.id
      await context.supabase.from("lots").update({ project_id: projectId, status: "started", house_plan_id: row.parsed.house_plan_id, house_plan_version_id: row.parsed.house_plan_version_id, house_plan_elevation_id: row.parsed.elevation_id }).eq("org_id", context.orgId).eq("id", lot.id)
      const { data: budget, error: budgetError } = await context.supabase.from("budgets").insert({ org_id: context.orgId, project_id: projectId, version: 1, status: "approved", total_cents: budgetSum, metadata: { imported_open_wip: true, as_of_date: asOfDate } }).select("id").single()
      if (budgetError || !budget) throw new Error(`Failed to create WIP budget: ${budgetError?.message}`)
      if (budgetRows.length) {
        const { error } = await context.supabase.from("budget_lines").insert(budgetRows.map((item, index) => ({ org_id: context.orgId, budget_id: budget.id, cost_code_id: item.parsed?.cost_code_id, description: `Imported ${item.parsed?.cost_code}`, amount_cents: item.parsed?.budget_cents, sort_order: index, metadata: { imported_open_wip: true } })))
        if (error) throw new Error(`Failed to create WIP budget lines: ${error.message}`)
      }
      for (const item of poRows) {
        const companyId = await ensureCompany(context, { ...row, parsed: item.parsed as ImportParsedRow })
        const { data: commitment, error } = await context.supabase.from("commitments").insert({ org_id: context.orgId, project_id: projectId, company_id: companyId, commitment_type: "purchase_order", title: item.parsed?.description ?? `Imported PO ${item.parsed?.po_number}`, status: "approved", total_cents: item.parsed?.remaining_cents, currency: "usd", contract_number: item.parsed?.po_number, metadata: { imported_open_wip: true, original_cents: item.parsed?.original_cents, as_of_date: asOfDate } }).select("id").single()
        if (error || !commitment) throw new Error(`Failed to create imported PO: ${error?.message}`)
        await context.supabase.from("commitment_lines").insert({ org_id: context.orgId, commitment_id: commitment.id, cost_code_id: item.parsed?.cost_code_id, description: item.parsed?.description, quantity: 1, unit: "remaining", unit_cost_cents: item.parsed?.remaining_cents, metadata: { imported_open_wip: true } })
      }
      if (row.parsed.schedule_template_id) {
        const { data: template } = await context.supabase.from("schedule_templates").select("items").eq("org_id", context.orgId).eq("id", row.parsed.schedule_template_id).maybeSingle()
        const items = Array.isArray(template?.items) ? template.items : []
        const anchorIndex = items.findIndex((item) => normalizeKey(item.name) === normalizeKey(row.parsed.stage_task))
        if (anchorIndex < 0) throw new Error(`Schedule task ${row.parsed.stage_task} was not found in the plan template`)
        const stageDate = typeof row.parsed.stage_date === "string" ? row.parsed.stage_date : asOfDate
        await context.supabase.from("schedule_items").insert(items.map((item, index) => ({ org_id: context.orgId, project_id: projectId, name: item.name, item_type: item.item_type ?? "task", status: index < anchorIndex ? "completed" : index === anchorIndex ? "in_progress" : "planned", start_date: addDays(stageDate, Number(item.offset_days ?? index - anchorIndex)), end_date: addDays(stageDate, Number(item.offset_days ?? index - anchorIndex) + Math.max(0, Number(item.duration_days ?? 1) - 1)), progress: index < anchorIndex ? 100 : index === anchorIndex ? 10 : 0, sort_order: index, metadata: { imported_open_wip: true, completed_at_cutover: index < anchorIndex ? asOfDate : null } })))
      }
      if (row.parsed.sold) {
        let contactId: string | null = null
        if (row.parsed.buyer_email) {
          const { data: existingContact } = await context.supabase.from("contacts").select("id").eq("org_id", context.orgId).ilike("email", String(row.parsed.buyer_email)).limit(1).maybeSingle()
          if (existingContact) contactId = existingContact.id
          else {
            const { data: contact } = await context.supabase.from("contacts").insert({ org_id: context.orgId, full_name: row.parsed.buyer_name, email: row.parsed.buyer_email, contact_type: "client", metadata: { imported_open_wip: true } }).select("id").single()
            contactId = contact?.id ?? null
          }
        }
        if (contactId) await context.supabase.from("projects").update({ client_id: contactId }).eq("org_id", context.orgId).eq("id", projectId)
        await context.supabase.from("contracts").insert({ org_id: context.orgId, project_id: projectId, number: `WIP-${String(row.parsed.community).slice(0, 3).toUpperCase()}-${row.parsed.lot_number}`, title: `Imported purchase agreement — Lot ${row.parsed.lot_number}`, status: "executed", contract_type: "purchase_agreement", total_cents: row.parsed.sale_price_cents, currency: "usd", effective_date: row.parsed.sale_date ?? asOfDate, snapshot: { imported_open_wip: true, as_of_date: asOfDate, agreement_total_only: true } })
      }
      results.set(row.id, { id: project.id, action: "created" })
    } catch (error) {
      if (projectId) await context.supabase.from("projects").delete().eq("org_id", context.orgId).eq("id", projectId)
      throw error
    }
  }
  return results
}

export async function commitImportBatch(batchId: string, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: claimed, error: claimError } = await context.supabase.from("import_batches").update({ status: "committing" }).eq("org_id", context.orgId).eq("id", batchId).eq("status", "staged").eq("error_count", 0).select("*").maybeSingle()
  if (claimError || !claimed) throw new Error("Batch must be staged with all errors fixed or explicitly skipped")
  const importer = claimed.importer as ImporterKey
  await requireImporterPermission(importer, context)
  const { data, error } = await context.supabase.from("import_rows").select("*").eq("org_id", context.orgId).eq("batch_id", batchId).in("status", ["valid", "warning"]).order("row_number")
  if (error) throw new Error(`Failed to load import rows: ${error.message}`)
  const rows = (data ?? []).map(mapImportRow)
  try {
    const fileKind = typeof claimed.context?.file_kind === "string" ? claimed.context.file_kind : ""
    let results: Map<string, { id: string; action: string }>
    if (importer === "cost_codes") results = await commitCostCodes(rows, context, claimed.update_existing)
    else if (importer === "plan_library") results = await commitPlans(rows, context, claimed.update_existing, fileKind)
    else if (importer === "option_catalog") results = await commitOptions(rows, context, claimed.update_existing)
    else if (importer === "price_book") results = await commitPriceBook(rows, context)
    else if (importer === "communities_lots") results = await commitCommunitiesLots(rows, context, claimed.update_existing)
    else if (importer === "team") results = await commitTeam(rows, context)
    else results = await commitOpenWip(rows, context, batchId, claimed.context ?? {}, fileKind)
    for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
      const chunk = rows.slice(index, index + INSERT_CHUNK)
      await Promise.all(chunk.map((row) => {
        const result = results.get(row.id)
        return context.supabase.from("import_rows").update({ status: result?.action === "skipped_existing" ? "skipped" : "committed", target_entity_type: importer, target_entity_id: result?.id ?? null, action: result?.action ?? "skipped_error" }).eq("org_id", context.orgId).eq("id", row.id)
      }))
    }
    const actions = [...results.values()].reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.action]: (counts[result.action] ?? 0) + 1 }), {})
    const committedCount = (actions.created ?? 0) + (actions.updated ?? 0)
    const skippedCount = (actions.skipped_existing ?? 0) + Number(claimed.skipped_count ?? 0)
    const committedAt = new Date().toISOString()
    const { data: saved, error: saveError } = await context.supabase.from("import_batches").update({ status: "committed", committed_count: committedCount, skipped_count: skippedCount, committed_at: committedAt, report: { ...(claimed.report ?? {}), actions } }).eq("org_id", context.orgId).eq("id", batchId).select("*").single()
    if (saveError || !saved) throw new Error(`Failed to finalize committed batch: ${saveError?.message}`)
    await Promise.all([
      recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "import_batch_committed", entityType: "import_batch", entityId: batchId, payload: { importer, committed_count: committedCount, skipped_count: skippedCount, actions } }),
      recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "import_batch", entityId: batchId, after: { importer, status: "committed", actions } }),
    ])
    return mapBatch(saved)
  } catch (error) {
    await context.supabase.from("import_batches").update({ status: "failed", report: { ...(claimed.report ?? {}), commit_error: error instanceof Error ? error.message : "Commit failed" } }).eq("org_id", context.orgId).eq("id", batchId)
    throw error
  }
}
