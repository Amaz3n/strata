import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { readAllRows, type RangeResult } from "@/lib/land/paging"
import { classifyAffectedHome, type AgreementStanding } from "@/lib/plans/plan-change-impact"
import {
  orderProductChangeHomes,
  PRODUCT_CHANGE_HOME_CAP,
  productChangeImpactInputSchema,
  recordedRevisionOf,
  summarizeProductChangeImpact,
  type ProductChangeEntity,
  type ProductChangeHome,
  type ProductChangeImpactInput,
  type ProductChangeImpactSummary,
} from "@/lib/plans/product-change-impact"
import { productRevisionSetSchema } from "@/lib/plans/product-revisions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

/**
 * Which homes an elevation or catalog option edit reaches, read before the edit
 * is saved: every lot pinned to the elevation, every home with the option
 * selected, and every home whose sale or release recorded either — by state,
 * with the revision each was sold and released at. Read-only, and narrowed to
 * the reader's divisions like the desks.
 */

export type ProductChangeImpactDto = ProductChangeImpactSummary & {
  entity: ProductChangeEntity
  id: string
  label: string
  revision: number
  isActive: boolean
  homes: ProductChangeHome[]
  /** True when there were more homes than the list carries. */
  truncated: boolean
}

const ID_CHUNK = 100

const recordSchema = z.object({
  project_id: z.string(),
  stage: z.enum(["agreement", "release"]),
  revisions: productRevisionSetSchema,
})

type LotRow = { id: string; lot_number: string; block: string | null; community_id: string; project_id: string | null; division_id: string | null }
type ProjectRow = { id: string; name: string; client_id: string | null; division_id: string | null }

const LOT_COLUMNS = "id, lot_number, block, community_id, project_id, division_id"

function chunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)]
  const out: string[][] = []
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) out.push(unique.slice(offset, offset + ID_CHUNK))
  return out
}

async function readByIds<Row>(ids: readonly string[], read: (chunk: string[]) => PromiseLike<RangeResult<Row>>, label: string): Promise<Row[]> {
  const results = await Promise.all(chunks(ids).map(async (chunk) => {
    const { data, error } = await read(chunk)
    if (error) throw new Error(`${label}: ${error.message}`)
    return data ?? []
  }))
  return results.flat()
}

async function readCapped<Row>(read: (from: number, to: number) => PromiseLike<RangeResult<Row>>, label: string) {
  return readAllRows(read, { cap: PRODUCT_CHANGE_HOME_CAP, label })
}

async function readDefinition(supabase: SupabaseClient, orgId: string, entity: ProductChangeEntity, id: string) {
  if (entity === "elevation") {
    const { data, error } = await supabase.from("house_plan_elevations").select("id, code, name, revision, is_active")
      .eq("org_id", orgId).eq("id", id).maybeSingle()
    if (error) throw new Error(`Unable to read the elevation: ${error.message}`)
    if (!data) throw new Error("Elevation not found")
    return { label: `Elevation ${data.code}${data.name ? ` · ${data.name}` : ""}`, revision: Number(data.revision), isActive: data.is_active !== false }
  }
  const { data, error } = await supabase.from("selection_options").select("id, name, revision, is_available")
    .eq("org_id", orgId).eq("id", id).maybeSingle()
  if (error) throw new Error(`Unable to read the option: ${error.message}`)
  if (!data) throw new Error("Option not found")
  return { label: String(data.name), revision: Number(data.revision), isActive: data.is_available !== false }
}

