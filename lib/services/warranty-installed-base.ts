import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readAllRows } from "@/lib/land/paging"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { agreementWriteAllowed } from "@/lib/services/price-book"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { normalizeKey, type ImportIssue, type ImportParsedRow } from "@/lib/services/import-parsers"
import { ensureWarrantyDefaults } from "@/lib/services/warranty-operations"
import { enrollSystemWarrantyCoverage } from "@/lib/services/warranty-enrollment"
import { loadWarrantyOrgTimeZone } from "@/lib/services/warranty-time-zone"
import { resolveWarrantyTimeZone } from "@/lib/services/warranty/visit-time"
import { classifyCoverage, installedHomeTermsSchema, resolveInstalledHomeTerms, type ClosedHomeRow, type CoverageException } from "@/lib/services/warranty/installed-base"

/** Closed homes read by one reconciliation; past this it says so rather than reporting a partial set as the whole. */
const RECONCILIATION_CAP = 20_000
const EXCEPTIONS_SHOWN = 200
const CHUNK = 200

interface ImportContext { supabase: SupabaseClient; orgId: string; userId: string; platform: boolean }
interface StagedRow { id: string; row_number: number; parsed: ImportParsedRow; issues: ImportIssue[]; status: string }

const termSchema = z.object({ key: z.string(), label: z.string(), duration_months: z.number().int(), is_structural: z.boolean(), description: z.string().nullable(), sort_order: z.number().int() })
const programRowSchema = z.object({ id: z.string().uuid(), name: z.string(), is_default: z.boolean(), terms: z.array(termSchema) })
const communityRowSchema = z.object({ id: z.string().uuid(), division_id: z.string().uuid().nullable(), time_zone: z.string().nullable() })
const lotRowSchema = z.object({ id: z.string().uuid(), community_id: z.string().uuid(), lot_number: z.string(), block: z.string().nullable(), project_id: z.string().uuid().nullable(), status: z.string() })
const closedRowSchema = z.object({ project_id: z.string().uuid(), actual_date: z.string() })
const coverageRowSchema = z.object({ project_id: z.string().uuid() })

