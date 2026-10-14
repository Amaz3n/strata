import "server-only"
import { randomUUID } from "node:crypto"
import { loadPurchasingEnabledByCommunity } from "@/lib/services/purchasing-readiness"
import { confirmationRecoveryEnabled, loadStartConfirmationJobs, queueStartConfirmationRecovery, queueStartNotificationRecovery, readStartNotificationDeliveries, type StartConfirmationJobDTO } from "@/lib/services/starts-confirmation-recovery"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { RELEASE_PRODUCED_GATE_KEYS, SQL_EVIDENCE_SOURCES, SYSTEM_GATE_KEYS, canWaiveGate, financingGateClear, gateRequiresEvidence, isGateApplicable, pickBlocker, startPackageReadiness, type GateAppliesWhen, type GateBlocker, type GateBlockerInput, type GateStatus } from "@/lib/starts/gate-logic"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { getReleaseSlotTarget } from "@/lib/services/even-flow"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser, hasPlatformOrgContext } from "@/lib/services/authorization"
import { prepareProjectAccountingDimensions, prepareProjectOpeningContract, prepareProjectCreation } from "@/lib/services/projects"
import { prepareProjectFinancialSettings } from "@/lib/services/project-financial-setup"
import { readAllRows } from "@/lib/land/paging"
import { LOT_DELIVERY_EXCEPTIONS_EMBED, verticalStartRefusal } from "@/lib/land/lot-lifecycle"
import { LIVE_RESERVATION_STATUSES, liveReservationOrFilter } from "@/lib/sales/live-reservation"
import { isPlanOffered, offeringOverrideFor } from "@/lib/sales/plan-offering"
import { checkLotFits } from "@/lib/services/lot-fit"
import { isPlanPinKeptByReview } from "@/lib/services/plan-pin-review"
import { isElevationKeptBySale } from "@/lib/services/product-change-impact"
import { loadEntitlementBlockersForLot } from "@/lib/services/land-entitlements"
import { readAgreementMilestoneBlockers, readStartFinancingRecord } from "@/lib/services/agreement-milestones"
import { triggerStartsPipeline } from "@/lib/services/starts-pipeline-trigger"
import { resolveSuperintendentLimits, superintendentLoad, superintendentRemaining, type SuperintendentLoad } from "@/lib/starts/superintendent-load"
import {
  gateAttestSchema,
  gateDefinitionSchema,
  gateWaiveSchema,
  releaseInputSchema,
  superintendentAssignmentSchema,
  startPackageInputSchema,
  startPackageUpdateSchema,
  type GateDefinitionInput,
} from "@/lib/validation/starts"

export type StartPackageStatus = "open" | "ready" | "releasing" | "released" | "attention" | "cancelled"

export interface GateDefinitionDTO {
  id: string
  key: string
  label: string
  description: string | null
  checkKind: "auto" | "manual"
  autoSource: string | null
  requiresAttestationPermission: string | null
  appliesWhen: GateAppliesWhen
  sortOrder: number
  isActive: boolean
}

export interface StartGateDTO {
  id: string
  definitionId: string
  key: string
  label: string
  checkKind: "auto" | "manual"
  status: GateStatus
  passedVia: "auto" | "attested" | "waived" | null
  attestedBy: string | null
  attestedByName: string | null
  attestedAt: string | null
  waivedReason: string | null
  evidenceFileId: string | null
  releaseProduced: boolean
  /** The permit gate is never waived; the authority's decision clears it. */
  waivable: boolean
  /** Attesting it needs a file on this home as evidence. */
  requiresEvidence: boolean
}

/**
 * How much trouble a house is in, in the order the desk cares about it.
 * `late` and `at_risk` are only knowable for sold homes — a spec has no
 * contractual close date to miss.
 */
export type StartRisk = "failed" | "late" | "at_risk" | "ready" | "on_track"

export interface StartSaleDTO {
  isSold: boolean
  buyerName: string | null
  closingDate: string | null
}

/** Fallback when an org has no completed homes to measure a real cycle from. */
export const DEFAULT_TARGET_CYCLE_DAYS = 130

export interface StartPackageListItemDTO {
  id: string
  lotId: string
  lotLabel: string
  communityId: string
  communityName: string
  projectId: string | null
  status: StartPackageStatus
  planCode: string | null
  planName: string | null
  elevationCode: string | null
  targetWeek: string | null
  scheduledStartDate: string | null
  gatesPassed: number
  gatesTotal: number
  preconAgeDays: number
  isFinanced: boolean
  releasedAt: string | null
  superintendentId: string | null
  superintendentName: string | null
  /** The one gate this house is actually waiting on. */
  blocker: GateBlocker | null
  /** Days since anything last cleared — how long this house has been stuck. */
  stalledDays: number
  /** Closing date minus target cycle. Null for specs and unscheduled closings. */
  mustStartBy: string | null
  daysToMustStart: number | null
  /** The cycle `mustStartBy` was derived from, and whether anyone set it. */
  cycleDays: number
  cycleDaysConfigured: boolean
  risk: StartRisk
  sale: StartSaleDTO
}

export interface StartPackageDetailDTO extends StartPackageListItemDTO {
  confirmationJobs: StartConfirmationJobDTO[]
  confirmationRecoveryEnabled: boolean
  gates: StartGateDTO[]
  steps: Array<{ stepKey: string; status: string; attempt: number; error: string | null; detail: Record<string, unknown>; completedAt: string | null }>
  notes: string | null
  tradeNotices: StartTradeNoticeDTO[]
}

export interface StartTradeNoticeDTO {
  /** The outbox job id, or the delivery id when `source` is "delivery". */
  id: string
  source: "job" | "delivery"
  kind: "release" | "schedule_change" | "package"
  companyId: string | null
  companyName: string
  status: "pending" | "processing" | "completed" | "failed" | "ambiguous"
  retryCount: number
  error: string | null
  runAt: string
}

type Relation = Record<string, unknown>

/**
 * Start packages, their gates and step ledger, and starts jobs are fenced from
 * the browser role (20261003048000), so every write below goes through the
 * service client — and every one is an RPC that locks the package, re-checks
 * the actor's permission and division reach over the community, lot and home,
 * and writes the change with its audit, event, reindex and notification intent
 * in one transaction (20261010100000, 20261010140000, 20261011060000). The
 * service checks first so a refusal reads well; the transaction is what holds.
 * Reads stay on the caller's session so RLS still scopes what they can see.
 */
function startsWriter() {
  return createServiceSupabaseClient()
}

/**
 * Starts writes are a member's. Every mutation re-checks an active membership in
 * SQL, which Arc support standing (a platform operator inside the org under a
 * support grant) does not have, so support can read the desk and ask a member to
 * act. Refusing here says so; the transaction would only report that the actor is
 * "no longer an active organization member".
 */
async function requireStartsMember(context: OrgServiceContext) {
  if (await hasPlatformOrgContext(context.orgId, context.userId)) {
    throw new Error("Arc support access is read-only for starts. Ask a member of the organization to make this change.")
  }
}

const RELEASE_LIMITS = ["community", "division", "org"] as const
const queueReleaseResultSchema = z.discriminatedUnion("queued", [
  z.object({ queued: z.literal(true) }),
  z.object({
    queued: z.literal(false), target_week: z.string(), target: z.number(), already_targeted: z.number(),
    limit: z.enum(RELEASE_LIMITS),
    exceeded: z.array(z.object({ limit: z.enum(RELEASE_LIMITS), target: z.number(), already_targeted: z.number() })).min(1),
  }),
])

/** The start limits a release would push past, nearest first: the community's week, then its division's, then the org's. */
export interface ReleaseOverage {
  targetWeek: string
  limit: (typeof RELEASE_LIMITS)[number]
  target: number
  alreadyTargeted: number
  exceeded: Array<{ limit: (typeof RELEASE_LIMITS)[number]; target: number; alreadyTargeted: number }>
}

function releaseOverage(queued: Extract<z.infer<typeof queueReleaseResultSchema>, { queued: false }>): ReleaseOverage {
  return {
    targetWeek: queued.target_week, limit: queued.limit, target: queued.target, alreadyTargeted: queued.already_targeted,
    exceeded: queued.exceeded.map((entry) => ({ limit: entry.limit, target: entry.target, alreadyTargeted: entry.already_targeted })),
  }
}

const assignSuperintendentResultSchema = z.discriminatedUnion("assigned", [
  z.object({
    assigned: z.literal(true), changed: z.boolean(), houses: z.number().nullable(), warn: z.number().nullable(),
    limit: z.number().nullable(), over_capacity: z.boolean(),
  }),
  z.object({ assigned: z.literal(false), requires_override: z.literal(true), can_override: z.boolean(), houses: z.number(), warn: z.number(), limit: z.number() }),
])

export type SuperintendentAssignment =
  | { assigned: true; changed: boolean; houses: number | null; overCapacity: boolean }
  | { assigned: false; requiresOverride: true; canOverride: boolean; houses: number; warn: number; limit: number }

const cancelReleaseResultSchema = z.object({ preserved: z.array(z.string()), reset: z.array(z.string()) })

