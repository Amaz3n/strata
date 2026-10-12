import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { readAllRowsById } from "@/lib/land/paging"
import {
  buildRevisionSet,
  describeRevisionSet,
  diffRevisionSets,
  productRevisionSetSchema,
  REVISION_HISTORY_CAP,
  revisionAsOf,
  type ProductRevisionSet,
  type RevisionChange,
  type RevisionRef,
} from "@/lib/plans/product-revisions"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type HomeProductRevisionStage = "agreement" | "release"

/** One home's selections. Past this the capture fails rather than recording part of the house. */
const SELECTION_ROW_CAP = 5_000
const LIVE_SELECTION_STATUSES = ["confirmed", "ordered", "received"]
const ID_CHUNK = 100

/** The parts of a purchase agreement's configuration a record reads. */
const agreementConfigurationSchema = z.object({
  purchase_agreement: z.object({
    configuration: z.object({
      house_plan_version_id: z.string().nullable().optional(),
      elevation_id: z.string().nullable().optional(),
      option_items: z.array(z.object({ optionId: z.string().optional(), packageId: z.string().optional() })).default([]),
    }),
  }),
})

const recordRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  contract_id: z.string().nullable(),
  stage: z.enum(["agreement", "release"]),
  revisions: productRevisionSetSchema,
  as_of: z.string(),
  captured_at: z.string(),
})

const RECORD_COLUMNS = "id,project_id,contract_id,stage,revisions,as_of,captured_at"

export type HomeProductRevisionsDto = {
  id: string
  projectId: string
  contractId: string | null
  stage: HomeProductRevisionStage
  revisions: ProductRevisionSet
  asOf: string
  capturedAt: string
}

function mapRecord(row: unknown): HomeProductRevisionsDto {
  const parsed = recordRowSchema.parse(row)
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    contractId: parsed.contract_id,
    stage: parsed.stage,
    revisions: parsed.revisions,
    asOf: parsed.as_of,
    capturedAt: parsed.captured_at,
  }
}

function chunks(ids: readonly string[]) {
  const unique = [...new Set(ids)]
  const out: string[][] = []
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) out.push(unique.slice(offset, offset + ID_CHUNK))
  return out
}

type RevisionTable = "house_plan_elevations" | "selection_options" | "selection_packages"

/** Today's revision of each id; an id no longer in the catalog is absent. */
async function currentRevisions(supabase: SupabaseClient, orgId: string, table: RevisionTable, ids: readonly string[]) {
  const revisions = new Map<string, { revision: number; code: string | null }>()
  for (const chunk of chunks(ids)) {
    const { data, error } = await supabase.from(table).select(table === "house_plan_elevations" ? "id,revision,code" : "id,revision")
      .eq("org_id", orgId).in("id", chunk).returns<Array<{ id: string; revision: number; code?: string }>>()
    if (error) throw new Error(`Failed to read current revisions: ${error.message}`)
    for (const row of data ?? []) revisions.set(row.id, { revision: Number(row.revision), code: row.code ?? null })
  }
  return revisions
}

/** The append-only revision history of each id, up to `upTo`. */
async function readRevisionHistory(supabase: SupabaseClient, orgId: string, ids: readonly string[], upTo: string) {
  const history: Array<{ entityId: string; revision: number; createdAt: string }> = []
  for (const chunk of chunks(ids)) {
    const rows = await readAllRowsById<{ id: string; entity_id: string; revision: number; created_at: string }>((afterId, limit) => {
      let query = supabase.from("product_definition_revisions").select("id,entity_id,revision,created_at")
        .eq("org_id", orgId).in("entity_id", chunk).lte("created_at", upTo)
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<Array<{ id: string; entity_id: string; revision: number; created_at: string }>>()
    }, { cap: 50_000, label: "Failed to read product revision history", pageSize: 1000 })
    history.push(...rows.map((row) => ({ entityId: row.entity_id, revision: Number(row.revision), createdAt: row.created_at })))
  }
  return history
}

