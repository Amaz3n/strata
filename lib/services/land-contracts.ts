import type { SupabaseClient } from "@supabase/supabase-js"

import { readAllRows } from "@/lib/land/paging"
import type { LandDepositCashInput, LandFeeCashInput, TakedownCashInput } from "@/lib/land/takedown-cash"
import { recordAudit } from "@/lib/services/audit"
import { requireCommunityScope } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  landAmendmentSchema,
  landContractCloseOutSchema,
  landContractExecutionSchema,
  landContractInputSchema,
  landContractUpdateSchema,
  landDepositInputSchema,
  landDepositPaymentSchema,
  landDepositSettlementSchema,
  landExtensionSchema,
  type LAND_AMENDMENT_KINDS,
  type LAND_CONTRACT_KINDS,
  type LAND_CONTRACT_STATUSES,
  type LAND_DEPOSIT_REFUNDABILITY,
  type LAND_DEPOSIT_STATUSES,
  type LandAmendmentInput,
  type LandContractInput,
  type LandDepositInput,
  type LandExtensionInput,
} from "@/lib/validation/land-contracts"

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export interface LandDepositDTO {
  id: string
  landContractId: string
  takedownId: string | null
  label: string | null
  dueOn: string
  amountCents: number
  refundability: (typeof LAND_DEPOSIT_REFUNDABILITY)[number]
  refundableUntil: string | null
  status: (typeof LAND_DEPOSIT_STATUSES)[number]
  paidOn: string | null
  paymentReference: string | null
  evidenceFileId: string | null
}

export interface LandAmendmentDTO {
  id: string
  landContractId: string
  takedownId: string | null
  kind: (typeof LAND_AMENDMENT_KINDS)[number]
  fromDate: string | null
  toDate: string | null
  feeCents: number
  dueOn: string | null
  reason: string
  evidenceFileId: string
  recordedBy: string
  recordedAt: string
}

export interface LandContractDTO {
  id: string
  communityId: string
  title: string
  contractNumber: string | null
  kind: (typeof LAND_CONTRACT_KINDS)[number]
  status: (typeof LAND_CONTRACT_STATUSES)[number]
  sellerCompanyId: string | null
  sellerName: string | null
  executedOn: string | null
  executedFileId: string | null
  totalLots: number
  basePricePerLotCents: number | null
  extensionTerms: string | null
  penaltyTerms: string | null
  deposits: LandDepositDTO[]
  amendments: LandAmendmentDTO[]
}

type ContractRow = {
  id: string
  community_id: string
  title: string
  contract_number: string | null
  kind: LandContractDTO["kind"]
  status: LandContractDTO["status"]
  seller_company_id: string | null
  executed_on: string | null
  executed_file_id: string | null
  total_lots: number
  base_price_per_lot_cents: number | null
  extension_terms: string | null
  penalty_terms: string | null
  seller?: { name?: string | null } | Array<{ name?: string | null }> | null
}

type DepositRow = {
  id: string
  land_contract_id: string
  takedown_id: string | null
  label: string | null
  due_on: string
  amount_cents: number
  refundability: LandDepositDTO["refundability"]
  refundable_until: string | null
  status: LandDepositDTO["status"]
  paid_on: string | null
  payment_reference: string | null
  evidence_file_id: string | null
}

type AmendmentRow = {
  id: string
  land_contract_id: string
  takedown_id: string | null
  kind: LandAmendmentDTO["kind"]
  from_date: string | null
  to_date: string | null
  fee_cents: number
  due_on: string | null
  reason: string
  evidence_file_id: string
  recorded_by: string
  recorded_at: string
}

const CONTRACT_SELECT =
  "id, community_id, title, contract_number, kind, status, seller_company_id, executed_on, executed_file_id, total_lots, base_price_per_lot_cents, extension_terms, penalty_terms, seller:companies(name)"
const DEPOSIT_SELECT =
  "id, land_contract_id, takedown_id, label, due_on, amount_cents, refundability, refundable_until, status, paid_on, payment_reference, evidence_file_id"
const AMENDMENT_SELECT =
  "id, land_contract_id, takedown_id, kind, from_date, to_date, fee_cents, due_on, reason, evidence_file_id, recorded_by, recorded_at"

/**
 * A ceiling on one community's contract records, not a page size. A community
 * signs a handful of land contracts with tens of deposits and amendments; this
 * stops a runaway read and fails loudly rather than showing part of a contract.
 */
