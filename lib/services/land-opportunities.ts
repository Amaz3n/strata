import { createHash } from "node:crypto"

import { validateDocumentUpload } from "@/lib/files/content-policy"
import {
  DEFAULT_DILIGENCE_CHECKLIST,
  diligenceDeadlinePressure,
  diligenceSummary,
  hasApprovedAcquisition,
  landDealStage,
  pendingReminderThreshold,
  readAcquisitionSnapshot,
  type AcquisitionDecision,
  type AcquisitionReviewStatus,
  type AcquisitionSnapshot,
  type DiligenceDeadlinePressure,
  type DiligenceStatus,
  type DiligenceSummary,
  type LandDealStage,
} from "@/lib/land/diligence"
import { readAllRows, readPageOrEmpty } from "@/lib/land/paging"
import { divisionIsInScope, resolveDivisionScope, type DivisionScopeDecision } from "@/lib/land/scope"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { createCommunity } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { buildFilesStoragePath, buildInternalFileUrl, inferFileCategory } from "@/lib/services/files"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  acquisitionDecisionSchema,
  acquisitionReviewSubmitSchema,
  diligenceItemInputSchema,
  diligenceItemUpdateSchema,
  diligenceResolutionSchema,
  landCommunityLinkSchema,
  landOpportunityDropSchema,
  landOpportunityInputSchema,
  landOpportunityListSchema,
  landOpportunityUpdateSchema,
  type AcquisitionDecisionInput,
  type AcquisitionReviewSubmit,
  type DiligenceItemInput,
  type DiligenceResolution,
  type LandOpportunityInput,
  type LandOpportunityListInput,
  type LandOpportunityUpdate,
} from "@/lib/validation/land-opportunities"

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

/** A stage filter is resolved after the read, so it scans at most this many deals. */
export const LAND_DEAL_SCAN_CAP = 2_000
/** A deal's checklist, evidence and reviews are read whole up to these ceilings. */
const DILIGENCE_ITEM_CAP = 500
const EVIDENCE_CAP = 1_000
const REVIEW_CAP = 50
const TAKEDOWN_CAP = 200
/** People and companies offered in the deal's pickers. */
const PICKER_CAP = 500

// ---------------------------------------------------------------------------
// DTOs.
// ---------------------------------------------------------------------------

export interface LandDealListRow {
  id: string
  name: string
  code: string | null
  stage: LandDealStage
  divisionId: string | null
  divisionName: string | null
  market: string | null
  plannedLotCount: number | null
  purchasePriceCents: number | null
  pricePerLotCents: number | null
  depositCents: number
  diligenceEndsOn: string | null
  pressure: DiligenceDeadlinePressure
  diligence: DiligenceSummary
  leadName: string | null
}

export interface LandDealListPage {
  rows: LandDealListRow[]
  total: number
  page: number
  pageSize: number
  /** True when a stage filter stopped at LAND_DEAL_SCAN_CAP deals. */
  truncated: boolean
}

export interface DiligenceEvidenceDTO {
  linkId: string
  fileId: string
  fileName: string
  mimeType: string | null
  sizeBytes: number | null
  uploadedAt: string
  url: string
}

export interface DiligenceItemDTO {
  id: string
  title: string
  category: string
  ownerUserId: string | null
  ownerName: string | null
  ownerCompanyId: string | null
  ownerCompanyName: string | null
  dueOn: string | null
  status: DiligenceStatus
  finding: string | null
  waivedReason: string | null
  resolvedAt: string | null
  evidence: DiligenceEvidenceDTO[]
}

export interface AcquisitionApprovalDTO {
  id: string
  step: number
  label: string
  approverId: string
  approverName: string
  decision: "pending" | "approved" | "rejected"
  reason: string | null
  reviewedHash: string | null
  decidedAt: string | null
}

export interface AcquisitionReviewDTO {
  id: string
  revision: number
  decision: AcquisitionDecision
  summary: string | null
  status: AcquisitionReviewStatus
  submittedBy: string
  submittedByName: string
  submittedAt: string
  decidedAt: string | null
  contentHash: string
  snapshot: AcquisitionSnapshot
  approvals: AcquisitionApprovalDTO[]
}

export interface LinkedTakedownDTO {
  id: string
  name: string
  communityId: string
  scheduledDate: string | null
  actualDate: string | null
  lotCount: number
  pricePerLotCents: number | null
  status: "scheduled" | "closed" | "cancelled"
}

export interface LandDealDetail {
  id: string
  name: string
  code: string | null
  stage: LandDealStage
  divisionId: string | null
  divisionName: string | null
  sellerCompanyId: string | null
  sellerName: string | null
  address: string | null
  city: string | null
  state: string | null
  county: string | null
  acreage: number | null
  plannedLotCount: number | null
  purchasePriceCents: number | null
  depositCents: number
  contractExecutedOn: string | null
  diligenceEndsOn: string | null
  closingTargetOn: string | null
  leadUserId: string | null
  leadName: string | null
  communityId: string | null
  communityName: string | null
  droppedAt: string | null
  droppedReason: string | null
  notes: string | null
  pressure: DiligenceDeadlinePressure
  summary: DiligenceSummary
  items: DiligenceItemDTO[]
  /** Newest first. */
  reviews: AcquisitionReviewDTO[]
  takedowns: LinkedTakedownDTO[]
  /** True when a collection stopped at its ceiling; said on screen. */
  truncated: boolean
}

export interface LandPersonOption {
  id: string
  name: string
  /** Holds land.approve: may be named on an acquisition review. */
  canApprove: boolean
}