const START_PACKAGE_STATUSES = ["open", "ready", "releasing", "released", "attention", "cancelled"] as const
const packageStatusResultSchema = z.object({ status: z.enum(START_PACKAGE_STATUSES) })

const startHomeResultSchema = z.object({ project_id: z.string().uuid() })
const openPackageResultSchema = startHomeResultSchema.extend({ start_package_id: z.string().uuid() })

/**
 * The home a lot gets when it enters the start pipeline, prepared with the same
 * pure helpers createProject uses and written by SQL in the transaction that
 * links it (`open_start_package`, `ensure_start_package_home`). It opens in
 * `precon` and is promoted to `delivery` at release: an unreleased lot is not a
 * house under construction, and counting it as one inflates every
 * delivery-phase list, portfolio Gantt and under-construction rollup by the
 * whole width of the precon pipeline.
 */
function prepareStartHome(context: OrgServiceContext, lot: { lot_number: unknown; address: unknown; community: unknown }) {
  const community = relation(lot.community)
  const name = `${text(community?.code) ?? text(community?.name) ?? "Lot"} ${String(lot.lot_number)}`
  const projectId = randomUUID()
  const callerInput = { name, status: "active" as const, phase: "precon" as const, property_type: "production" as const, address: text(lot.address) ?? undefined }
  const { input, project } = prepareProjectCreation({ input: callerInput, orgId: context.orgId, userId: context.userId, productTier: context.productTier })
  const contract = prepareProjectOpeningContract({ callerInput, input, productTier: context.productTier, orgId: context.orgId, projectId, projectName: name })
  return {
    projectId, project, billingContract: contract,
    financialSettings: prepareProjectFinancialSettings({
      orgId: context.orgId, projectId, userId: context.userId, input, existingContract: contract,
      existingRawCostCodesEnabled: null, now: new Date().toISOString(),
    }),
    accountingDimensions: prepareProjectAccountingDimensions({ classId: null, className: null, customerId: null, customerName: null }),
  }
}

const DEFAULT_GATE_DEFINITIONS = [
  { key: "entitlements", label: "Entitlements & conditions met", check_kind: "auto", auto_source: "entitlements_clear", applies_when: "always", sort_order: 5 },
  { key: "permit", label: "Approved permit for this plan", check_kind: "auto", auto_source: "permit_approved", applies_when: "always", sort_order: 10 },
  { key: "plot_plan", label: "Plot/site plan on file", check_kind: "auto", auto_source: "plot_plan_file", applies_when: "always", sort_order: 20 },
  { key: "selections_locked", label: "Structural selections locked", check_kind: "auto", auto_source: "selections_locked", applies_when: "always", sort_order: 30 },
  { key: "plan_pinned", label: "Plan version & elevation pinned", check_kind: "auto", auto_source: "plan_pinned", applies_when: "always", sort_order: 40 },
  { key: "price_book", label: "Price book resolves", check_kind: "auto", auto_source: "po_exceptions_clear", applies_when: "purchasing_enabled", sort_order: 50 },
  { key: "budget", label: "Budget generated", check_kind: "auto", auto_source: "budget_generated", applies_when: "always", sort_order: 60 },
  { key: "po_set", label: "PO set generated", check_kind: "auto", auto_source: "pos_generated", applies_when: "purchasing_enabled", sort_order: 70 },
  { key: "financing", label: "Financing milestones clear", check_kind: "auto", auto_source: "agreement_milestones_clear", applies_when: "always", sort_order: 80 },
  { key: "final_approval", label: "Final start approval", check_kind: "manual", auto_source: null, applies_when: "always", sort_order: 90, requires_attestation_permission: "start.release" },
] as const

function relation(value: unknown): Relation | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Relation : null
}

function text(value: unknown) {
  return typeof value === "string" ? value : null
}

function daysSince(value: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000))
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

/**
 * A community's start-to-close cycle. The fallback is a guess, and every
 * must-start date derived from it is a guess too — so the source travels with
 * the number instead of being laundered into a confident date on the card.
 */
function targetCycleDays(settings: unknown): { days: number; configured: boolean } {
  if (settings && typeof settings === "object") {
    const value = Reflect.get(settings, "target_cycle_days")
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return { days: Math.trunc(value), configured: true }
    }
  }
  return { days: DEFAULT_TARGET_CYCLE_DAYS, configured: false }
}

const SALES_CHUNK = 200
/**
 * Lots the yard reads to find the ones still waiting for a package. Past this
 * the desk refuses instead of counting a sample, like the package counters.
 */
const CANDIDATE_LOT_CAP = 5_000

const EMPTY_SALE: StartSaleDTO = { isSold: false, buyerName: null, closingDate: null }

/**
 * Sold-or-spec, plus the closing date that gives a house its deadline. A home
 * counts as sold once its purchase agreement is active; the closing row exists
 * from that moment (created by the agreement-executed callback) but only
 * carries a date once one is set.
 */
async function loadSalesByProject(supabase: SupabaseClient, orgId: string, projectIds: Array<string | null>) {
  const unique = Array.from(new Set(projectIds.filter((id): id is string => Boolean(id))))
  if (!unique.length) return new Map<string, StartSaleDTO>()
  // Chunked so a community-wide yard never builds an unbounded `in (...)` URL.
  const chunks = Array.from({ length: Math.ceil(unique.length / SALES_CHUNK) }, (_, index) => unique.slice(index * SALES_CHUNK, (index + 1) * SALES_CHUNK))
  const results = await Promise.all(chunks.map((ids) => Promise.all([
    supabase.from("contracts").select("project_id").eq("org_id", orgId)
      .eq("contract_type", "purchase_agreement").eq("status", "active").in("project_id", ids),
    supabase.from("closings").select("project_id,scheduled_date").eq("org_id", orgId)
      .in("project_id", ids).neq("status", "cancelled").not("scheduled_date", "is", null),
  ])))
  const contractRows: Array<{ project_id: string | null }> = []
  const closingRows: Array<{ project_id: string; scheduled_date: string }> = []
  for (const [contracts, closings] of results) {
    if (contracts.error) throw new Error(`Failed to load purchase agreements: ${contracts.error.message}`)
    if (closings.error) throw new Error(`Failed to load closings: ${closings.error.message}`)
    contractRows.push(...(contracts.data ?? []))
    closingRows.push(...(closings.data ?? []))
  }
  const sold = new Set(contractRows.flatMap((row) => row.project_id ? [row.project_id] : []))
  const closingDates = new Map<string, string>()
  for (const row of closingRows) {
    const current = closingDates.get(row.project_id)
    // Earliest scheduled closing wins — it is the one that constrains the start.
    if (!current || row.scheduled_date < current) closingDates.set(row.project_id, row.scheduled_date)
  }
  return new Map(unique.map((projectId) => [projectId, {
    isSold: sold.has(projectId),
    buyerName: null,
    closingDate: closingDates.get(projectId) ?? null,
  }]))
}

function deriveSchedulePressure(input: {
  status: StartPackageStatus
  closingDate: string | null
  cycle: { days: number; configured: boolean }
  blocker: GateBlocker | null
}): { mustStartBy: string | null; daysToMustStart: number | null; cycleDays: number; cycleDaysConfigured: boolean; risk: StartRisk } {
  const mustStartBy = input.closingDate ? shiftDays(input.closingDate, -input.cycle.days) : null
  const daysToMustStart = mustStartBy ? daysBetween(todayIso(), mustStartBy) : null
  const base = { mustStartBy, daysToMustStart, cycleDays: input.cycle.days, cycleDaysConfigured: input.cycle.configured }
  if (input.status === "attention") return { ...base, risk: "failed" }
  if (daysToMustStart !== null && daysToMustStart < 0) return { ...base, risk: "late" }
  if (daysToMustStart !== null && input.blocker && daysToMustStart < input.blocker.leadDays) {
    return { ...base, risk: "at_risk" }
  }
  if (input.status === "ready") return { ...base, risk: "ready" }
  return { ...base, risk: "on_track" }
}

function mapDefinition(row: Relation): GateDefinitionDTO {
  return {
    id: String(row.id), key: String(row.key), label: String(row.label),
    description: text(row.description), checkKind: row.check_kind as "auto" | "manual",
    autoSource: text(row.auto_source), requiresAttestationPermission: text(row.requires_attestation_permission),
    appliesWhen: row.applies_when as GateAppliesWhen, sortOrder: Number(row.sort_order), isActive: row.is_active === true,
  }
}

function mapGate(row: Relation): StartGateDTO {
  const definition = relation(row.definition)
  const user = relation(row.attested_user)
  if (!definition) throw new Error("Start gate definition is missing")
  return {
    id: String(row.id), definitionId: String(row.gate_definition_id), key: String(definition.key),
    label: String(definition.label), checkKind: definition.check_kind as "auto" | "manual",
    status: row.status as GateStatus, passedVia: row.passed_via as StartGateDTO["passedVia"],
    attestedBy: text(row.attested_by), attestedByName: text(user?.full_name), attestedAt: text(row.attested_at),
    waivedReason: text(row.waived_reason), evidenceFileId: text(row.evidence_file_id),
    releaseProduced: RELEASE_PRODUCED_GATE_KEYS.has(String(definition.key)),
    waivable: canWaiveGate({ autoSource: text(definition.auto_source) }),
    requiresEvidence: gateRequiresEvidence({
      key: String(definition.key),
      checkKind: definition.check_kind === "manual" ? "manual" : "auto",
      requiresAttestationPermission: text(definition.requires_attestation_permission),
    }),
  }
}


