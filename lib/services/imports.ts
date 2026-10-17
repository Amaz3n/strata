import "server-only"

import { z } from "zod"
import { storeLotDimensions } from "@/lib/land/lot-dimensions"
import { readAllRows, readAllRowsById } from "@/lib/land/paging"
import { importRowStatusSchema } from "@/lib/validation/import-navigation"

import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeProductTier, type ProductTier } from "@/lib/product-tier"
import type { LotSwing } from "@/lib/land/lot-fit"
import { isPlanOffered, offeringOverrideFor, PLAN_OFFERING_REFUSAL, type PlanOfferingRow } from "@/lib/sales/plan-offering"
import { checkLotFits, type LotFitPin } from "@/lib/services/lot-fit"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { requireOrgContext } from "@/lib/services/context"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { hasPermission, requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { agreementWriteAllowed } from "@/lib/services/price-book"
import { commitInstalledHomes, reconcileInstalledWarrantyHomes, validateInstalledHomeRows } from "@/lib/services/warranty-installed-base"
import { commitCutoverRows, isCutoverImporter, NARROW_IMPORTER_PERMISSIONS, validateCutoverRows } from "@/lib/services/cutover/importers"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminId } from "@/lib/auth/platform"
import { mapWithConcurrency } from "@/lib/payments/concurrency"
import { recordAudit } from "@/lib/services/audit"
import { enforceMutationRateLimit } from "@/lib/services/auth-rate-limit"
import { recordEvent } from "@/lib/services/events"
import { completeOutboxJob } from "@/lib/services/outbox"
import { createOrgMemberInvite, inviteRefusal } from "@/lib/services/team"
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
/** Row-result writes in flight at once; 500 simultaneous requests exhaust the connection pool. */
const IMPORT_ROW_WRITE_CONCURRENCY = 10

export interface ImportAccess {
  orgId?: string
  platformOrgId?: string
  expectedImporter?: ImporterKey
}

interface ResolvedImportContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
  productTier: ProductTier
  platform: boolean
  expectedImporter?: ImporterKey
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

async function resolveImportContext(access: ImportAccess = {}, intent: "read" | "write" = "write"): Promise<ResolvedImportContext> {
  if (access.platformOrgId) {
    const user = await requireAnyPlatformPermission([
      intent === "read" ? "platform.support.read" : "platform.support.write",
    ])
    const supabase = createServiceSupabaseClient()
    const { data: org, error } = await supabase.from("orgs").select("id, product_tier").eq("id", access.platformOrgId).maybeSingle()
    if (error || !org) throw new Error("Organization not found")
    return { supabase, orgId: org.id, userId: user.id, productTier: normalizeProductTier(org.product_tier), platform: true, expectedImporter: access.expectedImporter }
  }

  const context = await requireOrgContext(access.orgId)
  // Warranty, closing, design and field owners run their own records' import without the broad import.manage grant.
  await requirePermission((access.expectedImporter && NARROW_IMPORTER_PERMISSIONS[access.expectedImporter]) || "import.manage", context)
  return { ...context, supabase: createServiceSupabaseClient(), platform: false, expectedImporter: access.expectedImporter }
}