function chunks<T>(items: readonly T[], size = CHUNK) {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

function todayIn(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

function lotKey(communityId: string, lotNumber: unknown, block: unknown) {
  return `${communityId}|${normalizeKey(lotNumber)}|${normalizeKey(block)}`
}

async function readPaged<Row>(label: string, read: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>) {
  const result = await readAllRows(read, { cap: RECONCILIATION_CAP, label })
  if (result.truncated) throw new Error(`${label}: more than ${RECONCILIATION_CAP} rows`)
  return result.rows
}

/**
 * Staging checks for a "Homes under warranty" file: the program and terms each
 * home was sold with, the lot it names, and whether Arc already knows the home.
 * A home already enrolled is a warning (it is matched, never enrolled twice); a
 * home Arc holds as open, or closed on another date, is an error.
 */
export async function validateInstalledHomeRows<Row extends StagedRow>(rows: Row[], context: ImportContext): Promise<Row[]> {
  await ensureWarrantyDefaults(context.orgId)
  const communityIds = [...new Set(rows.flatMap(row => (typeof row.parsed.community_id === "string" ? [row.parsed.community_id] : [])))]
  const [programs, orgZone, access, communities] = await Promise.all([
    readPaged("Failed to read warranty programs", (from, to) => context.supabase.from("warranty_programs")
      .select("id,name,is_default,terms:warranty_coverage_terms(key,label,duration_months,is_structural,description,sort_order)").eq("org_id", context.orgId).eq("is_active", true).order("id").range(from, to)),
    loadWarrantyOrgTimeZone(context.supabase, context.orgId),
    context.platform ? Promise.resolve({ assignedOnly: false, divisionIds: [] as string[] }) : getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
    Promise.all(chunks(communityIds).map(ids => context.supabase.from("communities").select("id,division_id,time_zone").eq("org_id", context.orgId).in("id", ids)))
      .then(results => results.flatMap(result => { if (result.error) throw new Error(`Failed to read communities: ${result.error.message}`); return z.array(communityRowSchema).parse(result.data) })),
  ])
  const programList = z.array(programRowSchema).parse(programs)
  const programByName = new Map(programList.map(program => [normalizeKey(program.name), program]))
  const defaultProgram = programList.find(program => program.is_default)
  const communityById = new Map(communities.map(community => [community.id, community]))

  const lotResults = await Promise.all(chunks(communityIds).map(ids => readPaged("Failed to read lots", (from, to) => context.supabase.from("lots")
    .select("id,community_id,lot_number,block,project_id,status").eq("org_id", context.orgId).in("community_id", ids).order("id").range(from, to))))
  const lots = new Map(z.array(lotRowSchema).parse(lotResults.flat()).map(lot => [lotKey(lot.community_id, lot.lot_number, lot.block), lot]))
  const projectIds = [...new Set([...lots.values()].flatMap(lot => (lot.project_id ? [lot.project_id] : [])))]
  const [closedResults, coverageResults] = await Promise.all([
    Promise.all(chunks(projectIds).map(ids => context.supabase.from("closings").select("project_id,actual_date").eq("org_id", context.orgId).eq("status", "closed").in("project_id", ids))),
    Promise.all(chunks(projectIds).map(ids => context.supabase.from("project_warranty_coverage").select("project_id").eq("org_id", context.orgId).is("voided_at", null).in("project_id", ids))),
  ])
  for (const result of [...closedResults, ...coverageResults]) if (result.error) throw new Error(`Failed to read installed homes: ${result.error.message}`)
  const closedOn = new Map(z.array(closedRowSchema).parse(closedResults.flatMap(result => result.data ?? [])).map(row => [row.project_id, row.actual_date]))
  const covered = new Set(z.array(coverageRowSchema).parse(coverageResults.flatMap(result => result.data ?? [])).map(row => row.project_id))

  for (const row of rows) {
    if (row.status === "skipped") continue
    const parsed = row.parsed
    const add = (issue: ImportIssue) => { row.issues.push(issue) }
    const communityId = typeof parsed.community_id === "string" ? parsed.community_id : null
    const community = communityId ? communityById.get(communityId) : undefined
    if (!community) continue
    if (!agreementWriteAllowed(access, { divisionId: null, communityId: community.id, communityDivisionId: community.division_id })) {
      add({ level: "error", code: "outside_division", message: "This community is outside your divisions", column: "community" })
      continue
    }
    const named = typeof parsed.program === "string" && parsed.program ? programByName.get(normalizeKey(parsed.program)) : undefined
    if (typeof parsed.program === "string" && parsed.program && !named) add({ level: "error", code: "unresolved_program", message: `Warranty program ${parsed.program} was not found`, column: "program" })
    const program = named ?? defaultProgram
    const num = (key: string) => (typeof parsed[key] === "number" ? Number(parsed[key]) : null)
    const resolved = resolveInstalledHomeTerms({
      programTerms: named ? [...named.terms].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key)).map(({ sort_order: _order, ...term }) => term) : null,
      explicit: { workmanship_months: num("workmanship_months"), systems_months: num("systems_months"), structural_months: num("structural_months") },
    })
    if ("terms" in resolved) {
      if (program) { parsed.program_id = program.id; parsed.terms_json = JSON.stringify(resolved.terms) }
      else if (!named) add({ level: "error", code: "no_default_program", message: "Set a default warranty program before importing homes", column: "program" })
    } else if ("error" in resolved && !row.issues.some(issue => issue.code === "terms_required" || issue.code === "invalid_term_months")) add({ level: "error", code: "invalid_terms", message: resolved.error, column: "program" })
    if (typeof parsed.closing_date === "string" && parsed.closing_date > todayIn(resolveWarrantyTimeZone(community.time_zone, orgZone))) {
      add({ level: "error", code: "closing_in_future", message: "A home under warranty has already closed; the date is in the future", column: "closing_date" })
    }
    const lot = lots.get(lotKey(community.id, parsed.lot_number, parsed.block))
    if (lot?.status === "controlled" && !lot.project_id) add({ level: "error", code: "lot_not_owned", message: "This lot is still controlled land and cannot have a closed home", column: "lot_number" })
    if (lot?.project_id) {
      const actual = closedOn.get(lot.project_id)
      if (!actual) add({ level: "error", code: "home_not_closed", message: "Arc already holds an open home on this lot; record its closing in Arc", column: "lot_number" })
      else if (actual !== parsed.closing_date) add({ level: "error", code: "closing_date_conflict", message: `Arc recorded this home as closed on ${actual}`, column: "closing_date" })
      else if (covered.has(lot.project_id)) add({ level: "warning", code: "already_enrolled", message: "Already enrolled; matched and left as it is" })
    }
    row.status = row.issues.some(issue => issue.level === "error") ? "error" : row.issues.some(issue => issue.level === "warning") ? "warning" : "valid"
  }
  return rows
}