async function loadPurchasingEnabled(supabase: SupabaseClient, orgId: string, communityId: string) {
  const map = await loadPurchasingEnabledByCommunity(supabase, orgId, [communityId])
  return map.get(communityId) ?? false
}

export async function seedDefaultGateDefinitions(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  await requireStartsMember(context)
  // Definitions are writable by start.release holders only; seeding the
  // system's defaults is part of opening a package, which start.write may do.
  const { error } = await startsWriter().from("start_gate_definitions").upsert(
    DEFAULT_GATE_DEFINITIONS.map((gate) => ({ org_id: context.orgId, ...gate })),
    { onConflict: "org_id,key", ignoreDuplicates: true },
  )
  if (error) throw new Error(`Failed to seed start gates: ${error.message}`)
}

export async function listGateDefinitions(orgId?: string): Promise<GateDefinitionDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { data, error } = await context.supabase.from("start_gate_definitions").select("*")
    .eq("org_id", context.orgId).order("sort_order")
  if (error) throw new Error(`Failed to load start gates: ${error.message}`)
  return (data ?? []).map((row) => mapDefinition(row))
}

const savedGateDefinitionSchema = z.object({ definition: z.record(z.string(), z.unknown()), packages_updated: z.number().int() })

/** The communities with a price book among those holding an open or ready package: it decides whether a purchasing-only gate applies. */
async function communitiesWithPurchasingOpenPackages(orgId: string) {
  const writer = startsWriter()
  const packages = await readAllRows((from, to) => writer.from("start_packages").select("community_id")
    .eq("org_id", orgId).in("status", ["open", "ready"]).order("id").range(from, to),
  { cap: 20001, label: "Failed to read open start packages" })
  if (packages.truncated) throw new Error("More open start packages than a gate change can reach; narrow the starts desk first.")
  const communityIds = Array.from(new Set(packages.rows.map((row) => String(row.community_id))))
  const enabled: string[] = []
  for (let offset = 0; offset < communityIds.length; offset += 200) {
    const byCommunity = await loadPurchasingEnabledByCommunity(writer, orgId, communityIds.slice(offset, offset + 200))
    for (const [communityId, on] of byCommunity) if (on) enabled.push(communityId)
  }
  return enabled
}

/**
 * Saves a gate definition. One transaction writes it with its audit and event and
 * adds an active gate to every open and ready package, returning a ready package
 * that gains an unanswered gate to open — a new gate used to reach only packages
 * opened afterwards, so the rest ran the whole release and parked at publication.
 */
export async function upsertGateDefinition(input: GateDefinitionInput, orgId?: string) {
  const parsed = gateDefinitionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const system = DEFAULT_GATE_DEFINITIONS.find((gate) => gate.key === parsed.key && SYSTEM_GATE_KEYS.has(gate.key))
  if (system && (parsed.checkKind !== system.check_kind || parsed.autoSource !== system.auto_source
    || parsed.appliesWhen !== system.applies_when || !parsed.isActive || parsed.requiresAttestationPermission)) {
    throw new Error(`The ${system.label.toLowerCase()} gate is part of every start; only its label and order can change.`)
  }
  const { data, error } = await startsWriter().rpc("save_start_gate_definition", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_id: parsed.id ?? null, p_key: parsed.key, p_label: parsed.label,
    p_description: parsed.description ?? null, p_check_kind: parsed.checkKind,
    p_auto_source: parsed.checkKind === "auto" ? parsed.autoSource : null,
    p_requires_attestation_permission: parsed.requiresAttestationPermission ?? null, p_applies_when: parsed.appliesWhen,
    p_sort_order: parsed.sortOrder, p_is_active: parsed.isActive,
    p_purchasing_communities: parsed.isActive ? await communitiesWithPurchasingOpenPackages(context.orgId) : [],
  })
  if (error) throw new Error(`Failed to save start gate: ${error.message}`)
  return mapDefinition(savedGateDefinitionSchema.parse(data).definition)
}

async function loadPackageRow(supabase: SupabaseClient, orgId: string, packageId: string) {
  const { data, error } = await supabase.from("start_packages").select("*")
    .eq("org_id", orgId).eq("id", packageId).maybeSingle()
  if (error || !data) throw new Error("Start package not found")
  await assertStartCommunityAccess(supabase, orgId, data.community_id)
  return data
}

export async function assertStartCommunityAccess(supabase: SupabaseClient, orgId: string, communityId: string) {
  const context = await requireOrgContext(orgId)
  const access = await getDivisionAccessForUser(context)
  if (access.assignedOnly) {
    const { data: community, error: communityError } = await supabase.from("communities").select("division_id")
      .eq("org_id", orgId).eq("id", communityId).maybeSingle()
    if (communityError || !community || !community.division_id || !access.divisionIds.includes(community.division_id)) {
      throw new Error("Start package is outside your division access")
    }
  }
  return access
}

async function loadGateRows(supabase: SupabaseClient, orgId: string, packageId: string) {
  const { data, error } = await supabase.from("start_package_gates").select(`
    *, definition:start_gate_definitions!inner(key,label,check_kind,auto_source,applies_when,requires_attestation_permission,sort_order),
    attested_user:app_users!start_package_gates_attested_by_fkey(full_name)
  `).eq("org_id", orgId).eq("start_package_id", packageId).order("created_at")
  if (error) throw new Error(`Failed to load start gates: ${error.message}`)
  return data ?? []
}

/** Recheck current definitions and applicability immediately before publication. */
export async function assertReleaseGateCompletion(
  supabase: SupabaseClient, orgId: string, packageId: string,
  expected: { projectId: string; lotId: string; communityId: string; startDate: string; purchasingEnabled: boolean },
) {
  const [pkg, definitions, gates] = await Promise.all([
    supabase.from("start_packages").select("id,status,project_id,lot_id,community_id,scheduled_start_date,is_financed")
      .eq("org_id", orgId).eq("id", packageId).maybeSingle(),
    readAllRows((from, to) => supabase.from("start_gate_definitions").select("id,key,check_kind,auto_source,applies_when")
      .eq("org_id", orgId).eq("is_active", true).order("id").range(from, to),
    { cap: 1001, label: "Failed to verify release gate definitions" }),
    readAllRows((from, to) => supabase.from("start_package_gates").select("gate_definition_id,status,waived_reason,passed_via,evidence_file_id")
      .eq("org_id", orgId).eq("start_package_id", packageId).order("id").range(from, to),
    { cap: 1001, label: "Failed to verify release gates" }),
  ])
  if (pkg.error || !pkg.data) throw new Error(`Failed to verify release gates: ${pkg.error?.message ?? "Package unavailable"}`)
  if (pkg.data.status !== "releasing" || pkg.data.project_id !== expected.projectId || pkg.data.lot_id !== expected.lotId
    || pkg.data.community_id !== expected.communityId || pkg.data.scheduled_start_date !== expected.startDate) throw new Error("Release package scope or date changed before publication")
  if (definitions.truncated || gates.truncated) throw new Error("Release gate verification exceeds the supported limit")
  if (!definitions.rows.length) throw new Error("Release has no active gate definitions")
  const purchasingEnabled = await loadPurchasingEnabled(supabase, orgId, pkg.data.community_id)
  if (purchasingEnabled !== expected.purchasingEnabled) throw new Error("Purchasing applicability changed during release; retry with the current price book")
  const byDefinition = new Map(gates.rows.map(row => [row.gate_definition_id, row]))
  if (byDefinition.size !== gates.rows.length) throw new Error("Release contains duplicate gate evidence")
  for (const definition of definitions.rows) {
    if (!isGateApplicable({ appliesWhen: definition.applies_when as GateAppliesWhen }, { isFinanced: pkg.data.is_financed, purchasingEnabled })) continue
    const gate = byDefinition.get(definition.id)
    if (!gate || !["passed", "waived"].includes(gate.status)
      || (gate.status === "waived" && String(gate.waived_reason ?? "").trim().length < 10)) {
      throw new Error(`Release completion is not proven for the ${definition.key} gate`)
    }
    if (gate.status === "passed" && definition.check_kind === "auto"
      && !await deriveAutoGate(supabase, orgId, pkg.data, String(definition.auto_source))) {
      throw new Error(`Release evidence no longer satisfies the ${definition.key} gate`)
    }
    if (gate.status === "passed" && gate.passed_via === "attested" && gate.evidence_file_id) {
      // An attestation stands on its file: one archived or moved off the home
      // after the gate cleared no longer proves it.
      const { data: evidence, error: evidenceError } = await supabase.from("files").select("id")
        .eq("org_id", orgId).eq("project_id", expected.projectId).eq("id", gate.evidence_file_id).is("archived_at", null).maybeSingle()
      if (evidenceError) throw new Error(`Failed to verify the ${definition.key} gate's evidence: ${evidenceError.message}`)
      if (!evidence) throw new Error(`The ${definition.key} gate's evidence is no longer on the home`)
    }
  }
}