async function requireImporterPermission(importer: ImporterKey, context: ResolvedImportContext) {
  if (context.expectedImporter && importer !== context.expectedImporter) {
    throw new Error("Import batch does not belong to this importer")
  }
  // Platform onboarding runs every importer on the customer's behalf, whatever tier they're on.
  if (context.platform) return
  if (importer === "open_wip") throw new Error("Open-WIP cutover is restricted to the platform onboarding workbench")
  if (importer === "price_book") await requirePermission("price_book.write", context)
  if (importer === "plan_library") await requirePermission("plan.write", context)
  if (importer === "option_catalog") await requirePermission("selections.catalog.manage", context)
  if (importer === "communities_lots") await requireAnyPermission(["community.write", "lot.write"], context)
  if (importer === "team") await requirePermission("members.manage", context)
  const narrow = NARROW_IMPORTER_PERMISSIONS[importer]
  if (narrow) await requirePermission(narrow, context)
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
  const context = await resolveImportContext(access, "read")
  if (input.importer) await requireImporterPermission(input.importer, context)
  const limit = Math.min(z.number().int().positive().parse(input.limit ?? 25), 100)
  const page = z.number().int().min(1).max(100_000).parse(input.page ?? 1)
  let query = context.supabase.from("import_batches").select("*", { count: "exact" }).eq("org_id", context.orgId).order("created_at", { ascending: false }).order("id", { ascending: false }).range((page - 1) * limit, page * limit - 1)
  if (input.importer) query = query.eq("importer", input.importer)
  const { data, error, count } = await query
  if (error) throw new Error(`Failed to list import batches: ${error.message}`)
  if (!data || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Import batch history is unavailable")
  if (data.length !== Math.min(limit, Math.max(0, count - (page - 1) * limit))) throw new Error("Import batch page is incomplete; reload before reviewing history")
  return { batches: data.map(mapBatch), total: count, page, limit }
}

export async function getImportBatch(batchId: string, input: { page?: number; limit?: number; status?: string } = {}, access: ImportAccess = {}) {
  const context = await resolveImportContext(access, "read")
  const { data: batch, error: batchError } = await context.supabase.from("import_batches").select("*").eq("org_id", context.orgId).eq("id", batchId).maybeSingle()
  if (batchError || !batch) throw new Error("Import batch not found")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  const limit = Math.min(z.number().int().positive().parse(input.limit ?? 200), 500)
  const page = z.number().int().min(1).max(100_000).parse(input.page ?? 1)
  const status = importRowStatusSchema.parse(input.status ?? "all")
  let query = context.supabase.from("import_rows").select("*", { count: "exact" }).eq("org_id", context.orgId).eq("batch_id", batchId).order("row_number").order("id").range((page - 1) * limit, page * limit - 1)
  if (status !== "all") query = query.eq("status", status)
  // A running cutover's progress is its receipts: one per home built, counted exactly while it runs.
  const [{ data: rows, error: rowsError, count }, progress] = await Promise.all([query, openWipProgress(context, batch)])
  if (rowsError) throw new Error(`Failed to list import rows: ${rowsError.message}`)
  if (!rows || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Import row review is unavailable")
  if (rows.length !== Math.min(limit, Math.max(0, count - (page - 1) * limit))) throw new Error("Import row page is incomplete; reload before reviewing rows")
  return { batch: mapBatch(batch), rows: rows.map(mapImportRow), total: count, page, limit, status, progress }
}

async function openWipProgress(context: ResolvedImportContext, batch: { id: string; importer: string; status: string; cancel_requested_at: string | null }) {
  if (batch.importer !== "open_wip" || batch.status !== "committing") return null
  const rows = () => context.supabase.from("import_rows").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("batch_id", batch.id)
  const [built, total] = await Promise.all([rows().eq("status", "committed"), rows().neq("status", "skipped")])
  if (built.error || total.error) throw new Error(`Unable to read the cutover's progress: ${(built.error ?? total.error)?.message}`)
  return { built: built.count ?? 0, total: total.count ?? 0, cancelRequested: batch.cancel_requested_at !== null }
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
  const context = await resolveImportContext(access, "read")
  await requireImporterPermission(importer, context)
  const signature = sourceSignature(headers)
  const { data, error } = await context.supabase.from("import_mapping_profiles").select("column_mapping").eq("org_id", context.orgId).eq("importer", importer).eq("source_signature", signature).maybeSingle()
  if (error) throw new Error(`Failed to load import mapping profile: ${error.message}`)
  return (data?.column_mapping ?? null) as Record<string, string | null> | null
}

type CostCodeLookup = { id: string; code: string; parent_id: string | null }
type CompanyLookup = { id: string; name: string }
type PlanLookup = {
  id: string
  code: string
  versions: Array<{ id: string; status: string; version_number: number; schedule_template_id: string | null }> | null
  elevations: Array<{ id: string; code: string }> | null
}
type CommunityLookup = { id: string; name: string; code: string | null; division_id: string | null }
type DivisionLookup = { id: string; name: string; code: string | null }
type RoleLookup = { id: string; key: string }

/**
 * One org-owned reference table, read to the end. A lookup cut off at the API's
 * row cap rejects rows whose community or vendor plainly exists ("Community
 * Maple Ridge was not found"); past `cap` the import refuses instead.
 */
function readLookup<Row extends { id: string }>(context: ResolvedImportContext, table: string, columns: string, cap: number) {
  return readAllRowsById<Row>((afterId, limit) => {
    let query = context.supabase.from(table).select(columns).eq("org_id", context.orgId)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<Row[]>()
  }, { cap, label: `Failed to preload import validation data (${table})`, pageSize: 1000 })
}

async function loadValidationLookups(context: ResolvedImportContext) {
  const [costCodes, companies, plans, communities, divisions, roles] = await Promise.all([
    readLookup<CostCodeLookup>(context, "cost_codes", "id,code,parent_id", 50_000),
    readLookup<CompanyLookup>(context, "companies", "id,name", 100_000),
    readLookup<PlanLookup>(context, "house_plans", "id,code,versions:house_plan_versions(id,status,version_number,schedule_template_id),elevations:house_plan_elevations(id,code)", 10_000),
    readLookup<CommunityLookup>(context, "communities", "id,name,code,division_id", 20_000),
    readLookup<DivisionLookup>(context, "divisions", "id,name,code", 5_000),
    // Roles are the system catalog — the table has no org column, and an org
    // assigns only org-scope roles. Nothing here can name another org's data.
    context.supabase.from("roles").select("id,key").eq("scope", "org").order("key").returns<RoleLookup[]>(),
  ])
  if (roles.error) throw new Error(`Failed to preload import validation data: ${roles.error.message}`)
  return { costCodes, companies, plans, communities, divisions, roles: roles.data ?? [] }
}

function withIssue(row: ImportRowRecord, issue: ImportIssue) {
  row.issues.push(issue)
}

function settleRowStatus(row: ImportRowRecord) {
  row.status = row.issues.some((issue) => issue.level === "error") ? "error" : row.issues.some((issue) => issue.level === "warning") ? "warning" : "valid"
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
  const inviteRefusals = new Map<string, Promise<string | null>>()

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
        // A lot is pinned only to a released version; importers that do not pin a lot may still land on the draft.
        const pinsALot = importer === "open_wip" || importer === "communities_lots"
        const released = versions.find((version) => version.status === "released") ?? (pinsALot ? undefined : versions.find((version) => version.status === "draft"))
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
    if (typeof parsed.role === "string") {
      const role = roleByKey.get(normalizeKey(parsed.role))
      if (!role) withIssue(row, { level: "error", code: "unresolved_role", message: `Role ${parsed.role} was not found`, column: "role" })
      else if (importer === "team") {
        parsed.role = role.key
        const divisionId = typeof parsed.division_id === "string" ? parsed.division_id : null
        const refusalKey = `${role.key}:${divisionId ?? ""}`
        if (!inviteRefusals.has(refusalKey)) inviteRefusals.set(refusalKey, inviteRefusal({ supabase: context.supabase, orgId: context.orgId, actorUserId: context.userId, role: role.key as Parameters<typeof inviteRefusal>[0]["role"], divisionId }))
        const refusal = await inviteRefusals.get(refusalKey)
        if (refusal) withIssue(row, { level: "error", code: "invite_not_permitted", message: refusal, column: "role" })
      }
    }
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
    settleRowStatus(row)
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

const companionIdsSchema = z.object({ budgets: z.string().uuid(), purchase_orders: z.string().uuid() }).strict()

async function loadOpenWipCompanionBatches(context: ResolvedImportContext, asOfDate: string, onboardingRunId: string | null, batchContext: Record<string, unknown> = {}) {
  const explicit = batchContext.companion_batch_ids === undefined ? null : companionIdsSchema.parse(batchContext.companion_batch_ids)
  if (batchContext.is_sample === true && !explicit) throw new Error("Sample houses require their original companion batch IDs")
  if (explicit && explicit.budgets === explicit.purchase_orders) throw new Error("Open-WIP companion batch IDs must be distinct")
  const ids = explicit ? [explicit.budgets, explicit.purchase_orders] : null
  const batches: Array<{ id: string; context: Record<string, unknown>; row_count: number; committed_count: number; skipped_count: number; error_count: number }> = []
  for (let offset = 0; ; offset += INSERT_CHUNK) {
    let query = context.supabase.from("import_batches").select("id,context,created_by,row_count,committed_count,skipped_count,error_count")
      .eq("org_id", context.orgId).eq("importer", "open_wip")
      .eq("context->>as_of_date", asOfDate).in("context->>file_kind", ["budgets", "purchase_orders"])
      .in("status", explicit ? ["committed"] : ["staged", "committed"]).order("id").range(offset, offset + INSERT_CHUNK - 1)
    if (ids) query = query.in("id", ids).eq("created_by", context.userId)
    query = onboardingRunId ? query.eq("onboarding_run_id", onboardingRunId) : query.is("onboarding_run_id", null)
    const { data, error } = await query
    if (error) throw new Error(`Unable to load Open-WIP companion batches: ${error.message}`)
    batches.push(...(data ?? []))
    if ((data ?? []).length < INSERT_CHUNK) break
  }
  if (explicit && (batches.length !== 2 ||
    !batches.some(batch => batch.id === explicit.budgets && batch.context.file_kind === "budgets") ||
    !batches.some(batch => batch.id === explicit.purchase_orders && batch.context.file_kind === "purchase_orders") ||
    batches.some(batch => (batch.context.is_sample === true) !== (batchContext.is_sample === true) ||
      !Number.isInteger(batch.row_count) || batch.row_count < 1 || batch.committed_count !== batch.row_count ||
      batch.skipped_count !== 0 || batch.error_count !== 0))) {
    throw new Error("Original Open-WIP companion batches are missing or do not match the requested source scope")
  }
  return batches
}

function openWipHouseKey(parsed: ImportParsedRow) {
  return JSON.stringify([parsed.community, parsed.block, parsed.lot_number].map(normalizeKey))
}

function groupOpenWipCompanions(rows: ImportRowRecord[]) {
  const byHouse = new Map<string, ImportRowRecord[]>()
  const sourceKeys = new Set<string>()
  for (const row of rows) {
    if (sourceKeys.has(row.natural_key)) throw new Error(`Duplicate Open-WIP companion row ${row.natural_key}; reconcile the source files before importing`)
    sourceKeys.add(row.natural_key)
    const key = openWipHouseKey(row.parsed)
    const group = byHouse.get(key) ?? []
    group.push(row)
    byHouse.set(key, group)
  }
  return byHouse
}

async function loadOpenWipCompanionRows(context: ResolvedImportContext, batches: Array<{ id: string; row_count: number; context: Record<string, unknown> }>, kind: "budgets" | "purchase_orders", explicit: boolean) {
  const selected = batches.filter(batch => batch.context.file_kind === kind)
  if (!explicit) return loadImportCommitRows(context, selected.map(batch => batch.id), true)
  const results = await Promise.all(selected.map(async batch => {
    const rows = await loadImportCommitRows(context, [batch.id], true, true)
    if (rows.length !== batch.row_count || new Set(rows.map(row => row.id)).size !== rows.length ||
      new Set(rows.map(row => row.row_number)).size !== rows.length ||
      rows.some(row => !z.string().uuid().safeParse(row.id).success || !Number.isInteger(row.row_number) || row.row_number < 1 ||
        row.status !== "committed" || row.action !== "created" || row.target_entity_type !== "open_wip" || row.target_entity_id !== row.id)) {
      throw new Error("Original Open-WIP companion receipts are incomplete or do not match their committed source")
    }
    return rows
  }))
  return results.flat()
}

type CommunityPlanOffering = PlanOfferingRow & { id: string; community_id: string; house_plan_id: string }
type OfferingLot = { id: string; community_id: string; lot_number: string; block: string | null; metadata: unknown; dimensions: Record<string, unknown> | null; swing: LotSwing | null }

function readCommunityPlanOfferings(context: ResolvedImportContext, communityIds: string[], planIds: string[]) {
  return readAllRowsById<CommunityPlanOffering>((afterId, limit) => {
    let query = context.supabase.from("community_plan_availability").select("id,community_id,house_plan_id,is_available,elevation_id,effective_start,effective_end")
      .eq("org_id", context.orgId).in("community_id", communityIds).in("house_plan_id", planIds)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<CommunityPlanOffering[]>()
  }, { cap: 50_000, label: "Failed to read community plan offerings", pageSize: 1000 })
}

/** The same rule `assignPlanToLot` applies: on the community's price sheet today, or a recorded override for this plan. */
function planOfferingRefusal(offerings: readonly CommunityPlanOffering[], lotMetadata: unknown, pin: { communityId: string; planId: string; elevationId: string | null }) {
  const rows = offerings.filter((row) => row.community_id === pin.communityId && row.house_plan_id === pin.planId)
  const offered = isPlanOffered(rows, { elevationId: pin.elevationId, onDate: new Date().toISOString().slice(0, 10) })
  return offered || offeringOverrideFor(lotMetadata, pin.planId) ? null : PLAN_OFFERING_REFUSAL
}

function lotSwingOf(value: unknown): LotSwing | null {
  return value === "left" || value === "right" || value === "either" ? value : null
}

/**
 * The pin a row is about to write, judged on the lot as it will stand: a lots
 * row fills the lot's measurements and sets its swing; a house row builds on
 * the lot as it is.
 */
function importFitPin(row: ImportRowRecord, communityId: string, lot: Pick<OfferingLot, "id" | "dimensions" | "swing"> | null, kind: "lots" | "houses"): LotFitPin {
  return {
    key: row.id,
    lotId: lot?.id ?? null,
    communityId,
    dimensions: kind === "lots" ? importedLotDimensions(lot?.dimensions ?? null, row.parsed) : lot?.dimensions ?? null,
    lotSwing: kind === "lots" ? lotSwingOf(row.parsed.swing) ?? "either" : lot?.swing ?? "either",
    planId: String(row.parsed.house_plan_id),
    elevationId: typeof row.parsed.elevation_id === "string" ? row.parsed.elevation_id : null,
    swing: null,
  }
}

/** The fit refusal for one row at commit, re-read: a lot or its rules may have changed since staging. */
async function importFitRefusal(context: ResolvedImportContext, row: ImportRowRecord, communityId: string, lot: Pick<OfferingLot, "id" | "dimensions" | "swing"> | null, kind: "lots" | "houses") {
  const verdict = (await checkLotFits(context, [importFitPin(row, communityId, lot, kind)])).get(row.id)
  return verdict?.refusal ?? null
}

async function validateOpenWipPlanOfferings(rows: ImportRowRecord[], context: ResolvedImportContext, kind: "lots" | "houses") {
  const pinned = rows.filter((row) => row.status !== "skipped" && typeof row.parsed.house_plan_id === "string" && typeof row.parsed.community_id === "string")
  if (!pinned.length) return
  const communityIds = [...new Set(pinned.map((row) => String(row.parsed.community_id)))]
  const planIds = [...new Set(pinned.map((row) => String(row.parsed.house_plan_id)))]
  const [offerings, lots] = await Promise.all([
    readCommunityPlanOfferings(context, communityIds, planIds),
    readAllRowsById<OfferingLot>((afterId, limit) => {
      let query = context.supabase.from("lots").select("id,community_id,lot_number,block,metadata,dimensions,swing").eq("org_id", context.orgId).in("community_id", communityIds)
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<OfferingLot[]>()
    }, { cap: 100_000, label: "Failed to read lots for plan offering check", pageSize: 1000 }),
  ])
  const lotByKey = new Map(lots.map((lot) => [`${lot.community_id}|${lot.lot_number}|${lot.block ?? ""}`, lot]))
  const lotOf = (row: ImportRowRecord) => lotByKey.get(`${row.parsed.community_id}|${row.parsed.lot_number}|${row.parsed.block ?? ""}`) ?? null
  const fits = await checkLotFits(context, pinned.map((row) => importFitPin(row, String(row.parsed.community_id), lotOf(row), kind)))
  for (const row of pinned) {
    const communityId = String(row.parsed.community_id)
    const lot = lotOf(row)
    const refusal = planOfferingRefusal(offerings, lot?.metadata ?? null, { communityId, planId: String(row.parsed.house_plan_id), elevationId: typeof row.parsed.elevation_id === "string" ? row.parsed.elevation_id : null })
    if (refusal) withIssue(row, { level: "error", code: "plan_not_offered", message: `Plan ${row.parsed.plan_code}: ${refusal}`, column: "plan_code" })
    const fitRefusal = fits.get(row.id)?.refusal
    if (fitRefusal) withIssue(row, { level: "error", code: "plan_does_not_fit", message: `Plan ${row.parsed.plan_code}: ${fitRefusal}`, column: "plan_code" })
  }
}

/** A lot's own metadata (offering overrides among it) survives a re-import of the lot. */
function lotMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

/**
 * The lots file may pin a plan to a lot. It follows the same rule as every other
 * pin: a released version only, on the community's price sheet (or a recorded
 * override). A community created by this same file offers nothing yet, so its
 * pins are refused until the offering is set up.
 */
async function validateLotPlanPins(rows: ImportRowRecord[], context: ResolvedImportContext) {
  for (const row of rows) {
    if (row.status === "skipped" || !row.parsed.house_plan_id) continue
    if (!row.parsed.house_plan_version_id) {
      withIssue(row, { level: "error", code: "plan_not_released", message: `Plan ${row.parsed.plan_code} has no released version, and a lot is pinned only to a released version; release one before importing`, column: "plan_code" })
    }
    if (typeof row.parsed.community_id !== "string") {
      withIssue(row, { level: "error", code: "plan_not_offered", message: `Plan ${row.parsed.plan_code}: ${PLAN_OFFERING_REFUSAL} Set up the community's plan offering, then import the plan pins.`, column: "plan_code" })
    }
  }
  await validateOpenWipPlanOfferings(rows, context, "lots")
  rows.forEach(settleRowStatus)
  return rows
}

async function validateOpenWipCompanions(rows: ImportRowRecord[], context: ResolvedImportContext, batchContext: Record<string, unknown>, onboardingRunId: string | null = null) {
  if (batchContext.file_kind !== "houses") return rows
  for (const row of rows) {
    if (row.parsed.house_plan_id && !row.parsed.house_plan_version_id) {
      withIssue(row, { level: "error", code: "plan_not_released", message: `Plan ${row.parsed.plan_code} has no released version, and a lot is pinned only to a released version; release one before importing`, column: "plan_code" })
    }
    if (row.parsed.house_plan_version_id && !row.parsed.schedule_template_id) {
      withIssue(row, { level: "error", code: "missing_schedule_template", message: `Plan ${row.parsed.plan_code} has no schedule template, so the current stage ${row.parsed.stage_task} cannot be placed; attach a template to the plan version before importing`, column: "plan_code" })
    }
    if (row.parsed.sold && !row.parsed.buyer_email) {
      withIssue(row, { level: "error", code: "missing_buyer", message: "A sold home needs a buyer email so the buyer is kept on the home", column: "buyer_email" })
    }
  }
  await validateOpenWipPlanOfferings(rows, context, "houses")
  const asOfDate = typeof batchContext.as_of_date === "string" ? batchContext.as_of_date : null
  if (!asOfDate) {
    rows.forEach((row) => { withIssue(row, { level: "error", code: "missing_as_of_date", message: "Open-WIP houses require an as-of date" }); settleRowStatus(row) })
    return rows
  }
  const batches = await loadOpenWipCompanionBatches(context, asOfDate, onboardingRunId, batchContext)
  const budgetBatchIds = (batches ?? []).filter((batch) => batch.context?.file_kind === "budgets" && batch.context?.as_of_date === asOfDate).map((batch) => batch.id)
  if (!budgetBatchIds.length) {
    rows.forEach((row) => { withIssue(row, { level: "error", code: "missing_budget_file", message: `Stage the ${asOfDate} budget snapshot before the house file` }); settleRowStatus(row) })
    return rows
  }
  const explicit = batchContext.companion_batch_ids !== undefined
  const [budgetItems, poItems] = await Promise.all([
    loadOpenWipCompanionRows(context, batches, "budgets", explicit),
    loadOpenWipCompanionRows(context, batches, "purchase_orders", explicit),
  ])
  const budgetRows = groupOpenWipCompanions(budgetItems)
  groupOpenWipCompanions(poItems)
  for (const row of rows) {
    const houseKey = openWipHouseKey(row.parsed)
    const sum = (budgetRows.get(houseKey) ?? []).reduce((total, item) => total + Number(item.parsed?.budget_cents ?? 0), 0)
    if (sum !== Number(row.parsed.budget_total_cents)) withIssue(row, { level: "error", code: "budget_total_mismatch", message: `Budget snapshot totals ${sum} cents; the house row declares ${Number(row.parsed.budget_total_cents)} cents`, column: "budget_total_cents" })
    settleRowStatus(row)
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
  // A file refused for its shape costs nothing; only one that will be staged spends the budget.
  await enforceMutationRateLimit("import_stage", resolved.orgId)
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
    if (input.importer === "open_wip") staged = await validateOpenWipCompanions(staged, resolved, contextPayload, input.onboardingRunId ?? null)
    if (input.importer === "communities_lots") staged = await validateLotPlanPins(staged, resolved)
    if (input.importer === "warranty_homes") staged = await validateInstalledHomeRows(staged, resolved)
    if (isCutoverImporter(input.importer)) staged = await validateCutoverRows(input.importer, staged, resolved, contextPayload)
    await persistValidatedRows(resolved, batch.id, staged)
    const counts = rowCounts(staged)
    const report = { source_headers: headers, file_kind: contextPayload.file_kind ?? null, duplicate_rows: staged.filter((row) => row.issues.some((issue) => issue.code === "duplicate_natural_key")).length, unmatched_vendors: staged.filter((row) => row.issues.some((issue) => issue.code === "vendor_unmatched")).length }
    const { data: saved, error: saveError } = await resolved.supabase.from("import_batches").update({ ...counts, status: "staged", report }).eq("org_id", resolved.orgId).eq("id", batch.id).select("*").single()
    if (saveError || !saved) throw new Error(`Failed to finalize import batch: ${saveError?.message}`)
    if (input.mapping) await saveMappingProfile(resolved, input.importer, headers, mapping)
    await recordEvent({ orgId: resolved.orgId, actorId: resolved.userId, eventType: "import_batch_staged", entityType: "import_batch", entityId: batch.id, payload: { importer: input.importer, ...counts }, channel: "activity" })
    return mapBatch(saved)
  } catch (error) {
    await resolved.supabase.from("import_batches").update({ status: "failed", report: { error: error instanceof Error ? error.message : "Staging failed" } }).eq("org_id", resolved.orgId).eq("id", batch.id)
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
  if (!input.skip && batch.importer === "open_wip") rows = await validateOpenWipCompanions(rows, context, batch.context ?? {}, batch.onboarding_run_id ?? null)
  if (!input.skip && batch.importer === "communities_lots") rows = await validateLotPlanPins(rows, context)
  if (!input.skip && batch.importer === "warranty_homes") rows = await validateInstalledHomeRows(rows, context)
  if (!input.skip && isCutoverImporter(batch.importer)) rows = await validateCutoverRows(batch.importer, rows, context, batch.context ?? {})
  await persistValidatedRows(context, input.batchId, rows)
  await refreshBatchCounts(context, input.batchId)
  return rows[0]
}

async function refreshBatchCounts(context: ResolvedImportContext, batchId: string) {
  const total = await context.supabase.from("import_rows").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("batch_id", batchId)
  if (total.error) throw new Error(`Failed to recount import batch: ${total.error.message}`)
  if (typeof total.count !== "number" || !Number.isSafeInteger(total.count) || total.count < 0) throw new Error("Import recount total is unavailable")
  const result = await readAllRows(async (from, to) => {
    const page = await context.supabase.from("import_rows").select("id,row_number,status")
      .eq("org_id", context.orgId).eq("batch_id", batchId).order("row_number").order("id").range(from, to)
    if (!page.data && !page.error) throw new Error("Import recount page is unavailable")
    return page
  }, { cap: MAX_ROWS + 1, label: "Failed to recount import batch" })
  if (result.rows.length !== total.count) throw new Error("Import recount membership is incomplete or changed; reload before committing")
  if (result.truncated || result.rows.length > MAX_ROWS) throw new Error("Import batch exceeds the supported row limit; reconcile before committing")
  const statuses = result.rows
  if (new Set(statuses.map(row => row.id)).size !== statuses.length) throw new Error("Import row membership changed while recounting; reload before committing")
  const counts = { row_count: statuses.length, valid_count: statuses.filter((row) => row.status === "valid").length, warning_count: statuses.filter((row) => row.status === "warning").length, error_count: statuses.filter((row) => row.status === "error").length, skipped_count: statuses.filter((row) => row.status === "skipped").length }
  const { data: saved, error } = await context.supabase.from("import_batches").update(counts).eq("org_id", context.orgId).eq("id", batchId).eq("status", "staged").select("id").single()
  if (error || !saved) throw new Error(`Failed to save import counts: ${error?.message ?? "Batch changed while recounting"}`)
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
  if (batch.importer === "open_wip") {
    // A failed cutover that kept its homes owns them through these receipts; discarding would orphan them.
    const receipts = await context.supabase.from("import_rows").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("batch_id", batchId).eq("status", "committed")
    if (receipts.error) throw new Error(`Unable to check the batch's receipts: ${receipts.error.message}`)
    if (receipts.count) throw new Error("This batch kept the records it committed; commit it again to finish it instead of discarding it")
  }
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
  // Every existing code: one missed past the API's row cap would be inserted again.
  const existingRows = await readLookup<CostCodeLookup>(context, "cost_codes", "id,code,parent_id", 50_000)
  const byCode = new Map(existingRows.map((row) => [normalizeKey(row.code), row]))
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
  const plans = await readLookup<PlanLookup>(context, "house_plans", "id,code,versions:house_plan_versions(id,status,version_number,schedule_template_id),elevations:house_plan_elevations(id,code)", 10_000)
  const byCode = new Map(plans.map((plan) => [normalizeKey(plan.code), plan]))
  if (fileKind === "takeoffs") {
    const costCodes = await readLookup<{ id: string; code: string; cost_type: string | null }>(context, "cost_codes", "id,code,cost_type", 50_000)
    const costs = new Map(costCodes.map((row) => [normalizeKey(row.code), row]))
    for (const row of rows) {
      const plan = byCode.get(normalizeKey(row.parsed.plan_code))
      const version = Array.isArray(plan?.versions) ? plan.versions.find((item) => item.status === "draft") : null
      if (!plan || !version) throw new Error(`Plan ${row.parsed.plan_code} does not have a draft version`)
      const elevation = row.parsed.elevation_code && Array.isArray(plan.elevations) ? plan.elevations.find((item) => normalizeKey(item.code) === normalizeKey(row.parsed.elevation_code)) : null
      const costCode = costs.get(normalizeKey(row.parsed.cost_code))
      const { data: existing } = await context.supabase.from("house_plan_takeoff_lines").select("id").eq("org_id", context.orgId).eq("house_plan_version_id", version.id).eq("cost_code_id", costCode?.id).eq("description", row.parsed.description).is("elevation_id", elevation?.id ?? null).maybeSingle()
      if (existing && !updateExisting) { results.set(row.id, { id: existing.id, action: "skipped_existing" }); continue }
      const payload = { org_id: context.orgId, house_plan_version_id: version.id, elevation_id: elevation?.id ?? null, cost_code_id: costCode?.id, cost_type: costCode?.cost_type ?? null, description: row.parsed.description, quantity: row.parsed.quantity, uom: row.parsed.uom, unit_cost_cents: row.parsed.unit_cost_cents, metadata: { imported: true } }
      const query = existing ? context.supabase.from("house_plan_takeoff_lines").update(payload).eq("org_id", context.orgId).eq("id", existing.id) : context.supabase.from("house_plan_takeoff_lines").insert(payload)
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
      const { data: version, error: versionError } = await context.supabase.from("house_plan_versions").insert({ org_id: context.orgId, house_plan_id: data.id, version_number: 1, status: "draft", created_by: context.userId }).select("id,status,version_number,schedule_template_id").single()
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

/**
 * The importer writes as the service client, which no policy fences, so a
 * division-limited member's rows are checked here, whole batch, before the first
 * write: an org-wide row or another division's row is the same refusal
 * createPriceAgreement gives.
 */
async function assertPriceBookRowsInDivisions(rows: ImportRowRecord[], context: ResolvedImportContext) {
  if (context.platform) return
  const access = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (!access.assignedOnly) return
  const communityIds = [...new Set(rows.flatMap((row) => (typeof row.parsed.community_id === "string" ? [row.parsed.community_id] : [])))]
  const communityDivision = new Map<string, string | null>()
  for (let index = 0; index < communityIds.length; index += 100) {
    const { data, error } = await context.supabase.from("communities").select("id,division_id")
      .eq("org_id", context.orgId).in("id", communityIds.slice(index, index + 100))
    if (error) throw new Error(`Failed to check the communities' divisions: ${error.message}`)
    for (const community of data ?? []) communityDivision.set(community.id, community.division_id ?? null)
  }
  const outside = rows.filter((row) => {
    const communityId = typeof row.parsed.community_id === "string" ? row.parsed.community_id : null
    return !agreementWriteAllowed(access, {
      divisionId: typeof row.parsed.division_id === "string" ? row.parsed.division_id : null,
      communityId,
      communityDivisionId: communityId ? communityDivision.get(communityId) ?? null : null,
    })
  })
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).map((row) => row.row_number).join(", ")
    throw new Error(`Rows ${shown}${outside.length > 5 ? ` and ${outside.length - 5} more` : ""} are outside your divisions: a price needs a division or community you work in. Nothing was imported.`)
  }
}

async function commitPriceBook(rows: ImportRowRecord[], context: ResolvedImportContext) {
  await assertPriceBookRowsInDivisions(rows, context)
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
    let lotQuery = context.supabase.from("lots").select("id, dimensions, metadata, swing").eq("org_id", context.orgId).eq("community_id", community.id).eq("lot_number", row.parsed.lot_number)
    lotQuery = row.parsed.block ? lotQuery.eq("block", row.parsed.block) : lotQuery.is("block", null)
    const { data: existingLot } = await lotQuery.maybeSingle()
    if (existingLot && !updateExisting) { results.set(row.id, { id: existingLot.id, action: "skipped_existing" }); continue }
    if (row.parsed.house_plan_id) {
      // Re-checked at commit: an offering withdrawn or a version superseded since staging refuses the batch.
      const [offerings, version] = await Promise.all([
        readCommunityPlanOfferings(context, [community.id], [String(row.parsed.house_plan_id)]),
        context.supabase.from("house_plan_versions").select("id,status").eq("org_id", context.orgId).eq("id", row.parsed.house_plan_version_id).maybeSingle(),
      ])
      if (version.data?.status !== "released") throw new Error(`Lot ${row.parsed.lot_number}: plan ${row.parsed.plan_code} is no longer released`)
      const refusal = planOfferingRefusal(offerings, existingLot?.metadata ?? null, { communityId: community.id, planId: String(row.parsed.house_plan_id), elevationId: typeof row.parsed.elevation_id === "string" ? row.parsed.elevation_id : null })
      if (refusal) throw new Error(`Lot ${row.parsed.lot_number}: ${refusal}`)
      const fitRefusal = await importFitRefusal(context, row, community.id, existingLot ?? null, "lots")
      if (fitRefusal) throw new Error(`Lot ${row.parsed.lot_number}: ${fitRefusal}`)
    }
    const payload = { org_id: context.orgId, community_id: community.id, community_phase_id: phaseId, division_id: community.division_id, lot_number: row.parsed.lot_number, block: row.parsed.block, status: row.parsed.status, address: row.parsed.address, dimensions: importedLotDimensions(existingLot?.dimensions ?? null, row.parsed), swing: row.parsed.swing ?? "either", premium_cents: row.parsed.premium_cents ?? 0, cost_basis_cents: row.parsed.cost_basis_cents, takedown_id: takedownId, house_plan_id: row.parsed.house_plan_id, house_plan_version_id: row.parsed.house_plan_version_id, house_plan_elevation_id: row.parsed.elevation_id, metadata: { ...lotMetadata(existingLot?.metadata), imported: true } }
    const query = existingLot ? context.supabase.from("lots").update(payload).eq("org_id", context.orgId).eq("id", existingLot.id) : context.supabase.from("lots").insert(payload)
    const { data, error } = await query.select("id").single()
    if (error || !data) throw new Error(`Failed to commit lot ${row.parsed.lot_number}: ${error?.message}`)
    results.set(row.id, { id: data.id, action: existingLot ? "updated" : "created" })
  }
  return results
}

/** A row fills the fields it supplies; a blank cell never erases what the lot already has. */
function importedLotDimensions(existing: Record<string, unknown> | null, parsed: ImportParsedRow) {
  const measure = (value: ImportParsedRow[string] | undefined) => (typeof value === "number" ? value : undefined)
  const stored = storeLotDimensions(
    existing,
    { widthFt: measure(parsed.width_ft), depthFt: measure(parsed.depth_ft), acreage: measure(parsed.acreage) },
    "fill",
  )
  for (const key of ["city", "state", "postal_code"]) if (parsed[key] != null && parsed[key] !== "") stored[key] = parsed[key]
  return stored
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
    const divisionId = typeof row.parsed.division_id === "string" ? row.parsed.division_id : null
    const created = await createOrgMemberInvite({
      supabase: context.supabase, orgId: context.orgId, actorUserId: context.userId, email, fullName: String(row.parsed.full_name),
      role: row.parsed.role as Parameters<typeof createOrgMemberInvite>[0]["role"], sendEmail: false,
      divisionScope: divisionId ? "assigned" : "all", divisionIds: divisionId ? [divisionId] : [],
    })
    results.set(row.id, { id: created.id, action: "created" })
  }
  return results
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10)
}

/** Read bounded pages so PostgREST's response limit cannot truncate a cutover. */
async function loadImportCommitRows(context: ResolvedImportContext, batchIds: string[], includeCommitted = false, requireCommitted = false) {
  const rows: ImportRowRecord[] = []
  for (let batchOffset = 0; batchOffset < batchIds.length; batchOffset += 100) {
    const ids = batchIds.slice(batchOffset, batchOffset + 100)
    for (let offset = 0; ; offset += INSERT_CHUNK) {
      const { data, error } = await context.supabase.from("import_rows").select("*")
        .eq("org_id", context.orgId).in("batch_id", ids)
        .in("status", requireCommitted ? ["committed"] : includeCommitted ? ["valid", "warning", "committed"] : ["valid", "warning"])
        .order("row_number").order("id").range(offset, offset + INSERT_CHUNK - 1)
      if (error) throw new Error(`Failed to load import rows: ${error.message}`)
      rows.push(...(data ?? []).map(mapImportRow))
      if ((data ?? []).length < INSERT_CHUNK) break
    }
  }
  return rows
}

/** Template items store `start_offset_days`; fall back to list position for templates without offsets. */
function templateOffset(item: { start_offset_days?: unknown }, index: number) {
  return typeof item.start_offset_days === "number" ? item.start_offset_days : index
}

// ---------------------------------------------------------------------------
// Open-WIP commit: a durable, resumable job.
//
// The batch is claimed under a token and a lease (claim_open_wip_commit), which
// also queues the outbox job that finishes it if this process dies. Each house
// is written with its row receipt in one transaction (commit_open_wip_house), so
// a resumed attempt starts after the last receipt and never builds a home twice.
// A house that cannot be built fails the batch and takes every home it published
// back out (rollback_open_wip_commit). The batch is 'committed' only when the
// receipts, homes, budgets and POs reconcile to the source files
// (finalize_open_wip_commit).

/** The outbox job that resumes an Open-WIP commit whose process died or timed out. */
export const OPEN_WIP_COMMIT_JOB_TYPE = "import_open_wip_commit"
/** Interrupted attempts before a batch stops resuming on its own and waits for an operator to commit it again. */
const OPEN_WIP_MAX_COMMIT_ATTEMPTS = 5
const OPEN_WIP_CLAIM_LOST = "Open-WIP commit claim is no longer owned"

/** A row the source files cannot build. It fails the batch and takes back what this attempt built; any other error is an interruption the batch resumes from. */
class OpenWipRowRefusal extends Error {}

/** A raised exception or a constraint the row's data breaks is a refusal; a lost claim, a timeout or a dropped connection is not. */
function openWipRpcFailure(error: { message: string; code?: string }) {
  const code = error.code ?? ""
  return code === "P0001" || code.startsWith("22") || code.startsWith("23") ? new OpenWipRowRefusal(error.message) : new Error(error.message)
}

const openWipClaimSchema = z.object({
  token: z.string().uuid(),
  attempt: z.number().int().positive(),
  jobId: z.number().int().nullable(),
  actorId: z.string().uuid().nullable(),
})
type OpenWipClaim = z.infer<typeof openWipClaimSchema>

type OpenWipCompanions = { budgetsByHouse: Map<string, ImportRowRecord[]>; posByHouse: Map<string, ImportRowRecord[]> }

async function loadOpenWipCommitCompanions(context: ResolvedImportContext, asOfDate: string, batchContext: Record<string, unknown>, onboardingRunId: string | null): Promise<OpenWipCompanions> {
  const siblingBatches = await loadOpenWipCompanionBatches(context, asOfDate, onboardingRunId, batchContext)
  const explicit = batchContext.companion_batch_ids !== undefined
  const [budgetItems, poItems] = await Promise.all([
    loadOpenWipCompanionRows(context, siblingBatches, "budgets", explicit),
    loadOpenWipCompanionRows(context, siblingBatches, "purchase_orders", explicit),
  ])
  return { budgetsByHouse: groupOpenWipCompanions(budgetItems), posByHouse: groupOpenWipCompanions(poItems) }
}

/** What the source files say a house's home must hold; finalize compares the home against it. */
function openWipExpectation(row: ImportRowRecord, companions: OpenWipCompanions) {
  const key = openWipHouseKey(row.parsed)
  const budget = companions.budgetsByHouse.get(key) ?? []
  const orders = companions.posByHouse.get(key) ?? []
  return {
    row_id: row.id,
    lot_number: String(row.parsed.lot_number),
    budget_cents: budget.reduce((sum, item) => sum + Number(item.parsed?.budget_cents ?? 0), 0),
    budget_lines: budget.length,
    purchase_orders: orders.length,
    po_cents: orders.reduce((sum, item) => sum + Number(item.parsed?.remaining_cents ?? 0), 0),
  }
}

/** Everything one home is built from, re-read now: the price sheet, the plan version or the lot may have changed since staging. */
async function prepareOpenWipHouse(context: ResolvedImportContext, row: ImportRowRecord, companions: OpenWipCompanions, asOfDate: string) {
  const expected = openWipExpectation(row, companions)
  if (expected.budget_cents !== Number(row.parsed.budget_total_cents)) throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: budget lines total does not match the house total`)
  const key = openWipHouseKey(row.parsed)
  const budgetRows = companions.budgetsByHouse.get(key) ?? []
  const poRows = companions.posByHouse.get(key) ?? []
  let lotQuery = context.supabase.from("lots").select("id,project_id,metadata,dimensions,swing").eq("org_id", context.orgId).eq("community_id", row.parsed.community_id).eq("lot_number", row.parsed.lot_number)
  lotQuery = row.parsed.block ? lotQuery.eq("block", row.parsed.block) : lotQuery.is("block", null)
  const [communityResult, lotResult, offerings, version] = await Promise.all([
    context.supabase.from("communities").select("id,name,division_id").eq("org_id", context.orgId).eq("id", row.parsed.community_id).single(),
    lotQuery.single(),
    readCommunityPlanOfferings(context, [String(row.parsed.community_id)], [String(row.parsed.house_plan_id)]),
    context.supabase.from("house_plan_versions").select("id,status").eq("org_id", context.orgId).eq("id", row.parsed.house_plan_version_id).maybeSingle(),
  ])
  const community = communityResult.data
  const lot = lotResult.data
  // .single() reports a missing row as PGRST116: the source names something that is not there.
  if (communityResult.error || !community) throw new (communityResult.error?.code === "PGRST116" ? OpenWipRowRefusal : Error)(`Unable to resolve the Open-WIP community: ${communityResult.error?.message}`)
  if (lotResult.error || !lot) throw new (lotResult.error?.code === "PGRST116" ? OpenWipRowRefusal : Error)(`Unable to resolve the Open-WIP lot: ${lotResult.error?.message}`)
  // A lot with a home is the commit's to judge before anything else: adopted if this row built it, refused otherwise.
  if (lot.project_id) return { lot_id: lot.id, lot_number: String(row.parsed.lot_number), community_id: community.id }
  if (version.error) throw new Error(`Unable to load the plan version: ${version.error.message}`)
  if (version.data?.status !== "released") throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: plan ${row.parsed.plan_code} no longer has that released version`)
  const elevationId = typeof row.parsed.elevation_id === "string" ? row.parsed.elevation_id : null
  const offeringRefusal = planOfferingRefusal(offerings, lot.metadata, { communityId: community.id, planId: String(row.parsed.house_plan_id), elevationId })
  if (offeringRefusal) throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: ${offeringRefusal}`)
  const fitRefusal = await importFitRefusal(context, row, community.id, { id: lot.id, dimensions: lot.dimensions, swing: lotSwingOf(lot.swing) }, "houses")
  if (fitRefusal) throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: ${fitRefusal}`)

  if (!row.parsed.schedule_template_id) throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: the plan has no schedule template, so the current stage cannot be placed`)
  const { data: template, error: templateError } = await context.supabase.from("schedule_templates").select("items").eq("org_id", context.orgId).eq("id", row.parsed.schedule_template_id).maybeSingle()
  if (templateError) throw new Error(`Unable to load WIP schedule template: ${templateError.message}`)
  if (!template) throw new OpenWipRowRefusal("Unable to load WIP schedule template: Template not found")
  const items = Array.isArray(template.items) ? template.items : []
  const anchorIndex = items.findIndex((item) => normalizeKey(item.name) === normalizeKey(row.parsed.stage_task))
  if (anchorIndex < 0) throw new OpenWipRowRefusal(`Schedule task ${row.parsed.stage_task} was not found in the plan template`)
  const stageDate = typeof row.parsed.stage_date === "string" ? row.parsed.stage_date : asOfDate
  const anchorOffset = templateOffset(items[anchorIndex], anchorIndex)
  if (row.parsed.sold && !row.parsed.buyer_email) throw new OpenWipRowRefusal(`Lot ${row.parsed.lot_number}: a sold home needs a buyer email`)
  const saleDate = typeof row.parsed.sale_date === "string" ? row.parsed.sale_date : null

  const house = {
    lot_id: lot.id,
    lot_number: String(row.parsed.lot_number),
    community_id: community.id,
    division_id: community.division_id,
    name: `${community.name} — Lot ${row.parsed.lot_number}`,
    as_of_date: asOfDate,
    house_plan_id: row.parsed.house_plan_id,
    house_plan_version_id: row.parsed.house_plan_version_id,
    house_plan_elevation_id: elevationId,
    budget: {
      total_cents: expected.budget_cents,
      lines: budgetRows.map((item, index) => ({ cost_code_id: item.parsed?.cost_code_id, description: `Imported ${item.parsed?.cost_code}`, amount_cents: item.parsed?.budget_cents, sort_order: index })),
    },
    purchase_orders: poRows.map((item) => ({
      company_id: typeof item.parsed?.company_id === "string" ? item.parsed.company_id : null,
      vendor: item.parsed?.vendor ?? null,
      title: item.parsed?.description ?? `Imported PO ${item.parsed?.po_number}`,
      description: item.parsed?.description ?? null,
      po_number: item.parsed?.po_number ?? null,
      cost_code_id: item.parsed?.cost_code_id ?? null,
      remaining_cents: item.parsed?.remaining_cents,
      original_cents: item.parsed?.original_cents ?? null,
    })),
    schedule: items.map((item, index) => {
      const offset = templateOffset(item, index) - anchorOffset
      return {
        name: item.name, item_type: item.item_type ?? "task",
        status: index < anchorIndex ? "completed" : index === anchorIndex ? "in_progress" : "planned",
        start_date: addDays(stageDate, offset), end_date: addDays(stageDate, offset + Math.max(0, Number(item.duration_days ?? 1) - 1)),
        progress: index < anchorIndex ? 100 : index === anchorIndex ? 10 : 0, sort_order: index,
        metadata: { imported_open_wip: true, completed_at_cutover: index < anchorIndex ? asOfDate : null },
      }
    }),
    buyer: row.parsed.sold ? { name: row.parsed.buyer_name, email: row.parsed.buyer_email } : null,
    contract: row.parsed.sold ? {
      number: `WIP-${String(row.parsed.community).slice(0, 3).toUpperCase()}-${row.parsed.lot_number}`,
      title: `Imported purchase agreement — Lot ${row.parsed.lot_number}`,
      signed_at: saleDate ? `${saleDate}T00:00:00Z` : null,
      total_cents: row.parsed.sale_price_cents,
      effective_date: saleDate ?? asOfDate,
    } : null,
  }
  return house
}

const openWipCancelledSchema = z.object({
  at: z.string(),
  requested_at: z.string().nullable(),
  by: z.string().uuid().nullable(),
  homes_built: z.number().int(),
  rows: z.number().int(),
  attempt: z.number().int().nullable(),
})

async function recordOpenWipCancelled(context: ResolvedImportContext, batchId: string, cancelled: z.infer<typeof openWipCancelledSchema>) {
  const actorId = cancelled.by ?? context.userId
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId, eventType: "import_batch_cancelled", entityType: "import_batch", entityId: batchId, payload: { importer: "open_wip", homes_built: cancelled.homes_built, rows: cancelled.rows, attempt: cancelled.attempt } }),
    recordAudit({ orgId: context.orgId, actorId, action: "update", entityType: "import_batch", entityId: batchId, before: { status: "committing" }, after: { importer: "open_wip", status: "failed", cancelled }, source: context.platform ? "platform_ops" : undefined }),
  ])
}

/** Stops the commit here when an operator asked it to; the batch keeps every home it built and resumes from those receipts on "Commit again". */
async function stopIfOpenWipCancelRequested(context: ResolvedImportContext, batchId: string, claim: OpenWipClaim) {
  const { data, error } = await context.supabase.rpc("cancel_open_wip_commit_if_requested", { p_org_id: context.orgId, p_batch_id: batchId, p_claim_token: claim.token })
  if (error) throw new Error(error.message)
  if (data === null) return null
  const cancelled = openWipCancelledSchema.parse(data)
  await completeOutboxJob(claim.jobId)
  await recordOpenWipCancelled(context, batchId, cancelled)
  const { data: saved, error: savedError } = await context.supabase.from("import_batches").select("*").eq("org_id", context.orgId).eq("id", batchId).single()
  if (savedError || !saved) throw new Error(`Unable to reload the cancelled batch: ${savedError?.message}`)
  return mapBatch(saved)
}

/**
 * Asks a running Open-WIP cutover to stop. A live commit stops at its next home
 * (never inside one); a commit whose process already died is stopped at once.
 * Either way the batch ends failed with `report.cancelled`, keeps the homes it
 * built with their receipts, and "Commit again" resumes from them.
 */
export async function cancelImportBatch(batchId: string, access: ImportAccess = {}) {
  const id = z.string().uuid().parse(batchId)
  const context = await resolveImportContext(access)
  const { data: batch, error: batchError } = await context.supabase.from("import_batches").select("importer").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (batchError || !batch) throw new Error("Import batch not found")
  await requireImporterPermission(batch.importer as ImporterKey, context)
  if (batch.importer !== "open_wip") throw new Error("Only an Open-WIP cutover runs long enough to cancel; other imports commit in one step")
  const { data, error } = await context.supabase.rpc("request_open_wip_cancel", { p_org_id: context.orgId, p_batch_id: id, p_actor_id: context.userId })
  if (error) throw new Error(error.code === "55000" ? "Only a running cutover can be cancelled" : `Unable to cancel the cutover: ${error.message}`)
  const outcome = z.discriminatedUnion("state", [
    z.object({ state: z.literal("requested") }),
    z.object({ state: z.literal("cancelled"), cancelled: openWipCancelledSchema }),
  ]).parse(data)
  if (outcome.state === "cancelled") await recordOpenWipCancelled(context, id, outcome.cancelled)
  else await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "import_batch", entityId: id, after: { importer: "open_wip", cancel_requested: true }, source: context.platform ? "platform_ops" : undefined })
  return { state: outcome.state }
}

function parseOpenWipClaim(value: unknown): OpenWipClaim | null {
  return value === null ? null : openWipClaimSchema.parse(value)
}

/** Builds every house the batch has no receipt for, then reconciles. Returns the saved batch row. */
async function runOpenWipCommit(context: ResolvedImportContext, batchId: string, claim: OpenWipClaim) {
  const { data: batch, error: batchError } = await context.supabase.from("import_batches").select("*").eq("org_id", context.orgId).eq("id", batchId).single()
  if (batchError || !batch) throw new Error(`Import batch not found: ${batchError?.message}`)
  const batchContext: Record<string, unknown> = batch.context ?? {}
  const fail = async (error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : "Commit failed"
    // A claim taken over by another attempt is that attempt's to finish; nothing is undone here.
    if (message.includes(OPEN_WIP_CLAIM_LOST)) throw error
    if (!(error instanceof OpenWipRowRefusal)) {
      // An interruption keeps every home and receipt; the claim lapses now and the batch resumes from its receipts.
      const { error: releaseError } = await context.supabase.rpc("release_open_wip_commit", { p_org_id: context.orgId, p_batch_id: batchId, p_claim_token: claim.token, p_error: message, p_fail: false })
      throw new Error(`${message}. The cutover was interrupted and resumes from its receipts${releaseError ? " once its claim lapses" : ""}.`)
    }
    const { error: rollbackError } = await context.supabase.rpc("rollback_open_wip_commit", { p_org_id: context.orgId, p_batch_id: batchId, p_claim_token: claim.token, p_error: message })
    if (rollbackError) throw new Error(`${message}. The batch's homes could not be taken back yet (${rollbackError.message}); it resumes once its claim lapses.`)
    // The batch is failed: nothing is left for the resume job to do.
    await completeOutboxJob(claim.jobId)
    throw error
  }
  let expected: Array<ReturnType<typeof openWipExpectation>> = []
  try {
    if (batchContext.file_kind === "houses") {
      const asOfDate = typeof batchContext.as_of_date === "string" ? batchContext.as_of_date : null
      if (!asOfDate) throw new OpenWipRowRefusal("Open-WIP house imports require an as-of date")
      const rows = await loadImportCommitRows(context, [batchId], true)
      const companions = await loadOpenWipCommitCompanions(context, asOfDate, batchContext, batch.onboarding_run_id ?? null)
      expected = rows.map((row) => openWipExpectation(row, companions))
      for (const row of rows) {
        if (row.status === "committed") continue
        // An operator's cancellation stops the commit between homes, never inside one.
        const cancelled = await stopIfOpenWipCancelRequested(context, batchId, claim)
        if (cancelled) return cancelled
        const house = await prepareOpenWipHouse(context, row, companions, asOfDate)
        const { error } = await context.supabase.rpc("commit_open_wip_house", { p_org_id: context.orgId, p_batch_id: batchId, p_claim_token: claim.token, p_row_id: row.id, p_house: house })
        if (error) throw openWipRpcFailure(error)
      }
    }
  } catch (error) {
    return fail(error)
  }
  const { data: saved, error: finalizeError } = await context.supabase.rpc("finalize_open_wip_commit", { p_org_id: context.orgId, p_batch_id: batchId, p_claim_token: claim.token, p_expected: expected })
  if (finalizeError || !saved) throw new Error(`Failed to finalize the Open-WIP batch: ${finalizeError?.message}`)
  await completeOutboxJob(claim.jobId)
  if (saved.status !== "committed") throw new Error(String(saved.report?.commit_error ?? "The Open-WIP batch did not reconcile"))
  const actions = saved.report?.actions ?? {}
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "import_batch_committed", entityType: "import_batch", entityId: batchId, payload: { importer: "open_wip", committed_count: saved.committed_count, skipped_count: saved.skipped_count, actions, attempt: claim.attempt } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "import_batch", entityId: batchId, after: { importer: "open_wip", status: "committed", actions, attempt: claim.attempt } }),
  ])
  return mapBatch(saved)
}