export interface LandCompanyOption {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Rows as PostgREST returns them.
// ---------------------------------------------------------------------------

type Person = { full_name: string | null; email: string | null }
/** PostgREST answers an embedded row as an object or a one-element array, depending on what it can infer. */
type Embedded<T> = T | T[] | null

function one<T>(value: Embedded<T> | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

interface DealRow {
  id: string
  name: string
  code: string | null
  division_id: string | null
  seller_company_id: string | null
  address: string | null
  city: string | null
  state: string | null
  county: string | null
  acreage: number | string | null
  planned_lot_count: number | null
  purchase_price_cents: number | null
  deposit_cents: number
  contract_executed_on: string | null
  diligence_ends_on: string | null
  closing_target_on: string | null
  lead_user_id: string | null
  community_id: string | null
  dropped_at: string | null
  dropped_reason: string | null
  notes: string | null
  metadata: Record<string, unknown> | null
  division?: Embedded<{ name: string | null }>
  lead?: Embedded<Person>
}

interface ItemRow {
  id: string
  land_opportunity_id: string
  title: string
  category: string
  owner_user_id: string | null
  owner_company_id: string | null
  due_on: string | null
  status: DiligenceStatus
  finding: string | null
  waived_reason: string | null
  resolved_at: string | null
  sort_order: number
  owner?: Embedded<Person>
  company?: Embedded<{ name: string | null }>
}

interface ReviewRow {
  id: string
  land_opportunity_id: string
  revision: number
  decision: AcquisitionDecision
  summary: string | null
  snapshot: unknown
  content_hash: string
  status: AcquisitionReviewStatus
  submitted_by: string
  submitted_at: string
  decided_at: string | null
  submitter?: Embedded<Person>
}

interface ApprovalRow {
  id: string
  review_id: string
  step: number
  label: string
  approver_id: string
  decision: "pending" | "approved" | "rejected"
  reason: string | null
  reviewed_hash: string | null
  decided_at: string | null
  approver?: Embedded<Person>
}

interface TakedownRow {
  id: string
  land_opportunity_id: string
  community_id: string
  name: string
  scheduled_date: string | null
  actual_date: string | null
  lot_count: number
  price_per_lot_cents: number | null
  status: "scheduled" | "closed" | "cancelled"
}

const DEAL_SELECT =
  "id, name, code, division_id, seller_company_id, address, city, state, county, acreage, planned_lot_count, purchase_price_cents, deposit_cents, contract_executed_on, diligence_ends_on, closing_target_on, lead_user_id, community_id, dropped_at, dropped_reason, notes, metadata, division:divisions(name), lead:app_users!land_opportunities_lead_user_id_fkey(full_name, email)"

function today() {
  return new Date().toISOString().slice(0, 10)
}

function personName(value: Embedded<Person> | undefined): string | null {
  const person = one(value)
  if (!person) return null
  return person.full_name || person.email || null
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapItem(row: ItemRow, evidence: DiligenceEvidenceDTO[]): DiligenceItemDTO {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    ownerUserId: row.owner_user_id,
    ownerName: personName(row.owner),
    ownerCompanyId: row.owner_company_id,
    ownerCompanyName: one(row.company)?.name ?? null,
    dueOn: row.due_on,
    status: row.status,
    finding: row.finding,
    waivedReason: row.waived_reason,
    resolvedAt: row.resolved_at,
    evidence,
  }
}

// ---------------------------------------------------------------------------
// Scope.
// ---------------------------------------------------------------------------

async function divisionDecision(context: OrgContext, requested?: string | null): Promise<DivisionScopeDecision> {
  return resolveDivisionScope(await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }), requested)
}

/**
 * The gate every deal read and write goes through: the deal exists in this org
 * and sits in a division the caller works in. A deal outside it is "not found",
 * exactly as the database's wall answers.
 */
async function requireDealScope(context: OrgContext, dealId: string): Promise<DealRow> {
  const decision = await divisionDecision(context)
  if (decision.kind === "none") throw new Error("Land deal not found")
  const { data, error } = await context.supabase
    .from("land_opportunities")
    .select(DEAL_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", dealId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load land deal: ${error.message}`)
  const row: DealRow | null = data
  if (!row || !divisionIsInScope(decision, row.division_id)) throw new Error("Land deal not found")
  return row
}

async function assertDivisionAllowed(context: OrgContext, divisionId: string | null | undefined) {
  if (divisionId === undefined) return
  const decision = await divisionDecision(context)
  if (!divisionIsInScope(decision, divisionId ?? null)) throw new Error("Division not found")
  if (!divisionId) return
  const { data, error } = await context.supabase
    .from("divisions")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", divisionId)
    .is("archived_at", null)
    .maybeSingle()
  if (error || !data) throw new Error("Division not found")
}

function assertOpen(deal: DealRow) {
  if (deal.dropped_at) throw new Error("This land deal was dropped. Reopen it before changing it.")
}

async function logMutation(input: {
  context: OrgContext
  eventType: string
  entityType: string
  entityId: string
  action: "insert" | "update" | "delete"
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  payload?: Record<string, unknown>
}) {
  const { context } = input
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
    }),
  ])
}

// ---------------------------------------------------------------------------
// The desk.
// ---------------------------------------------------------------------------

interface DealFacts {
  reviews: Map<string, Array<{ status: AcquisitionReviewStatus; decision: AcquisitionDecision }>>
  takedowns: Map<string, Array<{ status: "scheduled" | "closed" | "cancelled" }>>
  items: Map<string, Array<{ status: DiligenceStatus; dueOn: string | null }>>
}

async function loadDealFacts(context: OrgContext, dealIds: string[], withItems: boolean): Promise<DealFacts> {
  const facts: DealFacts = { reviews: new Map(), takedowns: new Map(), items: new Map() }
  if (dealIds.length === 0) return facts
  const [reviews, takedowns, items] = await Promise.all([
    readAllRows<{ land_opportunity_id: string; status: AcquisitionReviewStatus; decision: AcquisitionDecision }>(
      (from, to) =>
        context.supabase
          .from("land_acquisition_reviews")
          .select("land_opportunity_id, status, decision")
          .eq("org_id", context.orgId)
          .in("land_opportunity_id", dealIds)
          .order("id")
          .range(from, to),
      { cap: LAND_DEAL_SCAN_CAP * 10, label: "Failed to load acquisition reviews" },
    ),
    readAllRows<{ land_opportunity_id: string; status: "scheduled" | "closed" | "cancelled" }>(
      (from, to) =>
        context.supabase
          .from("lot_takedowns")
          .select("land_opportunity_id, status")
          .eq("org_id", context.orgId)
          .in("land_opportunity_id", dealIds)
          .order("id")
          .range(from, to),
      { cap: LAND_DEAL_SCAN_CAP * 10, label: "Failed to load linked takedowns" },
    ),
    withItems
      ? readAllRows<{ land_opportunity_id: string; status: DiligenceStatus; due_on: string | null }>(
          (from, to) =>
            context.supabase
              .from("land_diligence_items")
              .select("land_opportunity_id, status, due_on")
              .eq("org_id", context.orgId)
              .in("land_opportunity_id", dealIds)
              .order("id")
              .range(from, to),
          { cap: DILIGENCE_ITEM_CAP * dealIds.length, label: "Failed to load diligence items" },
        )
      : Promise.resolve({ rows: [], truncated: false }),
  ])
  for (const row of reviews.rows) {
    const list = facts.reviews.get(row.land_opportunity_id) ?? []
    list.push({ status: row.status, decision: row.decision })
    facts.reviews.set(row.land_opportunity_id, list)
  }
  for (const row of takedowns.rows) {
    const list = facts.takedowns.get(row.land_opportunity_id) ?? []
    list.push({ status: row.status })
    facts.takedowns.set(row.land_opportunity_id, list)
  }
  for (const row of items.rows) {
    const list = facts.items.get(row.land_opportunity_id) ?? []
    list.push({ status: row.status, dueOn: row.due_on })
    facts.items.set(row.land_opportunity_id, list)
  }
  return facts
}

function stageOf(row: DealRow, facts: DealFacts) {
  return landDealStage({
    droppedAt: row.dropped_at,
    contractExecutedOn: row.contract_executed_on,
    reviews: facts.reviews.get(row.id) ?? [],
    takedowns: facts.takedowns.get(row.id) ?? [],
  })
}

