import "server-only"

import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { ONBOARDING_READINESS_ITEMS } from "@/lib/data/onboarding-readiness"

export const ONBOARDING_STAGE_KEYS = [
  "org_shell", "divisions", "accounting", "cost_codes", "plan_library",
  "option_catalog", "price_book", "communities_lots", "team_rbac", "open_wip", "pilot_live",
] as const
export type OnboardingStageKey = (typeof ONBOARDING_STAGE_KEYS)[number]
export type OnboardingStageStatus = "pending" | "in_progress" | "done" | "skipped"

export interface OnboardingStageDefinition {
  key: OnboardingStageKey
  label: string
  owner: "platform" | "customer_admin" | "both"
  importer?: string
  prerequisites: readonly OnboardingStageKey[]
  skippable: boolean
  help: string
}

export const ONBOARDING_STAGES: readonly OnboardingStageDefinition[] = [
  { key: "org_shell", label: "Org shell + tier", owner: "platform", prerequisites: [], skippable: false, help: "Production tier, owner, trial, and onboarding run." },
  { key: "divisions", label: "Divisions", owner: "platform", prerequisites: ["org_shell"], skippable: true, help: "Division names, codes, regions, and operating scope." },
  { key: "accounting", label: "Accounting connections + entity map", owner: "both", prerequisites: ["org_shell"], skippable: true, help: "Connected books and mappings, or an explicit unconnected-accounting acknowledgement." },
  { key: "cost_codes", label: "Cost-code structure", owner: "customer_admin", importer: "cost_codes", prerequisites: ["org_shell"], skippable: false, help: "NAHB seed, custom import, or both." },
  { key: "plan_library", label: "Plan library", owner: "customer_admin", importer: "plan_library", prerequisites: ["cost_codes"], skippable: false, help: "Plans, elevations, released versions, and takeoffs." },
  { key: "option_catalog", label: "Option catalog", owner: "customer_admin", importer: "option_catalog", prerequisites: ["cost_codes"], skippable: true, help: "Structural and design-studio options and plan applicability." },
  { key: "price_book", label: "Price book", owner: "customer_admin", importer: "price_book", prerequisites: ["cost_codes"], skippable: false, help: "Effective-dated vendor agreements with resolved vendors and cost codes." },
  { key: "communities_lots", label: "Communities, phases & lots", owner: "customer_admin", importer: "communities_lots", prerequisites: ["org_shell"], skippable: false, help: "Land inventory and takedown tranches; no project rows for started lots." },
  { key: "team_rbac", label: "Team + RBAC", owner: "both", importer: "team", prerequisites: ["org_shell"], skippable: false, help: "Roster, catalog roles, and division scopes." },
  { key: "open_wip", label: "Open-WIP cutover", owner: "platform", importer: "open_wip", prerequisites: ["plan_library", "communities_lots"], skippable: false, help: "Current-state houses only: budget snapshots, remaining POs, and remaining schedules." },
  { key: "pilot_live", label: "Pilot go-live", owner: "both", prerequisites: ["accounting", "cost_codes", "plan_library", "price_book", "communities_lots", "team_rbac", "open_wip"], skippable: false, help: "Readiness audit, training, and the first fully Arc-native start." },
] as const

export interface GateResult { key: string; passed: boolean; message: string; count?: number }

interface StageState {
  status: OnboardingStageStatus
  completed_at?: string
  completed_by?: string
  notes?: string
  evidence?: Record<string, unknown>
}

async function platformContext() {
  const [access, auth] = await Promise.all([getCurrentPlatformAccess(), requireAuth()])
  if (!access.canAccessPlatform) throw new Error("Platform access is required")
  return { supabase: createServiceSupabaseClient(), userId: auth.user.id }
}

function stageStateMap(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, StageState> : {}
}

async function committedBatchGate(supabase: ReturnType<typeof createServiceSupabaseClient>, orgId: string, importer: string): Promise<GateResult> {
  const { count, error } = await supabase.from("import_batches").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("importer", importer).eq("status", "committed").eq("error_count", 0)
  if (error) return { key: `${importer}_batch`, passed: false, message: `Unable to verify ${importer} batches.` }
  return { key: `${importer}_batch`, passed: (count ?? 0) > 0, count: count ?? 0, message: (count ?? 0) > 0 ? `${count} clean committed batch${count === 1 ? "" : "es"}.` : `Commit a clean ${importer.replace(/_/g, " ")} batch first.` }
}