async function commitOpenWipBatch(context: ResolvedImportContext, batchId: string) {
  const { data, error } = await context.supabase.rpc("claim_open_wip_commit", { p_org_id: context.orgId, p_batch_id: batchId, p_actor_id: context.userId, p_allow_failed: true, p_enqueue: true })
  if (error) throw new Error(`Unable to claim the Open-WIP batch: ${error.message}`)
  const claim = parseOpenWipClaim(data)
  if (!claim) throw new Error("Batch must be staged with all errors fixed or explicitly skipped; a failed or interrupted cutover resumes from its receipts")
  return runOpenWipCommit(context, batchId, claim)
}

/** The outbox job: finishes a batch whose claim lapsed. A batch that is done, failed, or claimed by a live attempt is left alone. */
export async function resumeOpenWipCommit(orgId: string, payload: Record<string, unknown>) {
  const batchId = z.string().uuid().parse(payload.batch_id)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("claim_open_wip_commit", { p_org_id: orgId, p_batch_id: batchId, p_actor_id: null, p_allow_failed: false, p_enqueue: false })
  if (error) throw new Error(`Unable to claim the Open-WIP batch: ${error.message}`)
  const claim = parseOpenWipClaim(data)
  if (!claim) return null
  if (!claim.actorId) throw new Error("The interrupted Open-WIP batch has no operator to finish it as; commit it again from the onboarding workbench")
  const [{ data: org, error: orgError }, operatorAccess] = await Promise.all([
    supabase.from("orgs").select("id, product_tier").eq("id", orgId).single(),
    holdsPlatformOnboardingAccess(supabase, claim.actorId),
  ])
  if (orgError || !org) throw new Error("Organization not found")
  // The worker builds homes as the operator who committed the batch, so only while that operator may still run platform onboarding.
  if (!operatorAccess) {
    const { error: releaseError } = await supabase.rpc("release_open_wip_commit", { p_org_id: orgId, p_batch_id: batchId, p_claim_token: claim.token, p_error: "The operator who committed this cutover no longer holds platform onboarding access; its homes are kept. Commit the batch again from the onboarding workbench.", p_fail: true })
    if (releaseError) throw new Error(`Unable to stop the Open-WIP batch: ${releaseError.message}`)
    await completeOutboxJob(claim.jobId)
    return null
  }
  return runOpenWipCommit({ supabase, orgId, userId: claim.actorId, productTier: normalizeProductTier(org.product_tier), platform: true }, batchId, claim)
}