function listRow(row: DealRow, facts: DealFacts, now: string): LandDealListRow {
  const stage = stageOf(row, facts)
  const lots = row.planned_lot_count
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    stage,
    divisionId: row.division_id,
    divisionName: one(row.division)?.name ?? null,
    market: [row.city, row.state].filter(Boolean).join(", ") || null,
    plannedLotCount: lots,
    purchasePriceCents: row.purchase_price_cents,
    pricePerLotCents: row.purchase_price_cents !== null && lots ? Math.round(row.purchase_price_cents / lots) : null,
    depositCents: Number(row.deposit_cents ?? 0),
    diligenceEndsOn: row.diligence_ends_on,
    pressure: diligenceDeadlinePressure(
      {
        stage,
        diligenceEndsOn: row.diligence_ends_on,
        depositCents: Number(row.deposit_cents ?? 0),
        reviews: facts.reviews.get(row.id) ?? [],
      },
      now,
    ),
    diligence: diligenceSummary(facts.items.get(row.id) ?? [], now),
    leadName: personName(row.lead),
  }
}

/**
 * The land deals desk: every deal the caller's divisions reach, a page at a
 * time. Without a stage filter the database pages and counts; a stage is
 * derived, so a stage filter reads up to LAND_DEAL_SCAN_CAP deals and says so
 * when it stopped short.
 */