const CONTRACT_RECORD_CAP = 2_000
/** The cash plan reads every open obligation in scope; past this it refuses rather than forecasting from part. */
const OBLIGATION_ROW_CAP = 50_000

function mapDeposit(row: DepositRow): LandDepositDTO {
  return {
    id: row.id,
    landContractId: row.land_contract_id,
    takedownId: row.takedown_id,
    label: row.label,
    dueOn: row.due_on,
    amountCents: Number(row.amount_cents),
    refundability: row.refundability,
    refundableUntil: row.refundable_until,
    status: row.status,
    paidOn: row.paid_on,
    paymentReference: row.payment_reference,
    evidenceFileId: row.evidence_file_id,
  }
}

function mapAmendment(row: AmendmentRow): LandAmendmentDTO {
  return {
    id: row.id,
    landContractId: row.land_contract_id,
    takedownId: row.takedown_id,
    kind: row.kind,
    fromDate: row.from_date,
    toDate: row.to_date,
    feeCents: Number(row.fee_cents),
    dueOn: row.due_on,
    reason: row.reason,
    evidenceFileId: row.evidence_file_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  }
}

function sellerName(relation: ContractRow["seller"]) {
  if (Array.isArray(relation)) return relation[0]?.name ?? null
  return relation?.name ?? null
}

function mapContract(row: ContractRow, deposits: LandDepositDTO[], amendments: LandAmendmentDTO[]): LandContractDTO {
  return {
    id: row.id,
    communityId: row.community_id,
    title: row.title,
    contractNumber: row.contract_number,
    kind: row.kind,
    status: row.status,
    sellerCompanyId: row.seller_company_id,
    sellerName: sellerName(row.seller),
    executedOn: row.executed_on,
    executedFileId: row.executed_file_id,
    totalLots: Number(row.total_lots),
    basePricePerLotCents: row.base_price_per_lot_cents == null ? null : Number(row.base_price_per_lot_cents),
    extensionTerms: row.extension_terms,
    penaltyTerms: row.penalty_terms,
    deposits: deposits.filter((deposit) => deposit.landContractId === row.id),
    amendments: amendments.filter((amendment) => amendment.landContractId === row.id),
  }
}

async function logContractMutation(
  context: OrgContext,
  input: {
    eventType: string
    contractId: string
    action: "insert" | "update" | "delete"
    before?: Record<string, unknown> | null
    after?: Record<string, unknown> | null
    payload?: Record<string, unknown>
  },
) {
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: input.eventType, entityType: "land_contract", entityId: input.contractId, payload: input.payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.action, entityType: "land_contract", entityId: input.contractId, before: input.before, after: input.after }),
  ])
}

/** The contract a write targets, inside the caller's org and division, with the authority to change it. */
async function contractForWrite(contractId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("land_contract.write", context)
  const { data, error } = await context.supabase
    .from("land_contracts")
    .select(CONTRACT_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", contractId)
    .maybeSingle()
  if (error || !data) throw new Error("Land contract not found")
  const contract = data as ContractRow
  await requireCommunityScope(contract.community_id, context)
  return { context, contract }
}

async function depositForWrite(depositId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("land_contract.write", context)
  const { data, error } = await context.supabase
    .from("land_contract_deposits")
    .select(`${DEPOSIT_SELECT}, contract:land_contracts!inner(community_id, status, title)`)
    .eq("org_id", context.orgId)
    .eq("id", depositId)
    .maybeSingle()
  if (error || !data) throw new Error("Deposit not found")
  const relation = Array.isArray(data.contract) ? data.contract[0] : data.contract
  if (!relation) throw new Error("Deposit not found")
  await requireCommunityScope(String(relation.community_id), context)
  return { context, deposit: data as DepositRow, contractStatus: String(relation.status) as LandContractDTO["status"] }
}

function contractPayload(parsed: Partial<LandContractInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.title !== undefined) patch.title = parsed.title
  if (parsed.contractNumber !== undefined) patch.contract_number = parsed.contractNumber || null
  if (parsed.kind !== undefined) patch.kind = parsed.kind
  if (parsed.sellerCompanyId !== undefined) patch.seller_company_id = parsed.sellerCompanyId
  if (parsed.totalLots !== undefined) patch.total_lots = parsed.totalLots
  if (parsed.basePricePerLotCents !== undefined) patch.base_price_per_lot_cents = parsed.basePricePerLotCents
  if (parsed.extensionTerms !== undefined) patch.extension_terms = parsed.extensionTerms || null
  if (parsed.penaltyTerms !== undefined) patch.penalty_terms = parsed.penaltyTerms || null
  return patch
}