/**
 * Record what a production home was sold against (`agreement`, once its
 * purchase agreement is executed) or released against (`release`, once its
 * start package publishes). Runs as an effect of those transitions, which have
 * already authorized their actor, so it writes with the service role. Each
 * stage is captured once: a re-run finds the row and changes nothing, and a
 * later edit to the plan, an elevation or an option never reaches it.
 *
 * A sale is recorded as it was priced: the agreement's own configuration, at
 * the revisions current when the agreement was created (the quote was fenced
 * against the catalog until then). A release is recorded as it is built: the
 * lot's pinned version and elevation and the home's live selections, each at
 * the revision it was chosen at — the option revision the selection recorded,
 * the package's revision when it was picked. A selection older than that record
 * falls back to today's revision and the ref says so (`inferred`).
 */
export async function captureHomeProductRevisions(input: {
  orgId: string
  projectId: string
  stage: HomeProductRevisionStage
  actorId?: string | null
}): Promise<HomeProductRevisionsDto | null> {
  const supabase = createServiceSupabaseClient()
  const { orgId, projectId, stage } = input
  const fail = (message: string) => new Error(`Failed to record the home's ${stage} product revisions: ${message}`)

  const [lotResult, contractResult] = await Promise.all([
    supabase.from("lots").select("house_plan_version_id,house_plan_elevation_id").eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    supabase.from("contracts").select("id,created_at,snapshot")
      .eq("org_id", orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").eq("status", "active")
      .order("signed_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
  ])
  if (lotResult.error) throw fail(lotResult.error.message)
  if (contractResult.error) throw fail(contractResult.error.message)
  const contract = contractResult.data
  if (stage === "agreement" && !contract) throw fail("the home has no executed purchase agreement")

  const recorded = () => {
    const query = supabase.from("home_product_revisions").select(RECORD_COLUMNS).eq("org_id", orgId).eq("project_id", projectId).eq("stage", stage)
    return stage === "agreement" && contract ? query.eq("contract_id", contract.id).maybeSingle() : query.maybeSingle()
  }
  const { data: existing, error: existingError } = await recorded()
  if (existingError) throw fail(existingError.message)
  if (existing) return mapRecord(existing)

  let versionId: string | null
  let elevationId: string | null
  let options: RevisionRef[]
  let packages: RevisionRef[]
  let asOf: string
  let soldElevationRevision: number | null = null
  if (stage === "agreement" && contract) {
    const configuration = agreementConfigurationSchema.safeParse(contract.snapshot)
    // An agreement made before Arc recorded configurations (an imported or older
    // one) has nothing to record; signing it must not fail for that.
    if (!configuration.success) return null
    const signed = configuration.data.purchase_agreement.configuration
    versionId = signed.house_plan_version_id ?? null
    elevationId = signed.elevation_id ?? null
    asOf = contract.created_at
    const optionIds = signed.option_items.flatMap((item) => (item.optionId ? [item.optionId] : []))
    const packageIds = signed.option_items.flatMap((item) => (item.packageId ? [item.packageId] : []))
    const history = await readRevisionHistory(supabase, orgId, [...(elevationId ? [elevationId] : []), ...optionIds, ...packageIds], asOf)
    options = optionIds.map((id) => ({ id, revision: revisionAsOf(history, id, asOf) }))
    packages = packageIds.map((id) => ({ id, revision: revisionAsOf(history, id, asOf) }))
    soldElevationRevision = elevationId ? revisionAsOf(history, elevationId, asOf) : null
  } else {
    type SelectionRow = { id: string; selected_option_id: string | null; selected_option_revision: number | null; package_id: string | null; selected_at: string | null }
    const selections = await readAllRowsById<SelectionRow>((afterId, limit) => {
      let query = supabase.from("project_selections").select("id,selected_option_id,selected_option_revision,package_id,selected_at")
        .eq("org_id", orgId).eq("project_id", projectId).in("status", LIVE_SELECTION_STATUSES)
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<SelectionRow[]>()
    }, { cap: SELECTION_ROW_CAP, label: "Failed to read the home's selections", pageSize: 1000 })
    versionId = lotResult.data?.house_plan_version_id ?? null
    elevationId = lotResult.data?.house_plan_elevation_id ?? null
    asOf = new Date().toISOString()
    // Options carry the revision the selection recorded; a package has no such
    // column, so its revision is read from the history as of the pick.
    const unrecordedOptionIds = selections.flatMap((row) => (row.selected_option_id && row.selected_option_revision == null ? [row.selected_option_id] : []))
    const pickedPackages = selections.flatMap((row) => (row.package_id ? [{ id: row.package_id, at: row.selected_at ?? asOf }] : []))
    const [currentOptions, currentPackages, packageHistory] = await Promise.all([
      currentRevisions(supabase, orgId, "selection_options", unrecordedOptionIds),
      currentRevisions(supabase, orgId, "selection_packages", pickedPackages.map((pick) => pick.id)),
      readRevisionHistory(supabase, orgId, pickedPackages.map((pick) => pick.id), asOf),
    ])
    options = selections.flatMap((row): RevisionRef[] => {
      if (!row.selected_option_id) return []
      if (row.selected_option_revision != null) return [{ id: row.selected_option_id, revision: Number(row.selected_option_revision) }]
      return [{ id: row.selected_option_id, revision: currentOptions.get(row.selected_option_id)?.revision ?? null, inferred: true }]
    })
    packages = pickedPackages.map((pick): RevisionRef => {
      const picked = revisionAsOf(packageHistory, pick.id, pick.at)
      return picked != null ? { id: pick.id, revision: picked } : { id: pick.id, revision: currentPackages.get(pick.id)?.revision ?? null, inferred: true }
    })
  }

  const [versionResult, elevations] = await Promise.all([
    versionId
      ? supabase.from("house_plan_versions").select("id,version_number").eq("org_id", orgId).eq("id", versionId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    currentRevisions(supabase, orgId, "house_plan_elevations", elevationId ? [elevationId] : []),
  ])
  if (versionResult.error) throw fail(versionResult.error.message)

  const set = buildRevisionSet({
    planVersion: versionId ? { id: versionId, number: versionResult.data?.version_number == null ? null : Number(versionResult.data.version_number) } : null,
    elevation: elevationId
      ? { id: elevationId, code: elevations.get(elevationId)?.code ?? null, revision: stage === "agreement" ? soldElevationRevision : elevations.get(elevationId)?.revision ?? null }
      : null,
    options,
    packages,
  })

  const row = {
    org_id: orgId,
    project_id: projectId,
    contract_id: contract?.id ?? null,
    stage,
    house_plan_version_id: set.planVersion?.id ?? null,
    plan_version_number: set.planVersion?.number ?? null,
    elevation_id: set.elevation?.id ?? null,
    elevation_revision: set.elevation?.revision ?? null,
    revisions: set,
    as_of: asOf,
    captured_at: new Date().toISOString(),
    captured_by: input.actorId ?? null,
  }
  const { data: inserted, error: insertError } = await supabase.from("home_product_revisions").insert(row).select(RECORD_COLUMNS).single()
  if (insertError?.code === "23505") {
    // A concurrent capture of the same stage won; its row is the record.
    const { data: winner, error: winnerError } = await recorded()
    if (winnerError || !winner) throw fail(winnerError?.message ?? "the concurrent capture is not readable")
    return mapRecord(winner)
  }
  if (insertError || !inserted) throw fail(insertError?.message ?? "no row was written")
  const record = mapRecord(inserted)

  await Promise.all([
    recordEvent({
      orgId, actorId: input.actorId ?? null, eventType: "home_product_revisions_captured", entityType: "project", entityId: projectId,
      payload: { stage, record_id: record.id, house_plan_version_id: row.house_plan_version_id, plan_version_number: row.plan_version_number, items: set.options.length + set.packages.length },
    }),
    recordAudit({
      orgId, actorId: input.actorId ?? undefined, action: "insert", entityType: "home_product_revisions", entityId: record.id,
      after: { ...row, id: record.id }, source: `home_product_revisions.${stage}`,
    }),
  ])
  return record
}

export type HomeProductRevisionStatus = {
  stage: HomeProductRevisionStage
  summary: string
  revisions: ProductRevisionSet
  changes: RevisionChange[]
}

/**
 * A home's record (the release record, else its newest sale) against today's
 * revisions of the same plan, elevation and items. Read with the caller's
 * client, which has already authorized the home.
 */
export async function readHomeProductRevisionStatus(supabase: SupabaseClient, orgId: string, projectId: string): Promise<HomeProductRevisionStatus | null> {
  const { data, error } = await supabase.from("home_product_revisions").select(RECORD_COLUMNS)
    .eq("org_id", orgId).eq("project_id", projectId).order("captured_at", { ascending: false }).limit(20)
  if (error) throw new Error(`Unable to read this home's product revisions: ${error.message}`)
  const records = (data ?? []).map(mapRecord)
  const record = records.find((row) => row.stage === "release") ?? records[0]
  if (!record) return null
  const recorded = record.revisions

  const [lotResult, elevations, options, packages] = await Promise.all([
    supabase.from("lots").select("house_plan_version_id,house_plan_elevation_id,version:house_plan_versions(version_number)")
      .eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    currentRevisions(supabase, orgId, "house_plan_elevations", recorded.elevation ? [recorded.elevation.id] : []),
    currentRevisions(supabase, orgId, "selection_options", recorded.options.map((ref) => ref.id)),
    currentRevisions(supabase, orgId, "selection_packages", recorded.packages.map((ref) => ref.id)),
  ])
  if (lotResult.error) throw new Error(`Unable to read this home's plan: ${lotResult.error.message}`)
  const lot = lotResult.data
  const version = Array.isArray(lot?.version) ? lot.version[0] : lot?.version
  const currentElevationId = lot?.house_plan_elevation_id ?? null
  const currentElevation = currentElevationId === recorded.elevation?.id
    ? elevations.get(currentElevationId ?? "")
    : currentElevationId ? (await currentRevisions(supabase, orgId, "house_plan_elevations", [currentElevationId])).get(currentElevationId) : undefined
  const current = buildRevisionSet({
    planVersion: lot?.house_plan_version_id ? { id: lot.house_plan_version_id, number: version?.version_number == null ? null : Number(version.version_number) } : null,
    elevation: currentElevationId ? { id: currentElevationId, code: currentElevation?.code ?? null, revision: currentElevation?.revision ?? null } : null,
    options: recorded.options.flatMap((ref) => {
      const now = options.get(ref.id)
      return now ? [{ id: ref.id, revision: now.revision }] : []
    }),
    packages: recorded.packages.flatMap((ref) => {
      const now = packages.get(ref.id)
      return now ? [{ id: ref.id, revision: now.revision }] : []
    }),
  })
  return { stage: record.stage, summary: describeRevisionSet(recorded), revisions: recorded, changes: diffRevisionSets(recorded, current) }
}

export type ProductDefinitionRevisionDto = {
  revision: number
  createdAt: string
  snapshot: Record<string, unknown>
}

/** An elevation's, option's or package's revisions, newest first. Capped; a definition edited more than this shows its latest. */
export async function listProductDefinitionHistory(
  input: { entityType: "house_plan_elevation" | "selection_option" | "selection_package"; entityId: string },
  orgId?: string,
): Promise<ProductDefinitionRevisionDto[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission(input.entityType === "house_plan_elevation" ? "plan.read" : "selections.read", context)
  const { data, error } = await context.supabase.from("product_definition_revisions").select("revision,created_at,snapshot")
    .eq("org_id", context.orgId).eq("entity_type", input.entityType).eq("entity_id", input.entityId)
    .order("revision", { ascending: false }).limit(REVISION_HISTORY_CAP)
  if (error) throw new Error(`Unable to read revision history: ${error.message}`)
  return z.array(z.object({ revision: z.number().int(), created_at: z.string(), snapshot: z.record(z.string(), z.unknown()) })).parse(data ?? [])
    .map((row) => ({ revision: row.revision, createdAt: row.created_at, snapshot: row.snapshot }))
}