async function evaluateStageGates(input: { orgId: string; stageKey: OnboardingStageKey; stages: Record<string, StageState>; readinessAudit?: unknown }) {
  const supabase = createServiceSupabaseClient()
  const stage = ONBOARDING_STAGES.find((item) => item.key === input.stageKey)
  if (!stage) throw new Error("Unknown onboarding stage")
  const gates: GateResult[] = stage.prerequisites.map((key) => ({ key: `prerequisite_${key}`, passed: ["done", "skipped"].includes(input.stages[key]?.status ?? "pending"), message: ["done", "skipped"].includes(input.stages[key]?.status ?? "pending") ? `${ONBOARDING_STAGES.find((item) => item.key === key)?.label} is complete.` : `Complete ${ONBOARDING_STAGES.find((item) => item.key === key)?.label} first.` }))
  if (input.stageKey === "org_shell") {
    const { data: org } = await supabase.from("orgs").select("product_tier").eq("id", input.orgId).maybeSingle()
    gates.push({ key: "production_tier", passed: org?.product_tier === "production", message: org?.product_tier === "production" ? "Organization uses the production posture." : "Organization product tier must be production." })
  } else if (input.stageKey === "divisions") {
    const { count } = await supabase.from("divisions").select("id", { count: "exact", head: true }).eq("org_id", input.orgId)
    gates.push({ key: "division_count", passed: (count ?? 0) > 0, count: count ?? 0, message: (count ?? 0) > 0 ? `${count} division${count === 1 ? "" : "s"} configured.` : "Create divisions or skip this stage for a single-division organization." })
  } else if (input.stageKey === "accounting") {
    const [{ count: connectionCount }, { count: mapCount }] = await Promise.all([
      supabase.from("accounting_connections").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("status", "active"),
      supabase.from("accounting_entity_map").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("scope", "org"),
    ])
    const unconnected = input.stages.accounting?.evidence?.accounting_unconnected_acknowledged === true
    gates.push({ key: "accounting_target", passed: ((connectionCount ?? 0) > 0 && (mapCount ?? 0) > 0) || unconnected, message: unconnected ? "Unconnected accounting was explicitly acknowledged." : (connectionCount ?? 0) > 0 && (mapCount ?? 0) > 0 ? "Active accounting connection and org-default entity map found." : "Connect and map accounting, or record the unconnected-accounting decision." })
  } else if (input.stageKey === "cost_codes") {
    const { count } = await supabase.from("cost_codes").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("is_active", true)
    gates.push({ key: "cost_codes", passed: (count ?? 0) > 0, count: count ?? 0, message: (count ?? 0) > 0 ? `${count} active cost codes available.` : "Seed or import cost codes first." })
  } else if (input.stageKey === "plan_library") {
    const [{ count: plans }, { count: released }] = await Promise.all([
      supabase.from("house_plans").select("id", { count: "exact", head: true }).eq("org_id", input.orgId),
      supabase.from("house_plan_versions").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("status", "released"),
    ])
    gates.push({ key: "plans", passed: (plans ?? 0) > 0 && (released ?? 0) > 0, count: plans ?? 0, message: (plans ?? 0) > 0 && (released ?? 0) > 0 ? `${plans} plans with ${released} released versions.` : "Import plans and release at least one configured version." })
  } else if (stage.importer) {
    gates.push(await committedBatchGate(supabase, input.orgId, stage.importer))
  }
  if (input.stageKey === "team_rbac") {
    const { count } = await supabase.from("memberships").select("id,role:roles!inner(key)", { count: "exact", head: true }).eq("org_id", input.orgId).eq("status", "active").in("roles.key", ["org_owner", "org_admin"])
    gates.push({ key: "admins", passed: (count ?? 0) >= 2, count: count ?? 0, message: (count ?? 0) >= 2 ? "At least two active organization administrators are assigned." : "Assign at least one administrator besides the owner." })
  }
  if (input.stageKey === "pilot_live") {
    const audit = Array.isArray(input.readinessAudit) ? input.readinessAudit : []
    const expectedKeys = new Set(ONBOARDING_READINESS_ITEMS.map(([key]) => key))
    const auditPassed = audit.length === expectedKeys.size && audit.every((item) => item && typeof item === "object" && "key" in item && typeof item.key === "string" && expectedKeys.has(item.key as (typeof ONBOARDING_READINESS_ITEMS)[number][0]) && "passed" in item && item.passed === true && "verified_by" in item && Boolean(item.verified_by) && "volume" in item && Boolean(item.volume))
    const projectId = input.stages.pilot_live?.evidence?.arc_native_project_id
    let nativeStart = false
    if (typeof projectId === "string") {
      const { data } = await supabase.from("start_packages").select("id,status,project_id").eq("org_id", input.orgId).eq("project_id", projectId).eq("status", "released").maybeSingle()
      nativeStart = Boolean(data)
    }
    gates.push({ key: "readiness_audit", passed: auditPassed, count: audit.length, message: auditPassed ? "All 15 scale-readiness checks passed." : "Record passing evidence for all 15 readiness checks." })
    gates.push({ key: "arc_native_start", passed: nativeStart, message: nativeStart ? "First fully Arc-native start is released." : "Record a released Arc-native start project in stage evidence." })
  }
  return gates
}