async function deriveAutoGate(
  supabase: SupabaseClient,
  orgId: string,
  pkg: Relation,
  source: string,
) {
  const projectId = text(pkg.project_id)
  if (SQL_EVIDENCE_SOURCES.has(source)) {
    // The permit and its plot plan are evidenced by the database from the
    // home's permit application, whoever asks.
    const { data, error } = await supabase.rpc("start_gate_sql_evidence", { p_org_id: orgId, p_package_id: String(pkg.id), p_source: source })
    if (error) throw new Error(`Failed to check the ${source === "permit_approved" ? "permit" : "plot plan"}: ${error.message}`)
    return z.boolean().parse(data)
  }
  if (source === "entitlements_clear") {
    // Nothing recorded is nothing blocking: an org that tracks no entitlements
    // sees this gate clear. A recorded, unmet one for the lot's phase holds it.
    const { data, error } = await supabase.from("lots").select("community_id,community_phase_id")
      .eq("org_id", orgId).eq("id", String(pkg.lot_id)).maybeSingle()
    if (error) throw new Error(`Failed to check entitlements: ${error.message}`)
    if (!data) return false
    const blockers = await loadEntitlementBlockersForLot(supabase, orgId, {
      communityId: String(data.community_id), phaseId: text(data.community_phase_id),
    })
    return blockers.length === 0
  }
  if (source === "plan_pinned") {
    const { data, error } = await supabase.from("lots").select("id,community_id,metadata,dimensions,swing,house_plan_version_id,house_plan_elevation_id,version:house_plan_versions(status,house_plan_id),elevation:house_plan_elevations(is_active)")
      .eq("org_id", orgId).eq("id", String(pkg.lot_id)).maybeSingle()
    if (error) throw new Error(`Failed to check pinned plan: ${error.message}`)
    const version = relation(data?.version)
    if (!data?.house_plan_version_id || !data.house_plan_elevation_id) return false
    // An elevation retired after this home was sold on it still builds; a home
    // not sold on it (a spec home, another elevation's sale) does not.
    if (relation(data.elevation)?.is_active === false
      && !(projectId && await isElevationKeptBySale(supabase, orgId, projectId, data.house_plan_elevation_id))) return false
    // A home starts on the current release, or on the superseded version it was
    // sold at when a plan change review decided it keeps that version.
    if (version?.status !== "released"
      && !(version?.status === "superseded" && await isPlanPinKeptByReview(supabase, orgId, data.id, data.house_plan_version_id))) return false
    // The pin must still be on the community's price sheet today; a plan the
    // community has since withdrawn starts only under a recorded override.
    const housePlanId = text(version.house_plan_id)
    if (!housePlanId) return false
    const { data: offering, error: offeringError } = await supabase.from("community_plan_availability")
      .select("is_available,elevation_id,effective_start,effective_end")
      .eq("org_id", orgId).eq("community_id", data.community_id).eq("house_plan_id", housePlanId)
    if (offeringError) throw new Error(`Failed to check community plan offering: ${offeringError.message}`)
    const offered = isPlanOffered(offering ?? [], { elevationId: data.house_plan_elevation_id, onDate: new Date().toISOString().slice(0, 10) })
      || Boolean(offeringOverrideFor(data.metadata, housePlanId))
    if (!offered) return false
    // And the house must still fit the lot, or stand under a fit override that
    // covers it: a setback or dimension edit since the pin can take it away.
    const fit = (await checkLotFits({ supabase, orgId }, [{
      key: data.id, lotId: data.id, communityId: data.community_id, dimensions: data.dimensions, lotSwing: data.swing ?? "either",
      planId: housePlanId, elevationId: data.house_plan_elevation_id, swing: null,
    }])).get(data.id)
    return !fit?.refusal
  }
  if (!projectId) return false
  if (source === "agreement_milestones_clear") {
    // A spec home has no buyer to prove. A sold home clears only on the
    // lender's loan approval (financed) or proof of funds (cash), satisfied
    // with its document on file, and with nothing the agreement holds before
    // start still open. Records that are absent, waived or archived never pass.
    const [blockers, financing] = await Promise.all([
      readAgreementMilestoneBlockers(supabase, orgId, projectId, "start"),
      readStartFinancingRecord(supabase, orgId, projectId),
    ])
    return blockers.length === 0 && financingGateClear(financing)
  }
  if (source === "selections_locked") {
    // Absence of evidence is not satisfaction. "No open selection groups" is
    // vacuously true for a project whose groups were never instantiated, which
    // made the one gate that exists to stop a house starting on unlocked
    // structural selections pass on every package, every time. The groups have
    // to EXIST before "none of them are open" means anything.
    const [total, open] = await Promise.all([
      supabase.from("project_selection_groups").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("project_id", projectId),
      supabase.from("project_selection_groups").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("project_id", projectId).eq("status", "open"),
    ])
    if (total.error) throw new Error(`Failed to check selection groups: ${total.error.message}`)
    if (open.error) throw new Error(`Failed to check open selections: ${open.error.message}`)
    if (total.count === null || open.count === null) throw new Error("Selection evidence counts unavailable")
    return (total.count ?? 0) > 0 && (open.count ?? 0) === 0
  }
  if (source === "budget_generated") {
    const { count, error } = await supabase.from("budgets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId)
    if (error || count === null) throw new Error(`Failed to check generated budget: ${error?.message ?? "Evidence count unavailable"}`)
    return (count ?? 0) > 0
  }
  if (source === "pos_generated") {
    const { count, error } = await supabase.from("po_generation_runs").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId).eq("mode", "commit").in("status", ["succeeded", "succeeded_with_exceptions"])
    if (error || count === null) throw new Error(`Failed to check generated purchase orders: ${error?.message ?? "Evidence count unavailable"}`)
    return (count ?? 0) > 0
  }
  if (source === "po_exceptions_clear") {
    // A price book only "resolves" once it has been exercised against THIS
    // house. Zero exception rows on a project nobody ever ran generation for
    // proves nothing, so a finished run is the evidence and clear exceptions
    // are the verdict — a dry run is enough, and a commit run counts too.
    const [runs, open] = await Promise.all([
      supabase.from("po_generation_runs").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("project_id", projectId).in("status", ["succeeded", "succeeded_with_exceptions"]),
      supabase.from("po_generation_exceptions").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("project_id", projectId).eq("status", "open"),
    ])
    if (runs.error) throw new Error(`Failed to check price-book runs: ${runs.error.message}`)
    if (open.error) throw new Error(`Failed to check purchase-order exceptions: ${open.error.message}`)
    if (runs.count === null || open.count === null) throw new Error("Purchase-order evidence counts unavailable")
    return (runs.count ?? 0) > 0 && (open.count ?? 0) === 0
  }
  return false
}

/**
 * The two gates the release itself produces, re-derived from what actually
 * landed. Finalize used to force both to `passed, passed_via:"auto"` no matter
 * what — including when the PO step was SKIPPED because the community has no
 * price book — so the audit trail asserted a PO set that was never generated.
 */
export async function syncReleaseProducedGates(
  supabase: SupabaseClient,
  orgId: string,
  packageId: string,
  pkg: { projectId: string; lotId: string },
): Promise<Record<string, boolean>> {
  const rows = await loadGateRows(supabase, orgId, packageId)
  const produced: Record<string, boolean> = {}
  await Promise.all(rows.map(async (row) => {
    const definition = relation(row.definition)
    const key = String(definition?.key ?? "")
    if (!definition || !RELEASE_PRODUCED_GATE_KEYS.has(key)) return
    // A waiver is a human decision about this house; the release does not get
    // to overwrite it with a machine check.
    if (row.status === "waived" || row.status === "not_applicable") return
    const passed = await deriveAutoGate(supabase, orgId, { project_id: pkg.projectId, lot_id: pkg.lotId }, String(definition.auto_source))
    produced[key] = passed
    const { error } = await supabase.from("start_package_gates")
      .update({ status: passed ? "passed" : "pending", passed_via: passed ? "auto" : null })
      .eq("org_id", orgId).eq("id", row.id)
    if (error) throw new Error(`Failed to record the ${key} gate: ${error.message}`)
  }))
  return produced
}

/**
 * Readiness is decided in the transaction that records it, from the gates as
 * they stand under the package lock. A package that turns ready queues its
 * notice in that transaction; the starts worker sends it.
 */
function settleReadiness(previous: unknown, data: unknown) {
  const { status } = packageStatusResultSchema.parse(data)
  if (status === "ready" && previous !== "ready") void triggerStartsPipeline()
  return status
}

