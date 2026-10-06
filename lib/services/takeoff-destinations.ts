import "server-only"

/**
 * Where a measured quantity is allowed to land, for one project.
 *
 * This is the ONLY place takeoff consults posture. The measuring engine, the
 * conditions service, and the panel are all posture-blind; they ask this
 * module "what can I push to?" and render whatever comes back. That keeps a
 * mixed org — a custom home and a 60-lot community under one subscription —
 * working without a single `if (posture === ...)` in a component.
 *
 * Routing:
 *   estimate      — every posture. The estimate is the qty-bearing document.
 *   bid_scope     — where the Bids module is enabled for the posture; writes
 *                   `unit_price` scope lines subs can price in the bid portal.
 *   plan_takeoff  — production only, and only against DRAFT plan versions
 *                   (released versions are immutable by trigger).
 */

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getOrgProductTier } from "@/lib/services/context"
import { getProjectPosture, type ProjectPosture } from "@/lib/product-tier"
import { isProjectModuleEnabled, PROJECT_MODULES } from "@/lib/project-modules"
import type { TakeoffDestination } from "@/lib/validation/takeoff"

export interface TakeoffSyncTarget {
  destination: TakeoffDestination
  id: string
  label: string
  /** Second line in the picker: status, total, whatever disambiguates. */
  detail: string | null
  /** False when the target exists but cannot accept a write right now. */
  writable: boolean
  /** Why not, when `writable` is false. */
  blocked_reason?: string
}

/** Targets are capped so a 200-estimate project cannot flood the dialog. */
const TARGET_CAP = 50

export async function listSyncTargets(
  projectId: string,
  orgId?: string,
): Promise<TakeoffSyncTarget[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, property_type, phase, prospect_id, project_module_overrides(module_key, enabled)")
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .maybeSingle()

  if (projectError) throw new Error(`Unable to load takeoff workspace: ${projectError.message}`)
  if (!project) throw new Error("Project not found")

  const orgTier = await getOrgProductTier(resolvedOrgId)
  const posture = getProjectPosture(project.property_type, orgTier)

  const bidsModule = PROJECT_MODULES.find((module) => module.key === "bids")
  const bidsEnabled = isProjectModuleEnabled({
    moduleKey: "bids",
    posture,
    overrides: Object.fromEntries((project.project_module_overrides ?? []).map((override: { module_key: string; enabled: boolean }) => [override.module_key, override.enabled])),
    postures:
      bidsModule && "postures" in bidsModule ? [...(bidsModule.postures as ProjectPosture[])] : undefined,
  })

  const [estimates, bidPackages] = await Promise.all([
    loadEstimateTargets(supabase, resolvedOrgId, projectId, project.phase === "precon" ? project.prospect_id : null),
    bidsEnabled && project.phase !== "precon" ? loadBidPackageTargets(supabase, resolvedOrgId, projectId) : Promise.resolve([]),
  ])

  const worksheet: TakeoffSyncTarget[] = project.phase === "precon" && project.prospect_id ? [{
    destination: "pricing_worksheet", id: project.prospect_id, label: "Pricing worksheet",
    detail: "Working scope & costs", writable: true,
  }] : []
  return [...worksheet, ...estimates, ...bidPackages, ...(project.phase !== "precon" ? await loadChangeOrderTargets(supabase, resolvedOrgId, projectId) : [])]
}

async function loadEstimateTargets(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  projectId: string,
  prospectId?: string | null,
): Promise<TakeoffSyncTarget[]> {
  const { data, error } = await supabase
    .from("estimates")
    .select("id, title, status, version, total_cents, updated_at, is_current_version, metadata")
    .eq("org_id", orgId)
    .eq(prospectId ? "prospect_id" : "project_id", prospectId ?? projectId)
    .order("updated_at", { ascending: false })
    .limit(TARGET_CAP)

  if (error) throw new Error(`Unable to load estimates: ${error.message}`)
  return (data ?? []).filter((row) => !prospectId || row.metadata?.precon?.purpose !== "preconstruction_agreement").map((row) => {
    // A signed estimate is a legal document; quantities move through a change
    // order from there, never through a silent re-sync.
    const locked = row.status !== "draft" || row.is_current_version === false || !!row.metadata?.pricing_worksheet
    return {
      destination: "estimate" as const,
      id: row.id as string,
      label: `${row.title}${row.version && row.version > 1 ? ` (v${row.version})` : ""}`,
      detail: String(row.status).replace(/_/g, " "),
      writable: !locked,
      ...(locked ? { blocked_reason: row.metadata?.pricing_worksheet ? "Update the working pricing worksheet, then prepare a new proposal." : "Create a new draft version in Pricing before updating quantities" } : {}),
    }
  })
}