/**
 * Records each closed home and enrolls its coverage from the row's closing date
 * and terms, through the same enrollment the settlement path uses. Everything is
 * matched by lot, so a re-run (or a retry after a failure part-way) finds what
 * exists and enrolls nothing twice.
 */
export async function commitInstalledHomes(rows: Array<StagedRow & { id: string }>, context: ImportContext, batchId: string) {
  if (!context.platform) await requirePermission("warranty.manage", context)
  const access = context.platform ? { assignedOnly: false, divisionIds: [] as string[] } : await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (access.assignedOnly) {
    const ids = [...new Set(rows.flatMap(row => (typeof row.parsed.community_id === "string" ? [row.parsed.community_id] : [])))]
    const divisions = new Map<string, string | null>()
    for (const group of chunks(ids)) {
      const { data, error } = await context.supabase.from("communities").select("id,division_id").eq("org_id", context.orgId).in("id", group)
      if (error) throw new Error(`Failed to check the communities' divisions: ${error.message}`)
      for (const community of data ?? []) divisions.set(community.id, community.division_id ?? null)
    }
    const outside = rows.filter(row => !agreementWriteAllowed(access, { divisionId: null, communityId: String(row.parsed.community_id), communityDivisionId: divisions.get(String(row.parsed.community_id)) ?? null }))
    if (outside.length > 0) throw new Error(`Rows ${outside.slice(0, 5).map(row => row.row_number).join(", ")} are outside your divisions. Nothing was imported.`)
  }
  const results = new Map<string, { id: string; action: string }>()
  for (const row of rows) {
    const parsed = row.parsed
    const terms = installedHomeTermsSchema.parse(JSON.parse(String(parsed.terms_json)))
    const placed = await context.supabase.rpc("import_installed_warranty_home", {
      p_org_id: context.orgId, p_actor_id: context.userId, p_batch_id: batchId,
      p_row: { community_id: parsed.community_id, lot_number: parsed.lot_number, block: parsed.block, address: parsed.address, buyer_name: parsed.buyer_name, buyer_email: parsed.buyer_email, closing_date: parsed.closing_date },
    })
    if (placed.error) throw new Error(`Row ${row.row_number}: ${placed.error.message}`)
    const home = z.object({ projectId: z.string().uuid(), created: z.boolean() }).parse(placed.data)
    const enrollment = await enrollSystemWarrantyCoverage(context.supabase, { orgId: context.orgId, projectId: home.projectId, effectiveDate: String(parsed.closing_date), source: "closing" },
      () => ensureWarrantyDefaults(context.orgId), { programId: String(parsed.program_id), terms })
    results.set(row.id, { id: home.projectId, action: home.created || enrollment.enrolled ? "created" : "skipped_existing" })
  }
  return results
}

export interface WarrantyCoverageReconciliation {
  scope: "batch" | "org"
  asOf: string
  homes: number
  covered: number
  active: number
  expired: number
  exceptionCount: number
  exceptions: Array<CoverageException & { home: string }>
  clean: boolean
}

/**
 * Every closed home against its coverage: counts, active versus expired, and
 * the homes left uncovered, covered twice or whose coverage dates disagree with
 * closing plus term. `batchId` limits it to the homes one import recorded.
 */