/** A community's land contracts, each with its deposit schedule and amendments. */
export async function listCommunityLandContracts(communityId: string, orgId?: string): Promise<LandContractDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await requireCommunityScope(communityId, context)
  const [contracts, deposits, amendments] = await Promise.all([
    readAllRows<ContractRow>(
      (from, to) =>
        context.supabase.from("land_contracts").select(CONTRACT_SELECT)
          .eq("org_id", context.orgId).eq("community_id", communityId)
          .order("created_at").order("id").range(from, to),
      { cap: CONTRACT_RECORD_CAP, label: "Failed to load land contracts" },
    ),
    readAllRows<DepositRow>(
      (from, to) =>
        context.supabase.from("land_contract_deposits").select(`${DEPOSIT_SELECT}, contract:land_contracts!inner(community_id)`)
          .eq("org_id", context.orgId).eq("contract.community_id", communityId)
          .order("due_on").order("id").range(from, to),
      { cap: CONTRACT_RECORD_CAP, label: "Failed to load land contract deposits" },
    ),
    readAllRows<AmendmentRow>(
      (from, to) =>
        context.supabase.from("land_contract_amendments").select(`${AMENDMENT_SELECT}, contract:land_contracts!inner(community_id)`)
          .eq("org_id", context.orgId).eq("contract.community_id", communityId)
          .order("recorded_at").order("id").range(from, to),
      { cap: CONTRACT_RECORD_CAP, label: "Failed to load land contract amendments" },
    ),
  ])
  if (contracts.truncated || deposits.truncated || amendments.truncated) {
    throw new Error("This community's land contract records exceed the supported limit")
  }
  const depositDTOs = deposits.rows.map(mapDeposit)
  const amendmentDTOs = amendments.rows.map(mapAmendment)
  return contracts.rows.map((row) => mapContract(row, depositDTOs, amendmentDTOs))
}

export async function createLandContract(communityId: string, input: LandContractInput, orgId?: string): Promise<{ id: string }> {
  const parsed = landContractInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land_contract.write", context)
  await requireCommunityScope(communityId, context)
  const { data, error } = await context.supabase
    .from("land_contracts")
    .insert({ org_id: context.orgId, community_id: communityId, created_by: context.userId, ...contractPayload(parsed) })
    .select("id, community_id, title, kind, status")
    .single()
  if (error) throw new Error(`Failed to create the land contract: ${error.message}`)
  await logContractMutation(context, { eventType: "land_contract.created", contractId: data.id, action: "insert", after: data, payload: { community_id: communityId, title: data.title } })
  return { id: data.id }
}

/** A draft's terms are edited freely; an executed contract changes only by amendment. */
export async function updateLandContract(contractId: string, input: Partial<LandContractInput>, orgId?: string): Promise<void> {
  const parsed = landContractUpdateSchema.parse(input)
  const { context, contract } = await contractForWrite(contractId, orgId)
  if (contract.status !== "draft") throw new Error("An executed land contract's terms cannot change. Record an amendment.")
  const { data, error } = await context.supabase
    .from("land_contracts")
    .update(contractPayload(parsed))
    .eq("org_id", context.orgId)
    .eq("id", contractId)
    .select("id, title, kind, seller_company_id, total_lots, base_price_per_lot_cents")
    .single()
  if (error) throw new Error(`Failed to update the land contract: ${error.message}`)
  await logContractMutation(context, { eventType: "land_contract.updated", contractId, action: "update", before: contract, after: data, payload: { community_id: contract.community_id, title: data.title } })
}