export async function refreshAutoGates(packageId: string, orgId?: string): Promise<StartGateDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  const [purchasingEnabled, loadedRows, active] = await Promise.all([
    loadPurchasingEnabled(context.supabase, context.orgId, pkg.community_id),
    loadGateRows(context.supabase, context.orgId, packageId),
    readAllRows((from, to) => context.supabase.from("start_gate_definitions").select("id")
      .eq("org_id", context.orgId).eq("is_active", true).order("id").range(from, to),
    { cap: 1001, label: "Failed to read start gate definitions" }),
  ])
  let rows = loadedRows
  // Once a release begins its gates belong to the release.
  if (!["open", "ready"].includes(pkg.status)) return rows.map((row) => mapGate(row))
  // A package opened before a gate was defined (or before a default was seeded)
  // has no row for it; give it one so readiness and the release both answer for it.
  const held = new Set(rows.map((row) => String(row.gate_definition_id)))
  if (active.rows.some((definition) => !held.has(String(definition.id)))) {
    const { error: healError } = await startsWriter().rpc("heal_start_package_gates", {
      p_org_id: context.orgId, p_package_id: packageId, p_actor_id: context.userId, p_purchasing_enabled: purchasingEnabled,
    })
    if (healError) throw new Error(`Failed to add the package's missing gates: ${healError.message}`)
    rows = await loadGateRows(context.supabase, context.orgId, packageId)
  }
  // Evidence is read here; applicability, the verdicts and the readiness they
  // prove are written by SQL, which refuses a gate whose evidence is missing
  // and evidences the permit and plot plan itself.
  const evidence: Record<string, boolean> = {}
  await Promise.all(rows.map(async (row) => {
    const definition = relation(row.definition)
    if (!definition || definition.check_kind !== "auto" || row.status === "waived") return
    if (SQL_EVIDENCE_SOURCES.has(String(definition.auto_source))) return
    if (!isGateApplicable({ appliesWhen: definition.applies_when as GateAppliesWhen }, { isFinanced: pkg.is_financed, purchasingEnabled })) return
    evidence[String(row.id)] = await deriveAutoGate(context.supabase, context.orgId, pkg, String(definition.auto_source))
  }))
  const { data, error } = await startsWriter().rpc("refresh_start_package_gates", {
    p_org_id: context.orgId, p_package_id: packageId, p_actor_id: context.userId,
    p_purchasing_enabled: purchasingEnabled, p_evidence: evidence,
  })
  if (error) throw new Error(`Failed to refresh start gates: ${error.message}`)
  settleReadiness(pkg.status, data)
  return (await loadGateRows(context.supabase, context.orgId, packageId)).map((row) => mapGate(row))
}

export async function openStartPackage(lotId: string, input: { isFinanced?: boolean; targetWeek?: string | null }, orgId?: string) {
  const parsed = startPackageInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  await requireStartsMember(context)
  const { data: lot, error } = await context.supabase.from("lots").select(`id,community_id,division_id,project_id,status,delivered_at,metadata,lot_number,address,community:communities(name,code),${LOT_DELIVERY_EXCEPTIONS_EMBED}`)
    .eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  const access = await assertStartCommunityAccess(context.supabase, context.orgId, lot.community_id)
  if (access.assignedOnly && (!lot.division_id || !access.divisionIds.includes(lot.division_id))) throw new Error("Lot is outside your division access")
  await seedDefaultGateDefinitions(context.orgId)
  const refusal = verticalStartRefusal({ status: lot.status, deliveredAt: lot.delivered_at, deliveryExceptions: lot.delivery_exceptions })
  if (refusal) throw new Error(refusal)
  if (!lot.project_id) {
    // A hold or reservation with no home yet is a buyer waiting on this lot;
    // building a spec house on it would sell the lot twice.
    const { data: held, error: heldError } = await context.supabase.from("lot_reservations").select("id")
      .eq("org_id", context.orgId).eq("lot_id", lot.id).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()).limit(1)
    if (heldError) throw new Error(`Failed to check the lot's reservations: ${heldError.message}`)
    if (held?.length) throw new Error("This lot has a live hold or reservation. Convert it to the buyer's home or release it before starting a house.")
  }
  // A preconstruction home is needed before release so plot-plan files,
  // selections, and price-book dry runs have a stable project scope. The home,
  // the lot link, the package and its gates commit together — a failure leaves
  // nothing behind, and a retry after a commit finds the lot's active package.
  const { data, error: openError } = await startsWriter().rpc("open_start_package", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_lot_id: lot.id, p_is_financed: parsed.isFinanced,
    p_target_week: parsed.targetWeek ?? null, p_home: lot.project_id ? null : prepareStartHome(context, lot),
  })
  if (openError) throw new Error(openError.code === "23505" ? "This lot already has an active start package." : `Failed to open start package: ${openError.message}`)
  const { start_package_id: packageId } = openPackageResultSchema.parse(data)
  await refreshAutoGates(packageId, context.orgId)
  return getStartPackage(packageId, context.orgId)
}

export async function updateStartPackage(id: string, input: { targetWeek?: string | null; scheduledStartDate?: string | null; isFinanced?: boolean; notes?: string | null }, orgId?: string) {
  const parsed = startPackageUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  await requireStartsMember(context)
  const before = await loadPackageRow(context.supabase, context.orgId, id)
  if (!["open", "ready"].includes(before.status)) throw new Error("Only open or ready packages can be edited.")
  const patch = {
    ...(parsed.targetWeek !== undefined ? { target_week: parsed.targetWeek } : {}),
    ...(parsed.scheduledStartDate !== undefined ? { scheduled_start_date: parsed.scheduledStartDate } : {}),
    ...(parsed.isFinanced !== undefined ? { is_financed: parsed.isFinanced } : {}),
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
  }
  const { data, error } = await startsWriter().rpc("update_start_package", {
    p_org_id: context.orgId, p_package_id: id, p_actor_id: context.userId, p_patch: patch,
    p_purchasing_enabled: await loadPurchasingEnabled(context.supabase, context.orgId, before.community_id),
  })
  if (error) throw new Error(`Failed to update start package: ${error.message}`)
  settleReadiness(before.status, data)
  await refreshAutoGates(id, context.orgId)
  return getStartPackage(id, context.orgId)
}

async function mutateGate(
  context: OrgServiceContext,
  packageId: string,
  gateId: string,
  action: "attest" | "waive" | "reopen",
  input: Record<string, string | null>,
) {
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (!["open", "ready"].includes(pkg.status)) throw new Error("Gates cannot change after release begins.")
  const { data, error } = await startsWriter().rpc("mutate_start_gate", {
    p_org_id: context.orgId, p_package_id: packageId, p_gate_id: gateId, p_actor_id: context.userId, p_action: action, p_input: input,
    p_purchasing_enabled: await loadPurchasingEnabled(context.supabase, context.orgId, pkg.community_id),
  })
  if (error) throw new Error(error.message)
  settleReadiness(pkg.status, data)
  // A waiver queues its notice in the same transaction.
  if (action === "waive") void triggerStartsPipeline()
  return getStartPackage(packageId, context.orgId)
}

/** The gate's own attestation permission and the final-approval order are enforced in SQL. */
export async function attestGate(packageId: string, gateId: string, input: { evidenceFileId?: string; notes?: string }, orgId?: string) {
  const parsed = gateAttestSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  return mutateGate(context, packageId, gateId, "attest", { evidence_file_id: parsed.evidenceFileId ?? null, notes: parsed.notes ?? null })
}

export async function waiveGate(packageId: string, gateId: string, input: { reason: string }, orgId?: string) {
  const parsed = gateWaiveSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  return mutateGate(context, packageId, gateId, "waive", { reason: parsed.reason })
}

export async function reopenGate(packageId: string, gateId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  return mutateGate(context, packageId, gateId, "reopen", {})
}