export async function createOnboardingRun(input: { orgId: string; targetLiveDate?: string | null; notes?: string | null }) {
  const { supabase, userId } = await platformContext()
  const { data: existing } = await supabase.from("onboarding_runs").select("*").eq("org_id", input.orgId).eq("status", "active").maybeSingle()
  if (existing) return existing
  const initialStages = Object.fromEntries(ONBOARDING_STAGES.map((stage) => [stage.key, { status: stage.key === "org_shell" ? "in_progress" : "pending" }]))
  const { data, error } = await supabase.from("onboarding_runs").insert({ org_id: input.orgId, stages: initialStages, target_live_date: input.targetLiveDate ?? null, notes: input.notes ?? null, created_by: userId }).select("*").single()
  if (error || !data) throw new Error(`Failed to create onboarding run: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: userId, eventType: "onboarding_run_created", entityType: "onboarding_run", entityId: data.id }),
    recordAudit({ orgId: input.orgId, actorId: userId, action: "insert", entityType: "onboarding_run", entityId: data.id, after: data }),
  ])
  return data
}

export async function getOnboardingRun(orgId: string) {
  const { supabase } = await platformContext()
  const [{ data: org, error: orgError }, { data: run, error: runError }] = await Promise.all([
    supabase.from("orgs").select("id,name,slug,product_tier").eq("id", orgId).maybeSingle(),
    supabase.from("onboarding_runs").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (orgError || !org) throw new Error("Organization not found")
  if (runError) throw new Error(`Failed to load onboarding run: ${runError.message}`)
  if (!run) return { org, run: null, stages: [] }
  const stages = stageStateMap(run.stages)
  const rendered = await Promise.all(ONBOARDING_STAGES.map(async (definition) => ({ definition, state: stages[definition.key] ?? { status: "pending" }, gates: await evaluateStageGates({ orgId, stageKey: definition.key, stages, readinessAudit: run.readiness_audit }) })))
  return { org, run, stages: rendered }
}

export async function updateOnboardingRun(input: { runId: string; targetLiveDate?: string | null; pilotCommunityId?: string | null; pilotDivisionId?: string | null; notes?: string | null; readinessAudit?: unknown[] }) {
  const { supabase, userId } = await platformContext()
  const patch = { target_live_date: input.targetLiveDate, pilot_community_id: input.pilotCommunityId, pilot_division_id: input.pilotDivisionId, notes: input.notes, readiness_audit: input.readinessAudit }
  const cleaned = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  const { data, error } = await supabase.from("onboarding_runs").update(cleaned).eq("id", input.runId).eq("status", "active").select("*").single()
  if (error || !data) throw new Error(`Failed to update onboarding run: ${error?.message}`)
  await recordAudit({ orgId: data.org_id, actorId: userId, action: "update", entityType: "onboarding_run", entityId: data.id, after: cleaned })
  return data
}

export async function completeOnboardingStage(input: { runId: string; stageKey: OnboardingStageKey; notes?: string; evidence?: Record<string, unknown> }) {
  const { supabase, userId } = await platformContext()
  const { data: run, error } = await supabase.from("onboarding_runs").select("*").eq("id", input.runId).eq("status", "active").maybeSingle()
  if (error || !run) throw new Error("Active onboarding run not found")
  const stages = stageStateMap(run.stages)
  stages[input.stageKey] = { ...(stages[input.stageKey] ?? { status: "pending" }), status: "in_progress", notes: input.notes, evidence: input.evidence ?? stages[input.stageKey]?.evidence }
  const gates = await evaluateStageGates({ orgId: run.org_id, stageKey: input.stageKey, stages, readinessAudit: run.readiness_audit })
  const failing = gates.find((gate) => !gate.passed)
  if (failing) throw new Error(failing.message)
  stages[input.stageKey] = { ...stages[input.stageKey], status: "done", completed_at: new Date().toISOString(), completed_by: userId }
  const { error: updateError } = await supabase.from("onboarding_runs").update({ stages }).eq("id", run.id)
  if (updateError) throw new Error(`Failed to complete onboarding stage: ${updateError.message}`)
  await Promise.all([
    recordEvent({ orgId: run.org_id, actorId: userId, eventType: "onboarding_stage_completed", entityType: "onboarding_run", entityId: run.id, payload: { stage_key: input.stageKey } }),
    recordAudit({ orgId: run.org_id, actorId: userId, action: "update", entityType: "onboarding_run", entityId: run.id, after: { stage_key: input.stageKey, state: stages[input.stageKey] } }),
  ])
  return stages[input.stageKey]
}

export async function skipOnboardingStage(input: { runId: string; stageKey: OnboardingStageKey; reason: string; evidence?: Record<string, unknown> }) {
  const definition = ONBOARDING_STAGES.find((stage) => stage.key === input.stageKey)
  if (!definition?.skippable) throw new Error("This onboarding stage cannot be skipped")
  if (!input.reason.trim()) throw new Error("A skip reason is required")
  const { supabase, userId } = await platformContext()
  const { data: run } = await supabase.from("onboarding_runs").select("*").eq("id", input.runId).eq("status", "active").maybeSingle()
  if (!run) throw new Error("Active onboarding run not found")
  const stages = stageStateMap(run.stages)
  for (const prerequisite of definition.prerequisites) if (!["done", "skipped"].includes(stages[prerequisite]?.status ?? "pending")) throw new Error(`Complete ${ONBOARDING_STAGES.find((stage) => stage.key === prerequisite)?.label} first`)
  stages[input.stageKey] = { status: "skipped", completed_at: new Date().toISOString(), completed_by: userId, notes: input.reason.trim(), evidence: input.evidence }
  await supabase.from("onboarding_runs").update({ stages }).eq("id", run.id)
  await Promise.all([
    recordEvent({ orgId: run.org_id, actorId: userId, eventType: "onboarding_stage_skipped", entityType: "onboarding_run", entityId: run.id, payload: { stage_key: input.stageKey, reason: input.reason.trim() } }),
    recordAudit({ orgId: run.org_id, actorId: userId, action: "update", entityType: "onboarding_run", entityId: run.id, after: { stage_key: input.stageKey, state: stages[input.stageKey] } }),
  ])
  return stages[input.stageKey]
}

export async function markRunLive(runId: string) {
  const { supabase, userId } = await platformContext()
  const { data: run } = await supabase.from("onboarding_runs").select("*").eq("id", runId).eq("status", "active").maybeSingle()
  if (!run) throw new Error("Active onboarding run not found")
  const stages = stageStateMap(run.stages)
  const incomplete = ONBOARDING_STAGES.find((stage) => !["done", "skipped"].includes(stages[stage.key]?.status ?? "pending"))
  if (incomplete) throw new Error(`Complete ${incomplete.label} before marking the run live`)
  const { data, error } = await supabase.from("onboarding_runs").update({ status: "live" }).eq("id", runId).select("*").single()
  if (error || !data) throw new Error(`Failed to mark onboarding live: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: data.org_id, actorId: userId, eventType: "onboarding_run_live", entityType: "onboarding_run", entityId: data.id }),
    recordAudit({ orgId: data.org_id, actorId: userId, action: "update", entityType: "onboarding_run", entityId: data.id, before: { status: "active" }, after: { status: "live" } }),
  ])
  return data
}