export async function listLandOpportunities(input: LandOpportunityListInput = {}, orgId?: string): Promise<LandDealListPage> {
  const parsed = landOpportunityListSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.read", context)
  const decision = await divisionDecision(context, parsed.divisionId)
  const empty: LandDealListPage = { rows: [], total: 0, page: parsed.page, pageSize: parsed.pageSize, truncated: false }
  if (decision.kind === "none") return empty
  const now = today()

  const base = (from: number, to: number, counted: boolean) => {
    let query = context.supabase
      .from("land_opportunities")
      .select(DEAL_SELECT, counted ? { count: "exact" } : undefined)
      .eq("org_id", context.orgId)
    if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
    if (parsed.search) {
      const term = parsed.search.replace(/[%,()]/g, " ").trim()
      if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%,city.ilike.%${term}%,county.ilike.%${term}%`)
    }
    // Live deals first, then the nearest feasibility deadline; id is the tiebreak
    // so pages never repeat or drop a row.
    return query
      .order("dropped_at", { ascending: false, nullsFirst: true })
      .order("diligence_ends_on", { ascending: true, nullsFirst: false })
      .order("name")
      .order("id")
      .range(from, to)
  }

  if (!parsed.stage) {
    const from = (parsed.page - 1) * parsed.pageSize
    const page = await readPageOrEmpty<DealRow>((start, end) => base(start, end, true), from, from + parsed.pageSize - 1)
    if (page.error) throw new Error(`Failed to list land deals: ${page.error.message}`)
    const facts = await loadDealFacts(context, page.data.map((row) => row.id), true)
    return {
      rows: page.data.map((row) => listRow(row, facts, now)),
      total: page.count ?? page.data.length,
      page: parsed.page,
      pageSize: parsed.pageSize,
      truncated: false,
    }
  }

  const all = await readAllRows<DealRow>((from, to) => base(from, to, false), {
    cap: LAND_DEAL_SCAN_CAP,
    label: "Failed to list land deals",
  })
  const stageFacts = await loadDealFacts(context, all.rows.map((row) => row.id), false)
  const matching = all.rows.filter((row) => stageOf(row, stageFacts) === parsed.stage)
  const start = (parsed.page - 1) * parsed.pageSize
  const pageRows = matching.slice(start, start + parsed.pageSize)
  const facts = await loadDealFacts(context, pageRows.map((row) => row.id), true)
  return {
    rows: pageRows.map((row) => listRow(row, facts, now)),
    total: matching.length,
    page: parsed.page,
    pageSize: parsed.pageSize,
    truncated: all.truncated,
  }
}

// ---------------------------------------------------------------------------
// The workbench.
// ---------------------------------------------------------------------------

/** One deal with its checklist, evidence, reviewed versions and takedowns, in one round. */
export async function getLandOpportunity(dealId: string, orgId?: string): Promise<LandDealDetail> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.read", context)
  const deal = await requireDealScope(context, dealId)

  const [items, evidence, reviews, takedowns, seller, community] = await Promise.all([
    readAllRows<ItemRow>(
      (from, to) =>
        context.supabase
          .from("land_diligence_items")
          .select(
            "id, land_opportunity_id, title, category, owner_user_id, owner_company_id, due_on, status, finding, waived_reason, resolved_at, sort_order, owner:app_users!land_diligence_items_owner_user_id_fkey(full_name, email), company:companies(name)",
          )
          .eq("org_id", context.orgId)
          .eq("land_opportunity_id", dealId)
          .order("sort_order")
          .order("created_at")
          .order("id")
          .range(from, to),
      { cap: DILIGENCE_ITEM_CAP, label: "Failed to load diligence items" },
    ),
    readAllRows<{
      id: string
      entity_id: string
      file: Embedded<{ id: string; file_name: string; mime_type: string | null; size_bytes: number | null; created_at: string; archived_at: string | null }>
    }>(
      (from, to) =>
        context.supabase
          .from("file_links")
          .select("id, entity_id, file:files(id, file_name, mime_type, size_bytes, created_at, archived_at)")
          .eq("org_id", context.orgId)
          .eq("land_opportunity_id", dealId)
          .eq("entity_type", "land_diligence_item")
          .order("created_at")
          .order("id")
          .range(from, to),
      { cap: EVIDENCE_CAP, label: "Failed to load diligence evidence" },
    ),
    context.supabase
      .from("land_acquisition_reviews")
      .select(
        "id, land_opportunity_id, revision, decision, summary, snapshot, content_hash, status, submitted_by, submitted_at, decided_at, submitter:app_users!land_acquisition_reviews_submitted_by_fkey(full_name, email)",
      )
      .eq("org_id", context.orgId)
      .eq("land_opportunity_id", dealId)
      .order("revision", { ascending: false })
      .limit(REVIEW_CAP + 1),
    context.supabase
      .from("lot_takedowns")
      .select("id, land_opportunity_id, community_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, status")
      .eq("org_id", context.orgId)
      .eq("land_opportunity_id", dealId)
      .order("scheduled_date", { ascending: true, nullsFirst: false })
      .order("id")
      .limit(TAKEDOWN_CAP + 1),
    deal.seller_company_id
      ? context.supabase.from("companies").select("name").eq("org_id", context.orgId).eq("id", deal.seller_company_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    deal.community_id
      ? context.supabase.from("communities").select("name").eq("org_id", context.orgId).eq("id", deal.community_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (reviews.error) throw new Error(`Failed to load acquisition reviews: ${reviews.error.message}`)
  if (takedowns.error) throw new Error(`Failed to load linked takedowns: ${takedowns.error.message}`)

  const reviewRows: ReviewRow[] = (reviews.data ?? []).slice(0, REVIEW_CAP)
  const takedownRows: TakedownRow[] = (takedowns.data ?? []).slice(0, TAKEDOWN_CAP)
  const approvals = reviewRows.length
    ? await context.supabase
        .from("land_acquisition_approvals")
        .select(
          "id, review_id, step, label, approver_id, decision, reason, reviewed_hash, decided_at, approver:app_users!land_acquisition_approvals_approver_id_fkey(full_name, email)",
        )
        .eq("org_id", context.orgId)
        .in("review_id", reviewRows.map((row) => row.id))
        .order("step")
    : { data: [], error: null }
  if (approvals.error) throw new Error(`Failed to load approvals: ${approvals.error.message}`)
  const approvalRows: ApprovalRow[] = approvals.data ?? []

  const evidenceByItem = new Map<string, DiligenceEvidenceDTO[]>()
  for (const link of evidence.rows) {
    const file = one(link.file)
    if (!file || file.archived_at) continue
    const list = evidenceByItem.get(link.entity_id) ?? []
    list.push({
      linkId: link.id,
      fileId: file.id,
      fileName: file.file_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      uploadedAt: file.created_at,
      url: buildInternalFileUrl(file.id),
    })
    evidenceByItem.set(link.entity_id, list)
  }

  const approvalsByReview = new Map<string, AcquisitionApprovalDTO[]>()
  for (const row of approvalRows) {
    const list = approvalsByReview.get(row.review_id) ?? []
    list.push({
      id: row.id,
      step: row.step,
      label: row.label,
      approverId: row.approver_id,
      approverName: personName(row.approver) ?? "Former member",
      decision: row.decision,
      reason: row.reason,
      reviewedHash: row.reviewed_hash,
      decidedAt: row.decided_at,
    })
    approvalsByReview.set(row.review_id, list)
  }

  const reviewFacts = reviewRows.map((row) => ({ status: row.status, decision: row.decision }))
  const stage = landDealStage({
    droppedAt: deal.dropped_at,
    contractExecutedOn: deal.contract_executed_on,
    reviews: reviewFacts,
    takedowns: takedownRows,
  })
  const now = today()
  const itemDtos = items.rows.map((row) => mapItem(row, evidenceByItem.get(row.id) ?? []))
  const sellerRow: { name: string | null } | null = seller.data
  const communityRow: { name: string | null } | null = community.data

  return {
    id: deal.id,
    name: deal.name,
    code: deal.code,
    stage,
    divisionId: deal.division_id,
    divisionName: one(deal.division)?.name ?? null,
    sellerCompanyId: deal.seller_company_id,
    sellerName: sellerRow?.name ?? null,
    address: deal.address,
    city: deal.city,
    state: deal.state,
    county: deal.county,
    acreage: numberOrNull(deal.acreage),
    plannedLotCount: deal.planned_lot_count,
    purchasePriceCents: deal.purchase_price_cents,
    depositCents: Number(deal.deposit_cents ?? 0),
    contractExecutedOn: deal.contract_executed_on,
    diligenceEndsOn: deal.diligence_ends_on,
    closingTargetOn: deal.closing_target_on,
    leadUserId: deal.lead_user_id,
    leadName: personName(deal.lead),
    communityId: deal.community_id,
    communityName: communityRow?.name ?? null,
    droppedAt: deal.dropped_at,
    droppedReason: deal.dropped_reason,
    notes: deal.notes,
    pressure: diligenceDeadlinePressure(
      { stage, diligenceEndsOn: deal.diligence_ends_on, depositCents: Number(deal.deposit_cents ?? 0), reviews: reviewFacts },
      now,
    ),
    summary: diligenceSummary(itemDtos, now),
    items: itemDtos,
    reviews: reviewRows.map((row) => ({
      id: row.id,
      revision: row.revision,
      decision: row.decision,
      summary: row.summary,
      status: row.status,
      submittedBy: row.submitted_by,
      submittedByName: personName(row.submitter) ?? "Former member",
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
      contentHash: row.content_hash,
      snapshot: readAcquisitionSnapshot(row.snapshot),
      approvals: approvalsByReview.get(row.id) ?? [],
    })),
    takedowns: takedownRows.map((row) => ({
      id: row.id,
      name: row.name,
      communityId: row.community_id,
      scheduledDate: row.scheduled_date,
      actualDate: row.actual_date,
      lotCount: row.lot_count,
      pricePerLotCents: row.price_per_lot_cents,
      status: row.status,
    })),
    truncated:
      items.truncated ||
      evidence.truncated ||
      (reviews.data ?? []).length > REVIEW_CAP ||
      (takedowns.data ?? []).length > TAKEDOWN_CAP,
  }
}

/** Who may lead, own an item, or be named an approver, and which companies may sell or consult. */
export async function listLandPickerOptions(orgId?: string): Promise<{
  people: LandPersonOption[]
  companies: LandCompanyOption[]
  truncated: boolean
}> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.read", context)
  // Role grants are not readable from a member session; the catalog read is the
  // service's, scoped to this org's memberships.
  const service = createServiceSupabaseClient()
  const [members, companies, approverRoles] = await Promise.all([
    service
      .from("memberships")
      .select("id, user_id, role_id, user:app_users!memberships_user_id_fkey(full_name, email)")
      .eq("org_id", context.orgId)
      .eq("status", "active")
      .order("created_at")
      .order("id")
      .limit(PICKER_CAP + 1),
    context.supabase
      .from("companies")
      .select("id, name")
      .eq("org_id", context.orgId)
      .is("archived_at", null)
      .order("name")
      .order("id")
      .limit(PICKER_CAP + 1),
    service.from("role_permissions").select("role_id").eq("permission_key", "land.approve"),
  ])
  if (members.error) throw new Error(`Failed to load team: ${members.error.message}`)
  if (companies.error) throw new Error(`Failed to load companies: ${companies.error.message}`)
  if (approverRoles.error) throw new Error(`Failed to load approvers: ${approverRoles.error.message}`)
  const memberRows: Array<{ id: string; user_id: string; role_id: string; user: Embedded<Person> }> = (members.data ?? []).slice(0, PICKER_CAP)
  const overrides = memberRows.length
    ? await service
        .from("membership_permission_overrides")
        .select("membership_id, effect")
        .eq("permission_key", "land.approve")
        .in("membership_id", memberRows.map((row) => row.id))
    : { data: [], error: null }
  if (overrides.error) throw new Error(`Failed to load approvers: ${overrides.error.message}`)
  const approverRoleIds = new Set((approverRoles.data ?? []).map((row: { role_id: string }) => row.role_id))
  const granted = new Set<string>()
  const denied = new Set<string>()
  const overrideRows: Array<{ membership_id: string; effect: string }> = overrides.data ?? []
  for (const row of overrideRows) {
    if (row.effect === "deny") denied.add(row.membership_id)
    else granted.add(row.membership_id)
  }
  const people = memberRows
    .map((row) => ({
      id: row.user_id,
      name: personName(row.user) ?? "Unnamed member",
      canApprove: !denied.has(row.id) && (approverRoleIds.has(row.role_id) || granted.has(row.id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const companyRows: LandCompanyOption[] = (companies.data ?? []).slice(0, PICKER_CAP)
  return {
    people,
    companies: companyRows,
    truncated: (members.data ?? []).length > PICKER_CAP || (companies.data ?? []).length > PICKER_CAP,
  }
}

// ---------------------------------------------------------------------------
// Deal mutations.
// ---------------------------------------------------------------------------

function dealPatch(parsed: LandOpportunityUpdate) {
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.code !== undefined) patch.code = parsed.code || null
  if (parsed.divisionId !== undefined) patch.division_id = parsed.divisionId ?? null
  if (parsed.sellerCompanyId !== undefined) patch.seller_company_id = parsed.sellerCompanyId ?? null
  if (parsed.address !== undefined) patch.address = parsed.address || null
  if (parsed.city !== undefined) patch.city = parsed.city || null
  if (parsed.state !== undefined) patch.state = parsed.state || null
  if (parsed.county !== undefined) patch.county = parsed.county || null
  if (parsed.acreage !== undefined) patch.acreage = parsed.acreage
  if (parsed.plannedLotCount !== undefined) patch.planned_lot_count = parsed.plannedLotCount
  if (parsed.purchasePriceCents !== undefined) patch.purchase_price_cents = parsed.purchasePriceCents
  if (parsed.depositCents !== undefined) patch.deposit_cents = parsed.depositCents
  if (parsed.contractExecutedOn !== undefined) patch.contract_executed_on = parsed.contractExecutedOn || null
  if (parsed.diligenceEndsOn !== undefined) patch.diligence_ends_on = parsed.diligenceEndsOn || null
  if (parsed.closingTargetOn !== undefined) patch.closing_target_on = parsed.closingTargetOn || null
  if (parsed.leadUserId !== undefined) patch.lead_user_id = parsed.leadUserId ?? null
  if (parsed.notes !== undefined) patch.notes = parsed.notes || null
  return patch
}

function duplicateName(error: { code?: string; message: string }) {
  return error.code === "23505" ? new Error("A land deal with this name already exists") : null
}

export async function createLandOpportunity(input: LandOpportunityInput, orgId?: string): Promise<{ id: string }> {
  const parsed = landOpportunityInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  await assertDivisionAllowed(context, parsed.divisionId ?? null)
  const { data, error } = await context.supabase
    .from("land_opportunities")
    .insert({ org_id: context.orgId, created_by: context.userId, ...dealPatch(parsed) })
    .select("*")
    .single()
  if (error) throw duplicateName(error) ?? new Error(`Failed to create land deal: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_opportunity.created",
    entityType: "land_opportunity",
    entityId: data.id,
    action: "insert",
    after: data,
    payload: { name: data.name, division_id: data.division_id },
  })
  return { id: data.id }
}