export async function getProductChangeImpact(input: ProductChangeImpactInput, orgId?: string): Promise<ProductChangeImpactDto> {
  const { entity, id } = productChangeImpactInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission(entity === "elevation" ? "plan.read" : "selections.read", context)
  const { supabase } = context
  const scope = context.orgId

  const [definition, access, pinned, selected, records] = await Promise.all([
    readDefinition(supabase, scope, entity, id),
    getDivisionAccessForUser({ orgId: scope, userId: context.userId }),
    entity === "elevation"
      ? readCapped<LotRow>((from, to) => supabase.from("lots").select(LOT_COLUMNS)
          .eq("org_id", scope).eq("house_plan_elevation_id", id).order("id").range(from, to), "Unable to read lots on this elevation")
      : Promise.resolve({ rows: [], truncated: false }),
    entity === "option"
      ? readCapped<{ id: string; project_id: string }>((from, to) => supabase.from("project_selections").select("id, project_id")
          .eq("org_id", scope).eq("selected_option_id", id).order("id").range(from, to), "Unable to read homes with this option")
      : Promise.resolve({ rows: [], truncated: false }),
    readCapped<unknown>((from, to) => {
      const query = supabase.from("home_product_revisions").select("project_id, stage, revisions").eq("org_id", scope)
      const holding = entity === "elevation" ? query.eq("elevation_id", id) : query.contains("revisions", { options: [{ id }] })
      return holding.order("id").range(from, to)
    }, "Unable to read the homes' recorded product"),
  ])
  const recorded = records.rows.map((row) => recordSchema.parse(row))

  const projectIds = [...new Set([
    ...pinned.rows.flatMap((lot) => (lot.project_id ? [lot.project_id] : [])),
    ...selected.rows.map((row) => row.project_id),
    ...recorded.map((row) => row.project_id),
  ])]
  const [projects, homeLots, releases, contracts] = await Promise.all([
    readByIds<ProjectRow>(projectIds, (chunk) => supabase.from("projects").select("id, name, client_id, division_id")
      .eq("org_id", scope).in("id", chunk), "Unable to read homes"),
    readByIds<LotRow>(projectIds, (chunk) => supabase.from("lots").select(LOT_COLUMNS)
      .eq("org_id", scope).in("project_id", chunk), "Unable to read the homes' lots"),
    readByIds<{ project_id: string }>(projectIds, (chunk) => supabase.from("start_packages").select("project_id")
      .eq("org_id", scope).eq("status", "released").in("project_id", chunk), "Unable to read start releases"),
    readByIds<{ project_id: string; status: string; signed_at: string | null }>(projectIds, (chunk) => supabase.from("contracts")
      .select("project_id, status, signed_at").eq("org_id", scope).eq("contract_type", "purchase_agreement")
      .in("status", ["draft", "active"]).in("project_id", chunk), "Unable to read purchase agreements"),
  ])
  const lots = new Map<string, LotRow>()
  const lotByProject = new Map<string, LotRow>()
  for (const lot of [...pinned.rows, ...homeLots]) {
    lots.set(lot.id, lot)
    if (lot.project_id) lotByProject.set(lot.project_id, lot)
  }
  const projectById = new Map(projects.map((project) => [project.id, project]))

  const [communities, buyers] = await Promise.all([
    readByIds<{ id: string; name: string }>([...lots.values()].map((lot) => lot.community_id), (chunk) => supabase.from("communities")
      .select("id, name").eq("org_id", scope).in("id", chunk), "Unable to read communities"),
    readByIds<{ id: string; full_name: string | null }>(projects.flatMap((project) => (project.client_id ? [project.client_id] : [])),
      (chunk) => supabase.from("contacts").select("id, full_name").eq("org_id", scope).in("id", chunk), "Unable to read buyers"),
  ])
  const communityName = new Map(communities.map((row) => [row.id, row.name]))
  const buyerName = new Map(buyers.map((row) => [row.id, row.full_name]))
  const released = new Set(releases.map((row) => row.project_id))
  const agreementByProject = new Map<string, AgreementStanding>()
  for (const contract of contracts) {
    const standing: AgreementStanding = contract.status === "active" || contract.signed_at ? "binding" : "draft"
    if (agreementByProject.get(contract.project_id) !== "binding") agreementByProject.set(contract.project_id, standing)
  }
  const revisionAt = (projectId: string, stage: "agreement" | "release") => {
    // A home re-sold after a cancellation has one record per agreement; the
    // newest revision is the one its live sale holds.
    const found = recorded.filter((row) => row.project_id === projectId && row.stage === stage)
      .map((row) => recordedRevisionOf(row.revisions, entity, id))
      .filter((revision): revision is number | null => revision !== undefined)
    if (found.length === 0) return null
    return found.reduce<number | null>((newest, revision) => (revision !== null && (newest === null || revision > newest) ? revision : newest), null)
  }

  const visible = (divisionId: string | null) => !access.assignedOnly || (divisionId !== null && access.divisionIds.includes(divisionId))
  const homes: ProductChangeHome[] = []
  for (const projectId of projectIds) {
    const project = projectById.get(projectId)
    // A home the reader cannot see (another division, or not readable at all) is left out.
    if (!project) continue
    const lot = lotByProject.get(projectId) ?? null
    if (!visible(lot?.division_id ?? project.division_id)) continue
    homes.push({
      key: projectId,
      lotId: lot?.id ?? null,
      lotLabel: lot ? (lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number) : null,
      communityName: lot ? communityName.get(lot.community_id) ?? null : null,
      projectId,
      projectName: project.name,
      buyerName: project.client_id ? buyerName.get(project.client_id) ?? null : null,
      state: classifyAffectedHome({ hasHome: true, agreement: agreementByProject.get(projectId) ?? "none", startReleased: released.has(projectId) }),
      soldRevision: revisionAt(projectId, "agreement"),
      releasedRevision: revisionAt(projectId, "release"),
    })
  }
  for (const lot of pinned.rows) {
    if (lot.project_id || !visible(lot.division_id)) continue
    homes.push({
      key: lot.id,
      lotId: lot.id,
      lotLabel: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number,
      communityName: communityName.get(lot.community_id) ?? null,
      projectId: null,
      projectName: null,
      buyerName: null,
      state: "unsold",
      soldRevision: null,
      releasedRevision: null,
    })
  }

  const ordered = orderProductChangeHomes(homes)
  return {
    entity,
    id,
    label: definition.label,
    revision: definition.revision,
    isActive: definition.isActive,
    ...summarizeProductChangeImpact(ordered),
    homes: ordered.slice(0, PRODUCT_CHANGE_HOME_CAP),
    truncated: pinned.truncated || selected.truncated || records.truncated || ordered.length > PRODUCT_CHANGE_HOME_CAP,
  }
}

/**
 * Was this home sold on this elevation? True when the purchase agreement it is
 * live under recorded it (`home_product_revisions`, stage `agreement`). An
 * elevation retired after the sale stays buildable for that home — the start
 * gate and plan instantiation ask here before refusing an inactive elevation —
 * while a home not sold on it (a spec home, or a sale of another elevation)
 * cannot be started or sold on it. Read with whichever client the caller holds.
 */
export async function isElevationKeptBySale(supabase: SupabaseClient, orgId: string, projectId: string, elevationId: string): Promise<boolean> {
  // One record per agreement the home has had; a handful at most.
  const { data, error } = await supabase.from("home_product_revisions").select("id, contract:contracts(status)")
    .eq("org_id", orgId).eq("project_id", projectId).eq("stage", "agreement").eq("elevation_id", elevationId).limit(50)
  if (error) throw new Error(`Failed to check the elevation the home was sold on: ${error.message}`)
  return (data ?? []).some((row) => {
    const contract = Array.isArray(row.contract) ? row.contract[0] : row.contract
    return contract?.status === "active"
  })
}