/** The same question requireAnyPlatformPermission(["platform.support.write"]) asks of a signed-in operator, asked of a stored one. */
async function holdsPlatformOnboardingAccess(supabase: SupabaseClient, userId: string) {
  const { data: user, error } = await supabase.from("app_users").select("email").eq("id", userId).maybeSingle()
  if (error) throw new Error(`Unable to load the cutover operator: ${error.message}`)
  if (!user) return false
  if (isPlatformAdminId(userId, user.email)) return true
  return hasPermission("platform.support.write", { userId })
}

/** Hands every lapsed Open-WIP claim back to the outbox; called by the outbox worker before it claims jobs. */
export async function reapStaleOpenWipCommits() {
  const { data, error } = await createServiceSupabaseClient().rpc("reap_stale_open_wip_commits", { p_max_attempts: OPEN_WIP_MAX_COMMIT_ATTEMPTS })
  if (error) throw new Error(`Failed to reap interrupted Open-WIP commits: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  return { resumed: Number(row?.resumed ?? 0), exhausted: Number(row?.exhausted ?? 0) }
}

export async function commitImportBatch(batchId: string, access: ImportAccess = {}) {
  const context = await resolveImportContext(access)
  const { data: candidate, error: candidateError } = await context.supabase.from("import_batches").select("importer, status, error_count").eq("org_id", context.orgId).eq("id", batchId).maybeSingle()
  if (candidateError || !candidate) throw new Error("Import batch not found")
  await requireImporterPermission(candidate.importer as ImporterKey, context)
  // A batch that cannot be committed is refused before it spends the budget (the claim below re-checks it atomically).
  const committable = candidate.importer === "open_wip"
    ? candidate.status !== "committed" && candidate.status !== "parsing"
    : candidate.status === "staged" && Number(candidate.error_count ?? 0) === 0
  if (!committable) throw new Error("Batch must be staged with all errors fixed or explicitly skipped")
  await enforceMutationRateLimit("import_commit", context.orgId)
  if (candidate.importer === "open_wip") return commitOpenWipBatch(context, batchId)
  const { data: claimed, error: claimError } = await context.supabase.from("import_batches").update({ status: "committing" }).eq("org_id", context.orgId).eq("id", batchId).eq("importer", candidate.importer).eq("status", "staged").eq("error_count", 0).select("*").maybeSingle()
  if (claimError || !claimed) throw new Error("Batch must be staged with all errors fixed or explicitly skipped")
  const importer = claimed.importer as ImporterKey
  try {
    const rows = await loadImportCommitRows(context, [batchId])
    const fileKind = typeof claimed.context?.file_kind === "string" ? claimed.context.file_kind : ""
    let results: Map<string, { id: string; action: string }>
    if (importer === "cost_codes") results = await commitCostCodes(rows, context, claimed.update_existing)
    else if (importer === "plan_library") results = await commitPlans(rows, context, claimed.update_existing, fileKind)
    else if (importer === "option_catalog") results = await commitOptions(rows, context, claimed.update_existing)
    else if (importer === "price_book") results = await commitPriceBook(rows, context)
    else if (importer === "communities_lots") results = await commitCommunitiesLots(rows, context, claimed.update_existing)
    else if (importer === "team") results = await commitTeam(rows, context)
    else if (importer === "warranty_homes") results = await commitInstalledHomes(rows, context, batchId)
    else if (isCutoverImporter(importer)) results = await commitCutoverRows(importer, rows, context, batchId, claimed.context ?? {})
    else throw new Error(`${importer} batches are committed by their own path`)
    for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
      const chunk = rows.slice(index, index + INSERT_CHUNK)
      const savedRows = await mapWithConcurrency(chunk, IMPORT_ROW_WRITE_CONCURRENCY, async (row) => {
        const result = results.get(row.id)
        if (!result) throw new Error(`No commit result for import row ${row.row_number}`)
        return context.supabase.from("import_rows").update({ status: result.action === "skipped_existing" ? "skipped" : "committed", target_entity_type: importer, target_entity_id: result.id, action: result.action }).eq("org_id", context.orgId).eq("id", row.id)
      })
      const failedRow = savedRows.find((result) => result.error)
      if (failedRow?.error) throw new Error(`Failed to save import row results: ${failedRow.error.message}`)
    }
    const actions = [...results.values()].reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.action]: (counts[result.action] ?? 0) + 1 }), {})
    const committedCount = (actions.created ?? 0) + (actions.updated ?? 0)
    const skippedCount = (actions.skipped_existing ?? 0) + Number(claimed.skipped_count ?? 0)
    const committedAt = new Date().toISOString()
    const reconciliation = importer === "warranty_homes" ? await reconcileInstalledWarrantyHomes(context, batchId) : null
    const { data: saved, error: saveError } = await context.supabase.from("import_batches").update({ status: "committed", committed_count: committedCount, skipped_count: skippedCount, committed_at: committedAt, report: { ...(claimed.report ?? {}), actions, ...(reconciliation ? { reconciliation: { homes: reconciliation.homes, covered: reconciliation.covered, active: reconciliation.active, expired: reconciliation.expired, exception_count: reconciliation.exceptionCount, clean: reconciliation.clean } } : {}) } }).eq("org_id", context.orgId).eq("id", batchId).select("*").single()
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