export async function updateLandOpportunity(dealId: string, input: LandOpportunityUpdate, orgId?: string): Promise<void> {
  const parsed = landOpportunityUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const before = await requireDealScope(context, dealId)
  assertOpen(before)
  if (parsed.divisionId !== undefined) await assertDivisionAllowed(context, parsed.divisionId ?? null)
  const patch = dealPatch(parsed)
  if (Object.keys(patch).length === 0) return
  const { data, error } = await context.supabase
    .from("land_opportunities")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", dealId)
    .select("*")
    .single()
  if (error) throw duplicateName(error) ?? new Error(`Failed to update land deal: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_opportunity.updated",
    entityType: "land_opportunity",
    entityId: dealId,
    action: "update",
    before: { ...before },
    after: data,
    payload: { name: data.name, fields: Object.keys(patch) },
  })
}

/** A dead deal is dropped with a reason, never deleted. A deal whose land closed cannot be dropped. */
export async function dropLandOpportunity(dealId: string, input: { reason: string }, orgId?: string): Promise<void> {
  const { reason } = landOpportunityDropSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const before = await requireDealScope(context, dealId)
  assertOpen(before)
  const { count, error: closedError } = await context.supabase
    .from("lot_takedowns")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("land_opportunity_id", dealId)
    .eq("status", "closed")
  if (closedError) throw new Error(`Failed to check linked takedowns: ${closedError.message}`)
  if ((count ?? 0) > 0) throw new Error("Land from this deal has closed; it can no longer be dropped")
  const droppedAt = new Date().toISOString()
  const { error } = await context.supabase
    .from("land_opportunities")
    .update({ dropped_at: droppedAt, dropped_reason: reason })
    .eq("org_id", context.orgId)
    .eq("id", dealId)
  if (error) throw new Error(`Failed to drop land deal: ${error.message}`)
  // An open review asks approvers to decide a deal that no longer exists.
  const { data: open } = await context.supabase
    .from("land_acquisition_reviews")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("land_opportunity_id", dealId)
    .eq("status", "in_review")
    .maybeSingle()
  if (open) {
    const { error: withdrawError } = await context.supabase.rpc("withdraw_land_acquisition_review", {
      p_org_id: context.orgId,
      p_review_id: open.id,
    })
    if (withdrawError) throw new Error(`Failed to withdraw the open review: ${withdrawError.message}`)
  }
  await logMutation({
    context,
    eventType: "land_opportunity.dropped",
    entityType: "land_opportunity",
    entityId: dealId,
    action: "update",
    before: { dropped_at: null, dropped_reason: null },
    after: { dropped_at: droppedAt, dropped_reason: reason },
    payload: { name: before.name, reason },
  })
}

/** A dropped deal can come back; nothing it recorded was lost. */
export async function reopenLandOpportunity(dealId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const before = await requireDealScope(context, dealId)
  if (!before.dropped_at) return
  const { error } = await context.supabase
    .from("land_opportunities")
    .update({ dropped_at: null, dropped_reason: null })
    .eq("org_id", context.orgId)
    .eq("id", dealId)
  if (error) throw new Error(`Failed to reopen land deal: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_opportunity.reopened",
    entityType: "land_opportunity",
    entityId: dealId,
    action: "update",
    before: { dropped_at: before.dropped_at, dropped_reason: before.dropped_reason },
    after: { dropped_at: null, dropped_reason: null },
    payload: { name: before.name },
  })
}

// ---------------------------------------------------------------------------
// Diligence items.
// ---------------------------------------------------------------------------

async function requireItemScope(context: OrgContext, itemId: string) {
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", itemId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load diligence item: ${error.message}`)
  if (!data) throw new Error("Diligence item not found")
  const deal = await requireDealScope(context, data.land_opportunity_id)
  return { item: data, deal }
}

function itemPatch(parsed: Partial<DiligenceItemInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.title !== undefined) patch.title = parsed.title
  if (parsed.category !== undefined) patch.category = parsed.category
  if (parsed.ownerUserId !== undefined) patch.owner_user_id = parsed.ownerUserId ?? null
  if (parsed.ownerCompanyId !== undefined) patch.owner_company_id = parsed.ownerCompanyId ?? null
  if (parsed.dueOn !== undefined) patch.due_on = parsed.dueOn || null
  return patch
}

async function nextSortOrder(context: OrgContext, dealId: string) {
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .select("sort_order")
    .eq("org_id", context.orgId)
    .eq("land_opportunity_id", dealId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to order diligence items: ${error.message}`)
  return (data?.sort_order ?? 0) + 10
}

export async function createDiligenceItem(dealId: string, input: DiligenceItemInput, orgId?: string): Promise<{ id: string }> {
  const parsed = diligenceItemInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const deal = await requireDealScope(context, dealId)
  assertOpen(deal)
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .insert({
      org_id: context.orgId,
      land_opportunity_id: dealId,
      sort_order: await nextSortOrder(context, dealId),
      ...itemPatch(parsed),
    })
    .select("*")
    .single()
  if (error) throw new Error(`Failed to add diligence item: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.created",
    entityType: "land_diligence_item",
    entityId: data.id,
    action: "insert",
    after: data,
    payload: { land_opportunity_id: dealId, title: data.title },
  })
  return { id: data.id }
}