async function loadBidPackageTargets(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  projectId: string,
): Promise<TakeoffSyncTarget[]> {
  const { data } = await supabase
    .from("bid_packages")
    .select("id, title, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(TARGET_CAP)

  return (data ?? []).map((row) => {
    const locked = ["awarded", "cancelled", "closed"].includes(String(row.status))
    return {
      destination: "bid_scope" as const,
      id: row.id as string,
      label: row.title as string,
      detail: String(row.status).replace(/_/g, " "),
      writable: !locked,
      ...(locked ? { blocked_reason: `Package is ${String(row.status)}` } : {}),
    }
  })
}

/**
 * Plan-takeoff targets for a house plan (production). Separate entry point
 * because a plan version's conditions are not scoped to a project at all —
 * the plan sheet calls this directly.
 */
export async function listPlanVersionSyncTargets(
  housePlanId: string,
  orgId?: string,
): Promise<TakeoffSyncTarget[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data } = await supabase
    .from("house_plan_versions")
    .select("id, label, status, version_number")
    .eq("org_id", resolvedOrgId)
    .eq("house_plan_id", housePlanId)
    .order("version_number", { ascending: false })
    .limit(TARGET_CAP)

  return (data ?? []).map((row) => {
    // The immutability trigger rejects writes to a released version, so the
    // dialog says so up front instead of surfacing a Postgres error.
    const released = String(row.status) !== "draft"
    return {
      destination: "plan_takeoff" as const,
      id: row.id as string,
      label: (row.label as string) || `Version ${row.version_number}`,
      detail: String(row.status),
      writable: !released,
      ...(released ? { blocked_reason: "Released versions are immutable" } : {}),
    }
  })
}

/**
 * The single destination for a plan-version takeoff: the version itself.
 *
 * There is no picker here on purpose. Measuring against a plan version means
 * the quantities belong to THAT version's bill of process; offering to write
 * them onto a different version would be a mistake waiting to happen.
 */
export async function listPlanVersionTarget(
  housePlanVersionId: string,
  orgId?: string,
): Promise<TakeoffSyncTarget[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data } = await supabase
    .from("house_plan_versions")
    .select("id, label, status, version_number, house_plans(name, code)")
    .eq("org_id", resolvedOrgId)
    .eq("id", housePlanVersionId)
    .maybeSingle()

  if (!data) return []

  // Released versions are immutable by trigger; say so instead of surfacing a
  // Postgres error after the user has already picked their conditions.
  const released = String(data.status) !== "draft"
  const plan = (data as any).house_plans
  const planLabel = plan?.code ? `${plan.code} — ${plan.name}` : plan?.name ?? "Plan"

  return [
    {
      destination: "plan_takeoff",
      id: data.id as string,
      label: `${planLabel} · ${(data.label as string) || `Version ${data.version_number}`}`,
      detail: String(data.status),
      writable: !released,
      ...(released ? { blocked_reason: "Released versions are immutable" } : {}),
    },
  ]
}

/**
 * Projects whose drawings a house plan can be measured against.
 *
 * House plans have no drawing set of their own — drawings are project-scoped,
 * and a plan is a template, not a job. What a plan DOES have is lots built from
 * it, and those lots' projects carry the plan's sheets. So "measure this plan"
 * means "measure a house built from this plan", which is also how a purchasing
 * manager actually works.
 *
 * The conditions still belong to the plan version (`house_plan_version_id`), so
 * the quantities roll up to the plan no matter which lot's sheets they were
 * traced on.
 */
export interface PlanDrawingSource {
  project_id: string
  project_name: string
  /** Lot the project sits on, when it is a production lot project. */
  lot_label: string | null
  community_name: string | null
  sheet_count: number
}

export async function listPlanDrawingSources(
  housePlanId: string,
  orgId?: string,
): Promise<PlanDrawingSource[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data: lots } = await supabase
    .from("lots")
    .select("project_id, block, lot_number, communities(name), projects(id, name)")
    .eq("org_id", resolvedOrgId)
    .eq("house_plan_id", housePlanId)
    .not("project_id", "is", null)
    .limit(TARGET_CAP)

  if (!lots || lots.length === 0) return []

  const projectIds = Array.from(
    new Set(lots.map((lot: any) => lot.project_id).filter(Boolean)),
  ) as string[]

  // A project with no published sheets has nothing to measure; offering it
  // would send the user into an empty viewer.
  const { data: sheets } = await supabase
    .from("drawing_sheets")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .in("project_id", projectIds)
    .not("current_revision_id", "is", null)
    .limit(2000)

  const counts = new Map<string, number>()
  for (const sheet of sheets ?? []) {
    const projectId = sheet.project_id as string
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1)
  }

  return lots
    .map((lot: any) => ({
      project_id: lot.project_id as string,
      project_name: lot.projects?.name ?? "Untitled project",
      lot_label:
        lot.block || lot.lot_number
          ? `${lot.block ? `Blk ${lot.block} ` : ""}Lot ${lot.lot_number ?? "—"}`.trim()
          : null,
      community_name: lot.communities?.name ?? null,
      sheet_count: counts.get(lot.project_id as string) ?? 0,
    }))
    .filter((source) => source.sheet_count > 0)
    .sort((a, b) => b.sheet_count - a.sheet_count)
}

async function loadChangeOrderTargets(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string, projectId: string): Promise<TakeoffSyncTarget[]> {
  const { data, error } = await supabase.from("change_orders").select("id,title,status,lifecycle,client_visible").eq("org_id", orgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(TARGET_CAP)
  if (error) throw new Error("Unable to load change orders for these plans.")
  return (data ?? []).map(row => {
    const writable = ["draft", "pricing"].includes(row.lifecycle ?? "draft") && row.status === "draft" && !row.client_visible
    return { destination: "change_order", id: row.id, label: row.title, detail: row.lifecycle ?? row.status, writable,
      ...(writable ? {} : { blocked_reason: "Issued changes are preserved. Create a draft change order for revised quantities." }) }
  })
}