export async function releaseStart(packageId: string, input: { scheduledStartDate: string; overTargetReason?: string }, orgId?: string): Promise<{ released: true } | { requiresConfirm: true; slot: ReleaseOverage }> {
  const parsed = releaseInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  await refreshAutoGates(packageId, context.orgId)
  let pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "ready") throw new Error("The start package is not ready to release.")
  const targetWeek = pkg.target_week ?? mondayOfIsoWeek(parsed.scheduledStartDate)

  if (!pkg.project_id) {
    // A package opened before homes were created at open gets its home here,
    // under the package lock: a retried release reuses it instead of building
    // a second house for the same lot.
    const { data: lot } = await context.supabase.from("lots").select("lot_number,address,community:communities(name,code)")
      .eq("org_id", context.orgId).eq("id", pkg.lot_id).maybeSingle()
    if (!lot) throw new Error("Lot not found")
    const { data, error } = await startsWriter().rpc("ensure_start_package_home", {
      p_org_id: context.orgId, p_actor_id: context.userId, p_package_id: packageId, p_home: prepareStartHome(context, lot),
    })
    if (error) throw new Error(`Failed to give the start package its home: ${error.message}`)
    pkg = { ...pkg, project_id: startHomeResultSchema.parse(data).project_id }
  }

  const { data: home, error: homeError } = await context.supabase.from("projects").select("superintendent_id")
    .eq("org_id", context.orgId).eq("id", pkg.project_id).maybeSingle()
  if (homeError || !home) throw new Error("The house for this start package was not found")
  // A house is handed to the person who will run it before it starts; the
  // release transaction refuses one without, this says so first.
  if (!home.superintendent_id) throw new Error("Assign a superintendent to this house before releasing it.")

  const { data: localToday, error: todayError } = await startsWriter().rpc("permit_local_today", { p_org_id: context.orgId, p_project_id: pkg.project_id })
  if (todayError) throw new Error(`Failed to read the home's calendar day: ${todayError.message}`)
  if (parsed.scheduledStartDate < z.string().date().parse(localToday)) throw new Error("Scheduled start date cannot be in the past")

  await assertProjectConfiguration(context.orgId, pkg.project_id)
  const target = await getReleaseSlotTarget(context.orgId, pkg.community_id, targetWeek)
  // One transaction claims the package, counts the week WITH this house in it
  // (serialized against every other release into that week), seeds the step
  // ledger and queues the job — or, over the slot without confirmation, changes
  // nothing. Settled steps from a cancelled release are kept, so a re-release
  // resumes rather than re-running instantiation over work already on the house.
  const { data, error } = await startsWriter().rpc("queue_start_release", {
    p_org_id: context.orgId, p_package_id: packageId, p_actor_id: context.userId,
    p_scheduled_start_date: parsed.scheduledStartDate, p_target_week: targetWeek,
    p_slot_target: target, p_confirm_over_slot: parsed.overTargetReason !== undefined, p_over_reason: parsed.overTargetReason ?? null,
  })
  if (error) throw new Error(`Failed to queue start release: ${error.message}`)
  const queued = queueReleaseResultSchema.parse(data)
  if (!queued.queued) {
    return { requiresConfirm: true, slot: releaseOverage(queued) }
  }
  void triggerStartsPipeline()
  return { released: true }
}

export interface BatchReleaseResult {
  released: string[]
  needsConfirm: Array<{ id: string; slot: ReleaseOverage }>
  failed: Array<{ id: string; error: string }>
}

/**
 * Release day is a batch — a coordinator approves the week's houses in one
 * sitting, not one page load at a time. Releases run in sequence because each
 * one consumes a slot the next one's over-target check has to see.
 */
export async function releaseStarts(
  ids: string[],
  input: { scheduledStartDate: string; overTargetReason?: string },
  orgId?: string,
): Promise<BatchReleaseResult> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const result: BatchReleaseResult = { released: [], needsConfirm: [], failed: [] }
  for (const id of Array.from(new Set(ids))) {
    try {
      const outcome = await releaseStart(id, input, context.orgId)
      if ("requiresConfirm" in outcome) result.needsConfirm.push({ id, slot: outcome.slot })
      else result.released.push(id)
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : "Release failed" })
    }
  }
  return result
}

/**
 * Requeue a release parked in `attention`. The RPC refuses while any attempt is
 * still queued or claimed, and re-checks the coordinator's authority in the
 * same transaction that flips the package and requeues the job.
 */
export async function retryRelease(packageId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "attention") throw new Error("Only releases needing attention can be retried.")
  const { error } = await startsWriter().rpc("retry_start_release", {
    p_org_id: context.orgId, p_package_id: packageId, p_actor_id: context.userId,
  })
  if (error) throw new Error(`Failed to requeue the release: ${error.message}`)
  void triggerStartsPipeline()
}

export interface CancelReleaseResult {
  /** Steps whose work is already on the house. Cancelling did not undo them. */
  preserved: string[]
  /** Steps that had not finished, returned to pending for the next release. */
  reset: string[]
}

/**
 * Stops an in-flight release. It does NOT reverse what already landed — a
 * budget, a schedule, draft inspections and a committed PO set stay on the
 * house — so it says so instead of resetting every step and calling the package
 * "returned to ready". Resetting settled steps was also how a cancel wedged a
 * package: the instantiation ledger still recorded them, so the next release
 * failed permanently on the first step it tried to re-run.
 */
export async function cancelRelease(packageId: string, orgId?: string): Promise<CancelReleaseResult> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (!["releasing", "attention"].includes(pkg.status)) throw new Error("This release is not cancellable.")
  // Package, steps and the claimed job change together, and the claim is
  // revoked in that same transaction: a worker preempted mid-step is refused by
  // the release fences on its next write instead of landing on a ready package.
  const { data, error } = await startsWriter().rpc("cancel_start_release", {
    p_org_id: context.orgId, p_package_id: packageId, p_actor_id: context.userId,
  })
  if (error) throw new Error(`Failed to cancel the release: ${error.message}`)
  return cancelReleaseResultSchema.parse(data)
}

export async function cancelStartPackage(id: string, { reason }: { reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, id)
  if (["releasing", "released"].includes(pkg.status)) throw new Error("A releasing or released start package cannot be cancelled.")
  if (reason.trim().length < 10) throw new Error("Cancellation reason must be at least 10 characters.")
  const { error } = await startsWriter().rpc("cancel_start_package", {
    p_org_id: context.orgId, p_package_id: id, p_actor_id: context.userId, p_reason: reason,
  })
  if (error) throw new Error(`Failed to cancel start package: ${error.message}`)
}

/**
 * Hands a house to its superintendent, or takes it back (`userId` null). One
 * transaction counts the person's houses against their limit under a lock,
 * moves `superintendent_id` and the field scoping row together, and writes the
 * audit and event. Past the limit it answers `requiresOverride` instead of
 * assigning; a start.release holder confirms with a reason, which is audited.
 */
export async function setProjectSuperintendent(
  projectId: string, userId: string | null, input: { overReason?: string } = {}, orgId?: string,
): Promise<SuperintendentAssignment> {
  const parsed = superintendentAssignmentSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(["project.manage", "start.write"], context)
  await requireStartsMember(context)
  // Read on the caller's session so the division wall decides whether they can see the house.
  const { data: project, error: projectError } = await context.supabase.from("projects").select("id")
    .eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (projectError || !project) throw new Error("Project not found")
  const { data, error } = await startsWriter().rpc("assign_project_superintendent", {
    p_org_id: context.orgId, p_project_id: projectId, p_user_id: userId, p_actor_id: context.userId, p_over_reason: parsed.overReason ?? null,
  })
  if (error) throw new Error(error.message)
  const result = assignSuperintendentResultSchema.parse(data)
  if (!result.assigned) {
    return { assigned: false, requiresOverride: true, canOverride: result.can_override, houses: result.houses, warn: result.warn, limit: result.limit }
  }
  if (userId && result.changed) {
    await new NotificationService().createAndQueue({ orgId: context.orgId, userId, type: "project_superintendent_assigned", title: "House assigned", message: "You have been assigned as superintendent.", projectId, entityType: "project", entityId: projectId })
  }
  return { assigned: true, changed: result.changed, houses: result.houses, overCapacity: result.over_capacity }
}