/** Start a deal's checklist from the standard categories. Only an empty checklist is seeded. */
export async function seedDiligenceChecklist(dealId: string, orgId?: string): Promise<{ created: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const deal = await requireDealScope(context, dealId)
  assertOpen(deal)
  const { count, error: countError } = await context.supabase
    .from("land_diligence_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("land_opportunity_id", dealId)
  if (countError) throw new Error(`Failed to read the checklist: ${countError.message}`)
  if ((count ?? 0) > 0) throw new Error("This deal already has a checklist")
  const rows = DEFAULT_DILIGENCE_CHECKLIST.map((entry, index) => ({
    org_id: context.orgId,
    land_opportunity_id: dealId,
    title: entry.title,
    category: entry.category,
    sort_order: (index + 1) * 10,
  }))
  const { data, error } = await context.supabase.from("land_diligence_items").insert(rows).select("id")
  if (error) throw new Error(`Failed to start the checklist: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_opportunity.checklist_seeded",
    entityType: "land_opportunity",
    entityId: dealId,
    action: "update",
    after: { items: rows.map((row) => row.title) },
    payload: { name: deal.name, created: rows.length },
  })
  return { created: (data ?? []).length }
}

export async function updateDiligenceItem(itemId: string, input: Partial<DiligenceItemInput>, orgId?: string): Promise<void> {
  const parsed = diligenceItemUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  const patch = itemPatch(parsed)
  if (Object.keys(patch).length === 0) return
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", itemId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to update diligence item: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.updated",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "update",
    before: item,
    after: data,
    payload: { land_opportunity_id: deal.id, title: data.title },
  })
}

async function countEvidence(context: OrgContext, itemId: string) {
  const { count, error } = await context.supabase
    .from("file_links")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("entity_type", "land_diligence_item")
    .eq("entity_id", itemId)
  if (error) throw new Error(`Failed to count evidence: ${error.message}`)
  return count ?? 0
}

/** An open item with no evidence can be removed; anything with a record stays. */
export async function deleteDiligenceItem(itemId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  if (item.status !== "open") throw new Error("Only an open item can be removed; reopen it first")
  if ((await countEvidence(context, itemId)) > 0) throw new Error("This item has evidence filed; remove it before deleting the item")
  const { error } = await context.supabase.from("land_diligence_items").delete().eq("org_id", context.orgId).eq("id", itemId)
  if (error) throw new Error(`Failed to remove diligence item: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.deleted",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "delete",
    before: item,
    payload: { land_opportunity_id: deal.id, title: item.title },
  })
}

/**
 * Close an item out. Satisfied needs something to stand on -- a filed document
 * or a written finding; an issue needs the finding; a waiver needs its reason.
 */
export async function resolveDiligenceItem(itemId: string, input: DiligenceResolution, orgId?: string): Promise<void> {
  const parsed = diligenceResolutionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  const finding = parsed.finding?.trim() || null
  if (parsed.status === "satisfied" && !finding && (await countEvidence(context, itemId)) === 0) {
    throw new Error("File the evidence or write the finding before marking this satisfied")
  }
  const patch = {
    status: parsed.status,
    finding,
    waived_reason: parsed.status === "waived" ? parsed.waivedReason : null,
    resolved_at: new Date().toISOString(),
    resolved_by: context.userId,
  }
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", itemId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to resolve diligence item: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.resolved",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "update",
    before: item,
    after: data,
    payload: { land_opportunity_id: deal.id, title: item.title, status: parsed.status },
  })
}

export async function reopenDiligenceItem(itemId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  if (item.status === "open") return
  const { data, error } = await context.supabase
    .from("land_diligence_items")
    .update({ status: "open", resolved_at: null, resolved_by: null, waived_reason: null })
    .eq("org_id", context.orgId)
    .eq("id", itemId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to reopen diligence item: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.reopened",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "update",
    before: item,
    after: data,
    payload: { land_opportunity_id: deal.id, title: item.title },
  })
}

/**
 * File a document as evidence for an item. The file is filed on the deal
 * (files.land_opportunity_id), so the database walls it exactly like the deal
 * -- by division, and from members without land.read.
 */
export async function attachDiligenceEvidence(itemId: string, file: File, orgId?: string): Promise<{ fileId: string }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  const upload = validateDocumentUpload({ fileName: file.name, contentType: file.type, sizeBytes: file.size })
  const bytes = Buffer.from(await file.arrayBuffer())
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const storagePath = buildFilesStoragePath({ orgId: context.orgId, fileName: file.name, segments: ["land", deal.id] })
  await uploadFilesObject({ supabase: context.supabase, orgId: context.orgId, path: storagePath, bytes, contentType: upload.contentType })

  const { data: stored, error: fileError } = await context.supabase
    .from("files")
    .insert({
      org_id: context.orgId,
      land_opportunity_id: deal.id,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: upload.contentType,
      size_bytes: upload.sizeBytes,
      checksum,
      visibility: "private",
      category: inferFileCategory(file.name, upload.contentType),
      folder_path: `/Land deals/${deal.name}`,
      source: "upload",
      uploaded_by: context.userId,
    })
    .select("id, file_name")
    .single()
  if (fileError) throw new Error(`Failed to record the document: ${fileError.message}`)
  const { error: linkError } = await context.supabase.from("file_links").insert({
    org_id: context.orgId,
    file_id: stored.id,
    entity_type: "land_diligence_item",
    entity_id: itemId,
    land_opportunity_id: deal.id,
    link_role: "evidence",
    created_by: context.userId,
  })
  if (linkError) throw new Error(`Failed to file the evidence: ${linkError.message}`)
  await logMutation({
    context,
    eventType: "land_diligence_item.evidence_added",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "update",
    after: { file_id: stored.id, file_name: stored.file_name, checksum },
    payload: { land_opportunity_id: deal.id, title: item.title, file_name: stored.file_name },
  })
  return { fileId: stored.id }
}

/** Unfile a document from an item. The file itself stays on the deal's record. */
export async function removeDiligenceEvidence(itemId: string, linkId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { item, deal } = await requireItemScope(context, itemId)
  assertOpen(deal)
  const { data, error } = await context.supabase
    .from("file_links")
    .delete()
    .eq("org_id", context.orgId)
    .eq("id", linkId)
    .eq("entity_type", "land_diligence_item")
    .eq("entity_id", itemId)
    .select("id, file_id")
    .maybeSingle()
  if (error) throw new Error(`Failed to unfile the evidence: ${error.message}`)
  if (!data) throw new Error("Evidence not found")
  await logMutation({
    context,
    eventType: "land_diligence_item.evidence_removed",
    entityType: "land_diligence_item",
    entityId: itemId,
    action: "update",
    before: { file_id: data.file_id },
    payload: { land_opportunity_id: deal.id, title: item.title },
  })
}