export async function reconcileInstalledWarrantyHomes(context: { supabase: SupabaseClient; orgId: string; userId: string; platform?: boolean }, batchId?: string): Promise<WarrantyCoverageReconciliation> {
  const [orgZone, access] = await Promise.all([loadWarrantyOrgTimeZone(context.supabase, context.orgId), context.platform ? Promise.resolve({ assignedOnly: false, divisionIds: [] as string[] }) : getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })])
  const closings = await readPaged("Failed to read closed homes", (from, to) => {
    let query = context.supabase.from("closings").select("project_id,lot_id,actual_date,project:projects!inner(division_id)").eq("org_id", context.orgId).eq("status", "closed").not("actual_date", "is", null)
    if (batchId) query = query.eq("metadata->>import_batch_id", batchId)
    if (access.assignedOnly) query = query.in("project.division_id", access.divisionIds)
    return query.order("project_id").range(from, to)
  })
  const homes = z.array(z.object({ project_id: z.string().uuid(), lot_id: z.string().uuid().nullable(), actual_date: z.string() })).parse(closings.map(row => ({ project_id: row.project_id, lot_id: row.lot_id, actual_date: row.actual_date })))
  const coverageResults = await Promise.all(chunks(homes.map(home => home.project_id)).map(ids => context.supabase.from("project_warranty_coverage")
    .select("project_id,effective_date,terms_snapshot").eq("org_id", context.orgId).is("voided_at", null).in("project_id", ids)))
  const coverageRows = coverageResults.flatMap(result => { if (result.error) throw new Error(`Failed to read warranty coverage: ${result.error.message}`); return result.data ?? [] })
  const parsedCoverage = z.array(z.object({ project_id: z.string().uuid(), effective_date: z.string(), terms_snapshot: z.array(z.object({ key: z.string(), duration_months: z.number().int(), expires_on: z.string() })) })).parse(coverageRows)
  const coverageByProject = new Map<string, ClosedHomeRow["coverage"][number][]>()
  for (const row of parsedCoverage) coverageByProject.set(row.project_id, [...(coverageByProject.get(row.project_id) ?? []), { projectId: row.project_id, effectiveDate: row.effective_date, terms: row.terms_snapshot }])
  const lotIds = [...new Set(homes.flatMap(home => (home.lot_id ? [home.lot_id] : [])))]
  const lotResults = await Promise.all(chunks(lotIds).map(ids => context.supabase.from("lots").select("id,community_id,lot_number,block").eq("org_id", context.orgId).in("id", ids)))
  const lotKeys = new Map(lotResults.flatMap(result => { if (result.error) throw new Error(`Failed to read lots: ${result.error.message}`); return z.array(lotRowSchema.pick({ id: true, community_id: true, lot_number: true, block: true })).parse(result.data) })
    .map(lot => [lot.id, lotKey(lot.community_id, lot.lot_number, lot.block)]))
  const asOf = todayIn(orgZone)
  const result = classifyCoverage(homes.map(home => ({ projectId: home.project_id, lotId: home.lot_id, lotKey: home.lot_id ? lotKeys.get(home.lot_id) : undefined, closedOn: home.actual_date, coverage: coverageByProject.get(home.project_id) ?? [] })), asOf)
  const shown = result.exceptions.slice(0, EXCEPTIONS_SHOWN)
  const names = new Map<string, string>()
  for (const group of chunks([...new Set(shown.map(item => item.projectId))])) {
    const { data, error } = await context.supabase.from("projects").select("id,name").eq("org_id", context.orgId).in("id", group)
    if (error) throw new Error(`Failed to read home names: ${error.message}`)
    for (const project of data ?? []) names.set(project.id, project.name)
  }
  return {
    scope: batchId ? "batch" : "org", asOf, homes: result.homes, covered: result.covered, active: result.active, expired: result.expired,
    exceptionCount: result.exceptions.length, exceptions: shown.map(item => ({ ...item, home: names.get(item.projectId) ?? item.projectId })), clean: result.exceptions.length === 0,
  }
}

/** The on-demand report: every closed home the signed-in member may see. */
export async function getWarrantyInstalledBaseReconciliation(batchId?: string) {
  const context = await requireOrgContext()
  await requirePermission("warranty.manage", context)
  return reconcileInstalledWarrantyHomes({ supabase: createServiceSupabaseClient(), orgId: context.orgId, userId: context.userId }, batchId ? z.string().uuid().parse(batchId) : undefined)
}