/** Signing freezes the terms, the deposit schedule and the takedowns under it. */
export async function executeLandContract(contractId: string, input: { executedOn: string; executedFileId: string }, orgId?: string): Promise<void> {
  const parsed = landContractExecutionSchema.parse(input)
  const { context, contract } = await contractForWrite(contractId, orgId)
  if (contract.status !== "draft") throw new Error("This land contract is already executed.")
  const { error } = await context.supabase
    .from("land_contracts")
    .update({ status: "executed", executed_on: parsed.executedOn, executed_file_id: parsed.executedFileId })
    .eq("org_id", context.orgId)
    .eq("id", contractId)
    .eq("status", "draft")
  if (error) throw new Error(`Failed to execute the land contract: ${error.message}`)
  await logContractMutation(context, {
    eventType: "land_contract.executed",
    contractId,
    action: "update",
    before: { status: contract.status },
    after: { status: "executed", executed_on: parsed.executedOn, executed_file_id: parsed.executedFileId },
    payload: { community_id: contract.community_id, title: contract.title, executed_on: parsed.executedOn },
  })
}

export async function closeOutLandContract(contractId: string, input: { status: "terminated" | "completed" }, orgId?: string): Promise<void> {
  const parsed = landContractCloseOutSchema.parse(input)
  const { context, contract } = await contractForWrite(contractId, orgId)
  if (contract.status !== "executed") throw new Error("Only an executed land contract is terminated or completed.")
  const { error } = await context.supabase.from("land_contracts").update({ status: parsed.status }).eq("org_id", context.orgId).eq("id", contractId)
  if (error) throw new Error(`Failed to close out the land contract: ${error.message}`)
  await logContractMutation(context, { eventType: `land_contract.${parsed.status}`, contractId, action: "update", before: { status: contract.status }, after: { status: parsed.status }, payload: { community_id: contract.community_id, title: contract.title } })
}

/** Deposits are scheduled while the contract is a draft: the schedule is a signed term. */
export async function scheduleLandContractDeposit(contractId: string, input: LandDepositInput, orgId?: string): Promise<{ id: string }> {
  const parsed = landDepositInputSchema.parse(input)
  const { context, contract } = await contractForWrite(contractId, orgId)
  if (contract.status !== "draft") throw new Error("The deposit schedule of an executed land contract cannot change.")
  const { data, error } = await context.supabase
    .from("land_contract_deposits")
    .insert({
      org_id: context.orgId,
      land_contract_id: contractId,
      takedown_id: parsed.takedownId ?? null,
      label: parsed.label || null,
      due_on: parsed.dueOn,
      amount_cents: parsed.amountCents,
      refundability: parsed.refundability,
      refundable_until: parsed.refundableUntil ?? null,
    })
    .select(DEPOSIT_SELECT)
    .single()
  if (error) throw new Error(`Failed to schedule the deposit: ${error.message}`)
  await logContractMutation(context, { eventType: "land_contract.deposit_scheduled", contractId, action: "update", after: data, payload: { community_id: contract.community_id, deposit_id: data.id, amount_cents: parsed.amountCents, due_on: parsed.dueOn } })
  return { id: data.id }
}

export async function removeLandContractDeposit(depositId: string, orgId?: string): Promise<void> {
  const { context, deposit, contractStatus } = await depositForWrite(depositId, orgId)
  if (contractStatus !== "draft" || deposit.status !== "scheduled") throw new Error("The deposit schedule of an executed land contract cannot change.")
  const { error } = await context.supabase.from("land_contract_deposits").delete().eq("org_id", context.orgId).eq("id", depositId)
  if (error) throw new Error(`Failed to remove the deposit: ${error.message}`)
  await logContractMutation(context, { eventType: "land_contract.deposit_removed", contractId: deposit.land_contract_id, action: "update", before: deposit, payload: { deposit_id: depositId } })
}

/** Money paid to the seller, with its receipt. */
export async function recordLandContractDepositPayment(
  depositId: string,
  input: { paidOn: string; paymentReference?: string | null; evidenceFileId: string },
  orgId?: string,
): Promise<void> {
  const parsed = landDepositPaymentSchema.parse(input)
  const { context, deposit, contractStatus } = await depositForWrite(depositId, orgId)
  if (contractStatus === "draft") throw new Error("Execute the land contract before recording a deposit payment.")
  if (deposit.status !== "scheduled") throw new Error("This deposit is already recorded as paid.")
  const { error } = await context.supabase
    .from("land_contract_deposits")
    .update({ status: "paid", paid_on: parsed.paidOn, payment_reference: parsed.paymentReference || null, evidence_file_id: parsed.evidenceFileId })
    .eq("org_id", context.orgId)
    .eq("id", depositId)
    .eq("status", "scheduled")
  if (error) throw new Error(`Failed to record the deposit payment: ${error.message}`)
  await logContractMutation(context, {
    eventType: "land_contract.deposit_paid",
    contractId: deposit.land_contract_id,
    action: "update",
    before: { status: deposit.status },
    after: { status: "paid", paid_on: parsed.paidOn, evidence_file_id: parsed.evidenceFileId },
    payload: { deposit_id: depositId, amount_cents: Number(deposit.amount_cents), paid_on: parsed.paidOn },
  })
}