// ---------------------------------------------------------------------------
// Acquisition reviews.
// ---------------------------------------------------------------------------

/**
 * Freeze the deal as it stands and ask the named approvers to decide it. The
 * database writes the snapshot and its hash in the same transaction that
 * checks the approvers, so what they see is exactly what was submitted.
 */
export async function submitAcquisitionReview(
  dealId: string,
  input: AcquisitionReviewSubmit,
  orgId?: string,
): Promise<{ reviewId: string }> {
  const parsed = acquisitionReviewSubmitSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const deal = await requireDealScope(context, dealId)
  assertOpen(deal)
  if (parsed.approvers.some((approver) => approver.userId === context.userId)) {
    throw new Error("You cannot approve a review you submit")
  }
  const { data, error } = await context.supabase.rpc("submit_land_acquisition_review", {
    p_org_id: context.orgId,
    p_opportunity_id: dealId,
    p_decision: parsed.decision,
    p_summary: parsed.summary ?? null,
    p_approvers: parsed.approvers.map((approver) => ({ user_id: approver.userId, label: approver.label ?? null })),
  })
  if (error) throw new Error(error.message)
  const reviewId = String(data)
  await logMutation({
    context,
    eventType: "land_acquisition_review.submitted",
    entityType: "land_acquisition_review",
    entityId: reviewId,
    action: "insert",
    after: { land_opportunity_id: dealId, decision: parsed.decision, approver_ids: parsed.approvers.map((a) => a.userId) },
    payload: {
      land_opportunity_id: dealId,
      deal_name: deal.name,
      decision: parsed.decision,
      approver_ids: parsed.approvers.map((approver) => approver.userId),
      division_id: deal.division_id,
    },
  })
  return { reviewId }
}

export async function withdrawAcquisitionReview(reviewId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.write", context)
  const { data, error } = await context.supabase.rpc("withdraw_land_acquisition_review", {
    p_org_id: context.orgId,
    p_review_id: reviewId,
  })
  if (error) throw new Error(error.message)
  const dealId = String(data)
  await logMutation({
    context,
    eventType: "land_acquisition_review.withdrawn",
    entityType: "land_acquisition_review",
    entityId: reviewId,
    action: "update",
    after: { status: "withdrawn" },
    payload: { land_opportunity_id: dealId },
  })
}

/**
 * The named approver decides the version they were shown. A changed deal has
 * a different hash, and the database refuses the decision.
 */
export async function decideAcquisitionApproval(
  approvalId: string,
  input: AcquisitionDecisionInput,
  orgId?: string,
): Promise<{ reviewStatus: AcquisitionReviewStatus }> {
  const parsed = acquisitionDecisionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land.approve", context)
  const { data, error } = await context.supabase.rpc("decide_land_acquisition_approval", {
    p_org_id: context.orgId,
    p_approval_id: approvalId,
    p_decision: parsed.decision,
    p_reason: parsed.reason ?? null,
    p_content_hash: parsed.contentHash,
  })
  if (error) throw new Error(error.message)
  const outcome: {
    review_id: string
    review_status: AcquisitionReviewStatus
    revision: number
    decision: AcquisitionDecision
    land_opportunity_id: string
    submitted_by: string
  } = data
  await logMutation({
    context,
    eventType: "land_acquisition_approval.decided",
    entityType: "land_acquisition_approval",
    entityId: approvalId,
    action: "update",
    after: { decision: parsed.decision, reason: parsed.reason ?? null, reviewed_hash: parsed.contentHash },
    payload: { land_opportunity_id: outcome.land_opportunity_id, review_id: outcome.review_id, decision: parsed.decision },
  })
  if (outcome.review_status !== "in_review") {
    const deal = await context.supabase
      .from("land_opportunities")
      .select("name, lead_user_id, division_id")
      .eq("org_id", context.orgId)
      .eq("id", outcome.land_opportunity_id)
      .maybeSingle()
    await logMutation({
      context,
      eventType: "land_acquisition_review.decided",
      entityType: "land_acquisition_review",
      entityId: outcome.review_id,
      action: "update",
      after: { status: outcome.review_status },
      payload: {
        land_opportunity_id: outcome.land_opportunity_id,
        deal_name: deal.data?.name ?? null,
        revision: outcome.revision,
        decision: outcome.decision,
        status: outcome.review_status,
        submitted_by: outcome.submitted_by,
        lead_user_id: deal.data?.lead_user_id ?? null,
        division_id: deal.data?.division_id ?? null,
      },
    })
  }
  return { reviewStatus: outcome.review_status }
}

// ---------------------------------------------------------------------------
// The resulting community.
// ---------------------------------------------------------------------------

async function requireApprovedAcquisition(context: OrgContext, dealId: string) {
  const { data, error } = await context.supabase
    .from("land_acquisition_reviews")
    .select("status, decision")
    .eq("org_id", context.orgId)
    .eq("land_opportunity_id", dealId)
  if (error) throw new Error(`Failed to read acquisition reviews: ${error.message}`)
  if (!hasApprovedAcquisition(data ?? [])) throw new Error("This deal needs an approved acquisition review first")
}

/** Open the community the deal becomes, in planning, carrying its name, division, market and lots. */
export async function createCommunityFromLandOpportunity(dealId: string, orgId?: string): Promise<{ communityId: string }> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("land.write", context), requirePermission("community.write", context)])
  const deal = await requireDealScope(context, dealId)
  assertOpen(deal)
  if (deal.community_id) throw new Error("This deal already has a community")
  await requireApprovedAcquisition(context, dealId)
  const community = await createCommunity(
    {
      name: deal.name,
      divisionId: deal.division_id,
      status: "planning",
      address: deal.address,
      city: deal.city,
      state: deal.state,
      plannedLotCount: deal.planned_lot_count,
    },
    context.orgId,
  )
  await linkCommunity(context, deal, community.id)
  return { communityId: community.id }
}

/** File the deal under an existing community: an expansion parcel. */
export async function linkLandOpportunityCommunity(dealId: string, input: { communityId: string }, orgId?: string): Promise<void> {
  const { communityId } = landCommunityLinkSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("land.write", context), requirePermission("community.write", context)])
  const deal = await requireDealScope(context, dealId)
  assertOpen(deal)
  const { data: community, error } = await context.supabase
    .from("communities")
    .select("id, division_id")
    .eq("org_id", context.orgId)
    .eq("id", communityId)
    .is("archived_at", null)
    .maybeSingle()
  if (error || !community) throw new Error("Community not found")
  const decision = await divisionDecision(context)
  if (!divisionIsInScope(decision, community.division_id ?? null)) throw new Error("Community not found")
  await linkCommunity(context, deal, communityId)
}