export async function listStartPackages(
  filters: { id?: string; communityId?: string; divisionId?: string; status?: StartPackageStatus[]; targetWeek?: string; targetWeekFrom?: string; page?: number; pageSize?: number } = {},
  orgId?: string,
): Promise<{ packages: StartPackageListItemDTO[]; total: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const divisionAccess = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (filters.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(filters.divisionId)) {
    return { packages: [], total: 0 }
  }
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50))
  // The project is a LEFT join on purpose: a package legitimately has no
  // project until it is opened or released, and an inner join silently hid
  // those packages — including failed releases — from every desk and count.
  // Division scoping therefore runs off the lot, which always exists.
  let query = context.supabase.from("start_packages").select(`
    *, lot:lots!inner(lot_number,block,division_id,house_plan_id,house_plan_elevation_id,
      plan:house_plans(code,name),elevation:house_plan_elevations(code)),
    community:communities!inner(name,settings),
    project:projects(division_id,superintendent_id,client:contacts(full_name),superintendent:app_users!projects_superintendent_id_fkey(full_name)),
    gates:start_package_gates(status,attested_at,definition:start_gate_definitions(key,label,check_kind,applies_when))
  `, { count: "exact" }).eq("org_id", context.orgId)
  if (filters.id) query = query.eq("id", filters.id)
  if (filters.communityId) query = query.eq("community_id", filters.communityId)
  if (filters.divisionId) query = query.eq("lot.division_id", filters.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return { packages: [], total: 0 }
    query = query.in("lot.division_id", divisionAccess.divisionIds)
  }
  if (filters.status?.length) query = query.in("status", filters.status)
  if (filters.targetWeek) query = query.eq("target_week", filters.targetWeek)
  if (filters.targetWeekFrom) query = query.gte("target_week", filters.targetWeekFrom)
  const { data, error, count } = await query.order("target_week", { ascending: true, nullsFirst: false }).order("created_at").range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to load start packages: ${error.message}`)
  const [purchasingByCommunity, salesByProject] = await Promise.all([
    loadPurchasingEnabledByCommunity(context.supabase, context.orgId, (data ?? []).map((row) => row.community_id)),
    loadSalesByProject(context.supabase, context.orgId, (data ?? []).map((row) => row.project_id)),
  ])
  const packages = (data ?? []).map((row) => {
    const lot = relation(row.lot)
    const community = relation(row.community)
    const project = relation(row.project)
    const superintendent = relation(project?.superintendent)
    const plan = relation(lot?.plan)
    const elevation = relation(lot?.elevation)
    const purchasingEnabled = purchasingByCommunity.get(row.community_id) ?? false
    const flags = { isFinanced: row.is_financed, purchasingEnabled }
    const gates: Array<GateBlockerInput & { attestedAt: string | null }> = (row.gates ?? []).map((gate: Relation) => {
      const definition = relation(gate.definition)
      return {
        key: String(definition?.key), label: String(definition?.label ?? definition?.key),
        checkKind: definition?.check_kind as "auto" | "manual",
        appliesWhen: definition?.applies_when as GateAppliesWhen,
        status: gate.status as GateStatus, attestedAt: text(gate.attested_at),
      }
    })
    const readiness = startPackageReadiness(gates, flags)
    const blocker = pickBlocker(gates, flags)
    // "Stalled" is measured from the last gate that actually cleared, so a
    // house that has been sitting on the same blocker for weeks says so.
    const lastProgressAt = gates.reduce(
      (latest: string, gate) => (gate.attestedAt && gate.attestedAt > latest ? gate.attestedAt : latest),
      String(row.created_at),
    )
    const sale = { ...(salesByProject.get(row.project_id) ?? EMPTY_SALE), buyerName: text(relation(project?.client)?.full_name) }
    const pressure = deriveSchedulePressure({
      status: row.status as StartPackageStatus,
      closingDate: sale.closingDate,
      cycle: targetCycleDays(community?.settings),
      blocker,
    })
    return {
      id: row.id, lotId: row.lot_id, lotLabel: lot?.block ? `${lot.block}-${lot.lot_number}` : String(lot?.lot_number ?? "Lot"),
      communityId: row.community_id, communityName: String(community?.name ?? "Community"), projectId: row.project_id,
      status: row.status as StartPackageStatus, planCode: text(plan?.code), planName: text(plan?.name), elevationCode: text(elevation?.code),
      targetWeek: row.target_week, scheduledStartDate: row.scheduled_start_date, gatesPassed: readiness.passed, gatesTotal: readiness.total,
      preconAgeDays: daysSince(row.created_at), isFinanced: row.is_financed, releasedAt: row.released_at,
      superintendentId: text(project?.superintendent_id), superintendentName: text(superintendent?.full_name),
      blocker, stalledDays: daysSince(lastProgressAt), sale, ...pressure,
    }
  })
  return { packages, total: count ?? 0 }
}

export async function getStartPackage(id: string, orgId?: string): Promise<StartPackageDetailDTO> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const result = await listStartPackages({ id, pageSize: 1 }, context.orgId)
  const item = result.packages.find((pkg) => pkg.id === id)
  if (!item) throw new Error("Start package not found")
  const [gates, stepsResult, pkg, tradeNotices, confirmationJobs, recoveryEnabled] = await Promise.all([
    loadGateRows(context.supabase, context.orgId, id),
    context.supabase.from("start_release_steps").select("*").eq("org_id", context.orgId).eq("start_package_id", id).order("created_at"),
    loadPackageRow(context.supabase, context.orgId, id),
    loadStartTradeNotices(context.supabase, context.orgId, id, item.projectId),
    item.status === "released" ? loadStartConfirmationJobs(context.supabase, context.orgId, id) : Promise.resolve([]),
    item.status === "released" ? confirmationRecoveryEnabled(context.supabase, context.orgId) : Promise.resolve(false),
  ])
  if (stepsResult.error) throw new Error(`Failed to load release steps: ${stepsResult.error.message}`)
  return {
    ...item, confirmationJobs, confirmationRecoveryEnabled: recoveryEnabled, notes: pkg.notes, tradeNotices, gates: gates.map((gate) => mapGate(gate)),
    steps: (stepsResult.data ?? []).map((step) => ({ stepKey: step.step_key, status: step.status, attempt: Number(step.attempt), error: step.error, detail: step.detail ?? {}, completedAt: step.completed_at })),
  }
}

export async function retryStartConfirmation(packageId: string, input: { jobId: string; reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "released") throw new Error("Only released homes can retry confirmation")
  const receipt = await queueStartConfirmationRecovery({ ...input, supabase: createServiceSupabaseClient(),
    orgId: context.orgId, packageId, actorId: context.userId })
  void triggerStartsPipeline()
  return receipt
}

export async function retryStartNotificationDelivery(packageId: string, input: { receiptId: string; requestId: string; reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "released") throw new Error("Only released homes can recover alert delivery")
  return queueStartNotificationRecovery({ ...input, supabase: createServiceSupabaseClient(), orgId: context.orgId,
    packageId, actorId: context.userId })
}

export async function inspectStartNotificationDeliveries(packageId: string, input: { after: string | null; failedOnly: boolean }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "released") throw new Error("Only released homes have alert delivery history")
  return readStartNotificationDeliveries({ ...input, supabase: createServiceSupabaseClient(), orgId: context.orgId, packageId, actorId: context.userId })
}

const NOTICE_JOB_KINDS = { start_release_trade_notice: "release", trade_schedule_change_notice: "schedule_change", start_package_notice: "package" } as const
const NOTICE_JOB_STATUSES = ["pending", "processing", "completed", "failed"]

/**
 * Everything the house owes its trades and its coordinators: the release
 * notices it queued (every state), its schedule-change digests and package
 * notices that failed, and any delivery whose outcome is unknown. A job whose
 * delivery is ambiguous is shown as that delivery, which is what a coordinator
 * can act on.
 */
async function loadStartTradeNotices(supabase: SupabaseClient, orgId: string, packageId: string, projectId: string | null): Promise<StartTradeNoticeDTO[]> {
  const [release, failedJobs, deliveries] = await Promise.all([
    readAllRows((from, to) => supabase.from("outbox").select("id,job_type,status,payload,retry_count,last_error,run_at")
      .eq("org_id", orgId).eq("job_type", "start_release_trade_notice").eq("payload->>start_package_id", packageId)
      .order("id").range(from, to), { cap: 10001, label: "Failed to load trade notice delivery" }),
    readAllRows((from, to) => supabase.from("outbox").select("id,job_type,status,payload,retry_count,last_error,run_at")
      .eq("org_id", orgId).eq("status", "failed")
      .or(`and(job_type.eq.start_package_notice,payload->>start_package_id.eq.${packageId})${projectId ? `,and(job_type.eq.trade_schedule_change_notice,payload->>project_id.eq.${projectId})` : ""}`)
      .order("id").range(from, to), { cap: 10001, label: "Failed to load failed trade notices" }),
    projectId
      ? readAllRows((from, to) => supabase.from("trade_notice_deliveries").select("id,kind,company_id,status,attempts,last_error,outbox_id,updated_at")
        .eq("org_id", orgId).eq("project_id", projectId).eq("status", "ambiguous")
        .order("id").range(from, to), { cap: 10001, label: "Failed to load unresolved trade notices" })
      : Promise.resolve({ rows: [], truncated: false }),
  ])
  if (release.truncated || failedJobs.truncated || deliveries.truncated) throw new Error("Trade notice delivery exceeds the supported limit")
  const ambiguousJobs = new Set(deliveries.rows.flatMap((row) => (row.outbox_id === null ? [] : [String(row.outbox_id)])))
  const jobs = [...release.rows, ...failedJobs.rows].filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index && !ambiguousJobs.has(String(row.id)))
  const companyIds = Array.from(new Set([
    ...jobs.flatMap((row) => { const id = text(relation(row.payload)?.company_id); return id ? [id] : [] }),
    ...deliveries.rows.flatMap((row) => (typeof row.company_id === "string" ? [row.company_id] : [])),
  ]))
  const names = new Map<string, string>()
  for (let offset = 0; offset < companyIds.length; offset += 100) {
    const { data, error } = await supabase.from("companies").select("id,name").eq("org_id", orgId).in("id", companyIds.slice(offset, offset + 100))
    if (error) throw new Error(`Failed to load trade notice companies: ${error.message}`)
    for (const company of data ?? []) names.set(company.id, company.name)
  }
  const fromJobs = jobs.map((row): StartTradeNoticeDTO => {
    const kind = NOTICE_JOB_KINDS[row.job_type as keyof typeof NOTICE_JOB_KINDS]
    const companyId = text(relation(row.payload)?.company_id)
    if (!kind || !NOTICE_JOB_STATUSES.includes(row.status) || (kind !== "package" && !companyId)) throw new Error("Invalid trade notice delivery record")
    return {
      id: String(row.id), source: "job", kind, companyId, companyName: companyId ? names.get(companyId) ?? "Unavailable trade company" : "Start package",
      status: row.status as StartTradeNoticeDTO["status"], retryCount: Number(row.retry_count), error: row.last_error, runAt: row.run_at,
    }
  })
  const fromDeliveries = deliveries.rows.map((row): StartTradeNoticeDTO => {
    if (typeof row.company_id !== "string" || !["release", "schedule_change"].includes(row.kind)) throw new Error("Invalid trade notice delivery record")
    return {
      id: String(row.id), source: "delivery", kind: row.kind as StartTradeNoticeDTO["kind"], companyId: row.company_id,
      companyName: names.get(row.company_id) ?? "Unavailable trade company", status: "ambiguous",
      retryCount: Number(row.attempts), error: row.last_error, runAt: row.updated_at,
    }
  })
  return [...fromJobs, ...fromDeliveries]
}

export async function retryStartTradeNotice(packageId: string, noticeId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await requirePermission("start.write", context)
  await requireStartsMember(context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "released") throw new Error("Only released houses can retry trade delivery")
  // The notice is requeued under the coordinator, audited and announced in one
  // transaction that refuses unless it is still this house's failed notice.
  const { error } = await startsWriter().rpc("retry_start_trade_notice", {
    p_org_id: context.orgId, p_package_id: packageId, p_notice_id: noticeId, p_actor_id: context.userId,
  })
  if (error) throw new Error(`Unable to retry trade delivery: ${error.message}`)
  void triggerStartsPipeline()
}

export interface SuperintendentCandidateDTO {
  id: string
  name: string
  /** Houses this person already runs, assigned or started. */
  activeHouses: number
  /** Where they are stretched, and the house count past which assignment needs an override. */
  warnAt: number
  limit: number
  /** Houses they can still take before an override is needed. */
  remaining: number
  load: SuperintendentLoad
}

/**
 * The permission that separates people who run a jobsite from people who do
 * not. Every field role carries it; accountants, estimators, sales agents and
 * the starts coordinator themselves do not.
 */
const FIELD_ROLE_PERMISSION = "daily_log.write"
const SUPERINTENDENT_MEMBER_CAP = 5_000
const ASSIGNED_HOUSE_CAP = 50_000

/**
 * Who can actually be handed a house, how many they already carry and where
 * their limit is. An unfiltered membership list offered 300 names with no
 * capacity signal, which is how a super quietly ends up with fifteen houses.
 *
 * `includeUserIds` keeps whoever is currently assigned in the list even if
 * their role has since changed, so the picker never renders a blank selection.
 * Past the member cap the list refuses rather than dropping people.
 */
export async function listSuperintendentCandidates(
  opts: { includeUserIds?: Array<string | null> } = {},
  orgId?: string,
): Promise<SuperintendentCandidateDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const pinned = new Set((opts.includeUserIds ?? []).filter((id): id is string => Boolean(id)))
  const [members, capacities, houses] = await Promise.all([
    readAllRows((from, to) => context.supabase.from("memberships")
      .select("id,user_id,role_id,user:app_users!memberships_user_id_fkey(id,full_name,email)")
      .eq("org_id", context.orgId).eq("status", "active").order("id").range(from, to),
    { cap: SUPERINTENDENT_MEMBER_CAP + 1, label: "Failed to load superintendent candidates" }),
    readAllRows((from, to) => context.supabase.from("superintendent_capacity").select("id,user_id,warn_houses,max_houses")
      .eq("org_id", context.orgId).order("id").range(from, to),
    { cap: SUPERINTENDENT_MEMBER_CAP + 1, label: "Failed to load superintendent limits" }),
    readAllRows((from, to) => context.supabase.from("projects").select("id,superintendent_id")
      .eq("org_id", context.orgId).eq("status", "active").not("superintendent_id", "is", null).order("id").range(from, to),
    { cap: ASSIGNED_HOUSE_CAP, label: "Failed to count assigned houses" }),
  ])
  if (members.truncated) throw new Error(`More than ${SUPERINTENDENT_MEMBER_CAP} active members; narrow the superintendent list by role.`)
  if (capacities.truncated) throw new Error("Too many superintendent limits to resolve")
  if (houses.truncated) throw new Error("Too many active houses to count superintendent load")
  const roleIds = Array.from(new Set(members.rows.map((row) => row.role_id)))
  const grants = roleIds.length
    ? await context.supabase.from("role_permissions").select("role_id").in("role_id", roleIds).eq("permission_key", FIELD_ROLE_PERMISSION)
    : { data: [], error: null }
  if (grants.error) throw new Error(`Failed to load field roles: ${grants.error.message}`)
  const fieldRoles = new Set((grants.data ?? []).map((row) => row.role_id))
  const orgDefault = capacities.rows.find((row) => row.user_id === null)
  const ownLimits = new Map(capacities.rows.flatMap((row) => (row.user_id ? [[row.user_id, { warn: Number(row.warn_houses), max: Number(row.max_houses) }] as const] : [])))
  const load = new Map<string, number>()
  for (const row of houses.rows) {
    if (!row.superintendent_id) continue
    load.set(row.superintendent_id, (load.get(row.superintendent_id) ?? 0) + 1)
  }
  return members.rows
    .flatMap((row) => {
      const user = relation(row.user)
      const userId = String(row.user_id)
      if (!user || !(fieldRoles.has(row.role_id) || pinned.has(userId))) return []
      const activeHouses = load.get(userId) ?? 0
      const limits = resolveSuperintendentLimits(ownLimits.get(userId), orgDefault ? { warn: Number(orgDefault.warn_houses), max: Number(orgDefault.max_houses) } : null)
      return [{
        id: userId,
        name: text(user.full_name) ?? text(user.email) ?? "Member",
        activeHouses, warnAt: limits.warn, limit: limits.max,
        remaining: superintendentRemaining(activeHouses, limits), load: superintendentLoad(activeHouses, limits),
      }]
    })
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name))
}

export async function listStartPackageCandidates(
  filters: { communityId?: string; divisionId?: string } = {},
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (
    filters.divisionId &&
    divisionAccess.assignedOnly &&
    !divisionAccess.divisionIds.includes(filters.divisionId)
  ) {
    return []
  }
  if (!filters.divisionId && divisionAccess.assignedOnly && divisionAccess.divisionIds.length === 0) return []
  // Every lot in scope, not a first page: lots that already have a package are
  // filtered out below, so a fixed page silently dropped waiting lots — and the
  // sold-but-unpackaged counter the desk derives from them.
  const lots = await readAllRows((from, to) => {
    let query = context.supabase.from("lots").select(`
      id,lot_number,block,status,delivered_at,metadata,community_id,project_id,community:communities!inner(name,settings),
      plan:house_plans(code,name),elevation:house_plan_elevations(code),
      project:projects(client:contacts(full_name)),
      packages:start_packages!start_packages_lot_id_fkey(id,status),
      ${LOT_DELIVERY_EXCEPTIONS_EMBED}
    `).eq("org_id", context.orgId).in("status", ["owned", "developed", "assigned"])
    if (filters.communityId) query = query.eq("community_id", filters.communityId)
    if (filters.divisionId) query = query.eq("division_id", filters.divisionId)
    else if (divisionAccess.assignedOnly) query = query.in("division_id", divisionAccess.divisionIds)
    return query.order("lot_number").order("id").range(from, to)
  }, { cap: CANDIDATE_LOT_CAP + 1, label: "Failed to load start-package lots" })
  if (lots.truncated) throw new Error(`More than ${CANDIDATE_LOT_CAP} lots are waiting in scope; narrow the desk by community.`)
  const available = lots.rows.filter((lot) => !verticalStartRefusal({ status: lot.status, deliveredAt: lot.delivered_at, deliveryExceptions: lot.delivery_exceptions })
    && !(lot.packages ?? []).some((pkg: { status: string }) => pkg.status !== "cancelled"))
  const salesByProject = await loadSalesByProject(context.supabase, context.orgId, available.map((lot) => lot.project_id))
  return available.map((lot) => {
    const community = relation(lot.community)
    const plan = relation(lot.plan)
    const elevation = relation(lot.elevation)
    const sale = { ...(salesByProject.get(lot.project_id) ?? EMPTY_SALE), buyerName: text(relation(relation(lot.project)?.client)?.full_name) }
    const pressure = deriveSchedulePressure({
      status: "open", closingDate: sale.closingDate, cycle: targetCycleDays(community?.settings), blocker: null,
    })
    return {
      lotId: lot.id,
      communityId: lot.community_id,
      communityName: String(community?.name ?? "Community"),
      lotLabel: `${lot.block ? `${lot.block}-` : ""}${lot.lot_number}`,
      planLabel: [text(plan?.code) ?? text(plan?.name), text(elevation?.code)].filter(Boolean).join(" / ") || null,
      sale,
      mustStartBy: pressure.mustStartBy,
      daysToMustStart: pressure.daysToMustStart,
      cycleDays: pressure.cycleDays,
      cycleDaysConfigured: pressure.cycleDaysConfigured,
    }
  }).sort((a, b) => {
    // A sold home with no start package is the most expensive thing on this
    // desk, so the yard opens on the ones closest to their deadline.
    if (a.sale.isSold !== b.sale.isSold) return a.sale.isSold ? -1 : 1
    if (a.daysToMustStart !== b.daysToMustStart) {
      if (a.daysToMustStart === null) return 1
      if (b.daysToMustStart === null) return -1
      return a.daysToMustStart - b.daysToMustStart
    }
    return `${a.communityName} ${a.lotLabel}`.localeCompare(`${b.communityName} ${b.lotLabel}`)
  })
}

export type StartCandidateDTO = Awaited<ReturnType<typeof listStartPackageCandidates>>[number]