/** A paid deposit comes back to the builder, or is lost to the seller. */
export async function settleLandContractDeposit(depositId: string, input: { outcome: "refunded" | "forfeited" }, orgId?: string): Promise<void> {
  const parsed = landDepositSettlementSchema.parse(input)
  const { context, deposit } = await depositForWrite(depositId, orgId)
  if (deposit.status !== "paid") throw new Error("Only a paid deposit is refunded or forfeited.")
  if (parsed.outcome === "refunded" && deposit.refundability === "non_refundable") {
    throw new Error("This deposit is non-refundable under the contract.")
  }
  const { error } = await context.supabase
    .from("land_contract_deposits")
    .update({ status: parsed.outcome })
    .eq("org_id", context.orgId)
    .eq("id", depositId)
    .eq("status", "paid")
  if (error) throw new Error(`Failed to record the deposit ${parsed.outcome === "refunded" ? "refund" : "forfeit"}: ${error.message}`)
  await logContractMutation(context, {
    eventType: `land_contract.deposit_${parsed.outcome}`,
    contractId: deposit.land_contract_id,
    action: "update",
    before: { status: deposit.status },
    after: { status: parsed.outcome },
    payload: { deposit_id: depositId, amount_cents: Number(deposit.amount_cents) },
  })
}

/**
 * Move a takedown's close date under an executed contract. The amendment and
 * the new date are written in one database transaction, so a takedown never
 * moves without the signed extension that moved it.
 */