async function linkCommunity(context: OrgContext, deal: DealRow, communityId: string) {
  const { error } = await context.supabase
    .from("land_opportunities")
    .update({ community_id: communityId })
    .eq("org_id", context.orgId)
    .eq("id", deal.id)
  if (error) throw new Error(`Failed to link the community: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_opportunity.community_linked",
    entityType: "land_opportunity",
    entityId: deal.id,
    action: "update",
    before: { community_id: deal.community_id },
    after: { community_id: communityId },
    payload: { name: deal.name, community_id: communityId },
  })
}

/** The deal a community was acquired through, for the Land tab's one line back. */
export async function getCommunityLandOrigin(
  communityId: string,
  orgId?: string,
): Promise<Array<{ id: string; name: string }>> {
  const context = await requireOrgContext(orgId)
  if (!(await hasPermission("land.read", context))) return []
  const decision = await divisionDecision(context)
  if (decision.kind === "none") return []
  let query = context.supabase
    .from("land_opportunities")
    .select("id, name, division_id")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .order("name")
    .limit(20)
  if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load the community's land deals: ${error.message}`)
  return (data ?? []).map((row: { id: string; name: string }) => ({ id: row.id, name: row.name }))
}

/**
 * The wall in front of a diligence document's bytes. File routes read the row
 * and the object with the service role, past the files_land_scope policy, so
 * they ask this first: the caller holds land.read and reaches the deal's
 * division. Throws when they do not.
 */
export async function assertLandFileReadable(landOpportunityId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("land.read", context)
  await requireDealScope(context, landOpportunityId)
}

// ---------------------------------------------------------------------------
// Deadlines.
// ---------------------------------------------------------------------------

/** How far ahead an item's due date calls for attention. */
export const DILIGENCE_ITEM_REMINDER_DAYS = [14, 3, 0] as const
/** How far ahead the end of the feasibility period does: the deposit goes hard after it. */
export const DILIGENCE_PERIOD_REMINDER_DAYS = [30, 7, 0] as const
const SWEEP_BATCH = 200

function reminderKey(days: number) {
  return `reminded_at_${days}d`
}

/**
 * Announce diligence items coming due and feasibility periods running out.
 * Each threshold fires once per row; the marker lives in the row's metadata so
 * a re-run resumes rather than repeats. Runs as the system, from the land
 * deadlines cron.
 */
export async function sweepLandDiligenceDeadlines(now: Date = new Date()): Promise<{ items: number; deals: number }> {
  const service = createServiceSupabaseClient()
  const todayIso = now.toISOString().slice(0, 10)
  const horizon = (days: number) => {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }
  const daysOut = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000)

  const [itemsResult, dealsResult] = await Promise.all([
    service
      .from("land_diligence_items")
      .select("id, org_id, land_opportunity_id, title, due_on, owner_user_id, metadata, deal:land_opportunities!inner(name, lead_user_id, division_id, dropped_at)")
      .eq("status", "open")
      .is("deal.dropped_at", null)
      .not("due_on", "is", null)
      .lte("due_on", horizon(Math.max(...DILIGENCE_ITEM_REMINDER_DAYS)))
      .order("due_on")
      .order("id")
      .limit(SWEEP_BATCH),
    service
      .from("land_opportunities")
      .select("id, org_id, name, diligence_ends_on, deposit_cents, lead_user_id, division_id, metadata")
      .is("dropped_at", null)
      .not("diligence_ends_on", "is", null)
      .lte("diligence_ends_on", horizon(Math.max(...DILIGENCE_PERIOD_REMINDER_DAYS)))
      .order("diligence_ends_on")
      .order("id")
      .limit(SWEEP_BATCH),
  ])
  if (itemsResult.error) throw new Error(`Failed to load due diligence items: ${itemsResult.error.message}`)
  if (dealsResult.error) throw new Error(`Failed to load diligence periods: ${dealsResult.error.message}`)

  let items = 0
  const itemRows: Array<{
    id: string
    org_id: string
    land_opportunity_id: string
    title: string
    due_on: string
    owner_user_id: string | null
    metadata: Record<string, unknown> | null
    deal: Embedded<{ name: string; lead_user_id: string | null; division_id: string | null }>
  }> = itemsResult.data ?? []
  for (const row of itemRows) {
    const deal = one(row.deal)
    const metadata = row.metadata ?? {}
    const out = daysOut(row.due_on)
    const threshold = pendingReminderThreshold(DILIGENCE_ITEM_REMINDER_DAYS, out, metadata, reminderKey)
    if (threshold === null) continue
    await recordEvent({
      orgId: row.org_id,
      actorId: null,
      eventType: "land_diligence_item.due",
      entityType: "land_diligence_item",
      entityId: row.id,
      payload: {
        land_opportunity_id: row.land_opportunity_id,
        deal_name: deal?.name ?? null,
        title: row.title,
        due_on: row.due_on,
        days_out: out,
        owner_user_id: row.owner_user_id,
        lead_user_id: deal?.lead_user_id ?? null,
        division_id: deal?.division_id ?? null,
      },
    })
    const { error } = await service
      .from("land_diligence_items")
      .update({ metadata: { ...metadata, [reminderKey(threshold)]: now.toISOString() } })
      .eq("org_id", row.org_id)
      .eq("id", row.id)
    if (error) throw new Error(`Failed to record the diligence reminder: ${error.message}`)
    items += 1
  }

  const dealRows: Array<{
    id: string
    org_id: string
    name: string
    diligence_ends_on: string
    deposit_cents: number
    lead_user_id: string | null
    division_id: string | null
    metadata: Record<string, unknown> | null
  }> = dealsResult.data ?? []
  // A deal already decided (acquire or terminate approved) is past its feasibility question.
  const decided = new Set<string>()
  if (dealRows.length > 0) {
    const { data, error } = await service
      .from("land_acquisition_reviews")
      .select("land_opportunity_id")
      .in("land_opportunity_id", dealRows.map((row) => row.id))
      .eq("status", "approved")
    if (error) throw new Error(`Failed to read decided deals: ${error.message}`)
    const approved: Array<{ land_opportunity_id: string }> = data ?? []
    for (const row of approved) decided.add(row.land_opportunity_id)
  }

  let deals = 0
  for (const row of dealRows) {
    if (decided.has(row.id)) continue
    const metadata = row.metadata ?? {}
    const out = daysOut(row.diligence_ends_on)
    const threshold = pendingReminderThreshold(DILIGENCE_PERIOD_REMINDER_DAYS, out, metadata, reminderKey)
    if (threshold === null) continue
    await recordEvent({
      orgId: row.org_id,
      actorId: null,
      eventType: "land_opportunity.diligence_deadline",
      entityType: "land_opportunity",
      entityId: row.id,
      payload: {
        land_opportunity_id: row.id,
        deal_name: row.name,
        diligence_ends_on: row.diligence_ends_on,
        days_out: out,
        deposit_cents: Number(row.deposit_cents ?? 0),
        lead_user_id: row.lead_user_id,
        division_id: row.division_id,
      },
    })
    const { error } = await service
      .from("land_opportunities")
      .update({ metadata: { ...metadata, [reminderKey(threshold)]: now.toISOString() } })
      .eq("org_id", row.org_id)
      .eq("id", row.id)
    if (error) throw new Error(`Failed to record the diligence period reminder: ${error.message}`)
    deals += 1
  }

  return { items, deals }
}