export async function recordLandContractExtension(input: LandExtensionInput, orgId?: string): Promise<{ id: string }> {
  const parsed = landExtensionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("land_contract.write", context)
  const { data: takedown, error: takedownError } = await context.supabase
    .from("lot_takedowns")
    .select("id, community_id, name, scheduled_date, land_contract_id")
    .eq("org_id", context.orgId)
    .eq("id", parsed.takedownId)
    .maybeSingle()
  if (takedownError || !takedown) throw new Error("Lot takedown not found")
  await requireCommunityScope(takedown.community_id, context)
  if (!takedown.land_contract_id) throw new Error("This takedown is not under a land contract; edit its date directly.")
  const { data, error } = await createServiceSupabaseClient().rpc("record_land_contract_extension", {
    p_org_id: context.orgId,
    p_takedown_id: parsed.takedownId,
    p_to_date: parsed.toDate,
    p_fee_cents: parsed.feeCents,
    p_fee_due_on: parsed.feeDueOn ?? null,
    p_reason: parsed.reason,
    p_evidence_file_id: parsed.evidenceFileId,
    p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const amendmentId = String(data)
  await logContractMutation(context, {
    eventType: "land_contract.extended",
    contractId: takedown.land_contract_id,
    action: "update",
    before: { takedown_id: takedown.id, scheduled_date: takedown.scheduled_date },
    after: { takedown_id: takedown.id, scheduled_date: parsed.toDate, amendment_id: amendmentId, fee_cents: parsed.feeCents },
    payload: { community_id: takedown.community_id, takedown_id: takedown.id, name: takedown.name, from_date: takedown.scheduled_date, to_date: parsed.toDate, fee_cents: parsed.feeCents },
  })
  return { id: amendmentId }
}

/** A penalty or other change after signing, with its reason and the signed evidence. */
export async function recordLandContractAmendment(contractId: string, input: LandAmendmentInput, orgId?: string): Promise<{ id: string }> {
  const parsed = landAmendmentSchema.parse(input)
  const { context, contract } = await contractForWrite(contractId, orgId)
  if (contract.status !== "executed") throw new Error("Only an executed land contract is amended.")
  const { data, error } = await context.supabase
    .from("land_contract_amendments")
    .insert({
      org_id: context.orgId,
      land_contract_id: contractId,
      takedown_id: parsed.takedownId ?? null,
      kind: parsed.kind,
      fee_cents: parsed.feeCents,
      due_on: parsed.dueOn ?? null,
      reason: parsed.reason,
      evidence_file_id: parsed.evidenceFileId,
      recorded_by: context.userId,
    })
    .select(AMENDMENT_SELECT)
    .single()
  if (error) throw new Error(`Failed to record the amendment: ${error.message}`)
  await logContractMutation(context, { eventType: "land_contract.amended", contractId, action: "update", after: data, payload: { community_id: contract.community_id, amendment_id: data.id, kind: parsed.kind, fee_cents: parsed.feeCents } })
  return { id: data.id }
}

export interface LandObligationRows {
  takedowns: Array<TakedownCashInput & { communityId: string; name: string }>
  deposits: Array<LandDepositCashInput & { communityId: string }>
  fees: Array<LandFeeCashInput & { communityId: string }>
}

/**
 * The open land obligations behind the cash plan: scheduled takedowns, every
 * deposit tied to a takedown or still to be paid, and fees not yet due — read
 * to the end. `communityIds` null means the whole org; the caller has already
 * decided the scope.
 */
export async function loadLandObligationRows(
  supabase: SupabaseClient,
  orgId: string,
  { communityIds, today }: { communityIds: string[] | null; today: string },
): Promise<LandObligationRows> {
  if (communityIds?.length === 0) return { takedowns: [], deposits: [], fees: [] }
  const relation = (value: unknown) => {
    const row = Array.isArray(value) ? value[0] : value
    return row && typeof row === "object" ? String(Reflect.get(row, "community_id") ?? "") : ""
  }
  const [takedowns, deposits, fees] = await Promise.all([
    readAllRows<{ id: string; community_id: string; name: string; scheduled_date: string | null; lot_count: number; price_per_lot_cents: number | null; status: TakedownCashInput["status"] }>(
      (from, to) => {
        let query = supabase.from("lot_takedowns").select("id, community_id, name, scheduled_date, lot_count, price_per_lot_cents, status")
          .eq("org_id", orgId).eq("status", "scheduled")
        if (communityIds) query = query.in("community_id", communityIds)
        return query.order("id").range(from, to)
      },
      { cap: OBLIGATION_ROW_CAP, label: "Failed to load scheduled takedowns" },
    ),
    // Scheduled deposits are cash to come; paid and applied ones tied to a
    // takedown are credits against its price.
    readAllRows<{ id: string; takedown_id: string | null; due_on: string; amount_cents: number; status: LandDepositCashInput["status"]; contract: unknown }>(
      (from, to) => {
        let query = supabase.from("land_contract_deposits").select("id, takedown_id, due_on, amount_cents, status, contract:land_contracts!inner(community_id)")
          .eq("org_id", orgId).in("status", ["scheduled", "paid", "applied"])
        if (communityIds) query = query.in("contract.community_id", communityIds)
        return query.order("id").range(from, to)
      },
      { cap: OBLIGATION_ROW_CAP, label: "Failed to load land contract deposits" },
    ),
    readAllRows<{ id: string; due_on: string | null; fee_cents: number; contract: unknown }>(
      (from, to) => {
        let query = supabase.from("land_contract_amendments").select("id, due_on, fee_cents, contract:land_contracts!inner(community_id)")
          .eq("org_id", orgId).gt("fee_cents", 0).gte("due_on", today)
        if (communityIds) query = query.in("contract.community_id", communityIds)
        return query.order("id").range(from, to)
      },
      { cap: OBLIGATION_ROW_CAP, label: "Failed to load land contract fees" },
    ),
  ])
  if (takedowns.truncated || deposits.truncated || fees.truncated) {
    throw new Error("Land obligations in this scope exceed the supported limit")
  }
  return {
    takedowns: takedowns.rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      name: row.name,
      scheduledDate: row.scheduled_date,
      lotCount: Number(row.lot_count),
      pricePerLotCents: row.price_per_lot_cents == null ? null : Number(row.price_per_lot_cents),
      status: row.status,
    })),
    deposits: deposits.rows.map((row) => ({
      communityId: relation(row.contract),
      takedownId: row.takedown_id,
      dueOn: row.due_on,
      amountCents: Number(row.amount_cents),
      status: row.status,
    })),
    fees: fees.rows.map((row) => ({ communityId: relation(row.contract), dueOn: row.due_on, feeCents: Number(row.fee_cents) })),
  }
}
