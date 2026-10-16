import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAuthorization } from "@/lib/services/authorization"
import { ensureVendorRoleWithClient, resolveProjectVendorRole } from "@/lib/services/party-roles"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isIssuedPurchaseOrder, lockedTermsChanged, PO_LOCKED_MESSAGE } from "@/lib/purchasing/po-lock"
import {
  bucketCommitmentChangeOrderRows,
  buildCommitmentRegister,
  composeCommitmentPosition,
  emptyCommitmentBillRollup,
  emptyCommitmentChangeOrderTotals,
  summarizeCommitmentBillRows,
  PENDING_CHANGE_ORDER_STATUSES,
  type CommitmentBillRollup,
  type CommitmentChangeOrderTotals,
  type CommitmentRegisterQuery,
  type CommitmentRegisterResult,
  type CommitmentRegisterRow,
} from "@/lib/financials/commitment-position"
import { commitmentInputSchema, commitmentUpdateSchema, commitmentLineInputSchema, commitmentLineUpdateSchema, commitmentExecutionSchema, type CommitmentInput, type CommitmentUpdateInput, type CommitmentLineInput, type CommitmentLineUpdateInput, type CommitmentExecutionInput } from "@/lib/validation/commitments"
import { commitmentCreatedByUserId } from "@/lib/financials/separation-of-duties"
import { extendedLineCents, poLinesTotalCents } from "@/lib/purchasing/po-line-amount"
import { assertCommitmentApprovalSeparated } from "@/lib/services/separation-of-duties"
import { getCompanyPrequalificationWarning } from "@/lib/services/prequalification"
import { getComplianceRules } from "@/lib/services/compliance"
import {
  assertCommitmentExecutable,
  assertSubcontractExecutionCompliance,
} from "@/lib/services/subcontract-execution"

export type {
  CommitmentRegisterExceptions,
  CommitmentRegisterFacets,
  CommitmentRegisterFlag,
  CommitmentRegisterPagination,
  CommitmentRegisterQuery,
  CommitmentRegisterRollup,
} from "@/lib/financials/commitment-position"
export { isCommitmentAwaitingExecution } from "@/lib/financials/commitment-position"

export type CommitmentStatus = "draft" | "approved" | "complete" | "canceled"
export type CommitmentType = "subcontract" | "purchase_order"

const COMMITMENT_SELECT = `
      id, org_id, project_id, company_id, commitment_type, title, status, total_cents, currency, contract_number, scope, terms, retainage_percent, executed_at, executed_file_id, source_document_id, signature_envelope_id, issued_at, start_date, end_date, metadata, created_at, updated_at,
      project:projects(id, name),
      company:companies(id, name)
    `

export interface CommitmentSummary {
  id: string
  org_id: string
  project_id: string
  commitment_type: CommitmentType
  project_name?: string
  company_id?: string
  company_name?: string
  title: string
  status: CommitmentStatus | string
  total_cents?: number
  currency: string
  contract_number?: string
  scope?: string
  terms?: string
  retainage_percent?: number
  executed_at?: string
  executed_file_id?: string
  /** How execution was captured: `esign` when signed in Arc, `recorded` when entered by hand. */
  executed_signature_method?: string
  source_document_id?: string
  signature_envelope_id?: string
  start_date?: string
  end_date?: string
  issued_at?: string
  created_at: string
  updated_at?: string
  /**
   * Invoiced against the commitment: every bill past drafting that was not
   * rejected, net of vendor credits. This is the claim on the contract, which is
   * what over-billing is measured against.
   */
  billed_cents?: number
  /** The slice of `billed_cents` that is approved into the books. */
  approved_billed_cents?: number
  /** Invoiced and awaiting approval — exposure that is not yet cost. */
  pending_billed_cents?: number
  paid_cents?: number
  /** Retainage withheld across booked bills on this commitment. */
  retainage_held_cents?: number
  approved_change_orders_cents?: number
  /** Draft and sent change orders: value that lands only if they are approved. */
  pending_change_orders_cents?: number
  revised_total_cents?: number
  /** Revised total less invoiced. Signed — negative means over-billed. */
  remaining_cents?: number
  /** Bills against the commitment, excluding vendor credits. */
  bill_count?: number
  prequalification_warning?: string
}

export interface CommitmentLine {
  id: string
  org_id: string
  commitment_id: string
  cost_code_id: string | null
  budget_line_id?: string | null
  cost_code_code?: string
  cost_code_name?: string
  description: string
  quantity: number
  unit: string
  unit_cost_cents: number
  total_cents: number
  scheduled_value_cents?: number | null
  retainage_percent?: number | null
  sort_order: number
}

/**
 * The stored commitment only. Position fields are left unset on purpose —
 * `enrichCommitments` is the one place that computes them.
 */
function mapCommitment(row: any): CommitmentSummary {
  const totalCents = row.total_cents ?? undefined
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    commitment_type: row.commitment_type === "purchase_order" ? "purchase_order" : "subcontract",
    project_name: row.project?.name ?? undefined,
    company_id: row.company_id ?? undefined,
    company_name: row.company?.name ?? undefined,
    title: row.title,
    status: row.status ?? "draft",
    total_cents: totalCents,
    currency: row.currency ?? "usd",
    contract_number: row.contract_number ?? undefined,
    scope: row.scope ?? undefined,
    terms: row.terms ?? undefined,
    retainage_percent: row.retainage_percent != null ? Number(row.retainage_percent) : undefined,
    executed_at: row.executed_at ?? undefined,
    executed_file_id: row.executed_file_id ?? undefined,
    executed_signature_method:
      typeof row.metadata?.executed_signature?.method === "string"
        ? row.metadata.executed_signature.method
        : undefined,
    source_document_id: row.source_document_id ?? undefined,
    signature_envelope_id: row.signature_envelope_id ?? undefined,
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    issued_at: row.issued_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    prequalification_warning: typeof row.metadata?.prequalification_warning === "string" ? row.metadata.prequalification_warning : undefined,
  }
}

async function loadCommitmentChangeOrderTotals(
  supabase: SupabaseClient,
  orgId: string,
  commitmentIds: string[],
): Promise<Map<string, CommitmentChangeOrderTotals>> {
  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select("commitment_id, status, total_cents")
    .eq("org_id", orgId)
    .in("status", ["approved", ...PENDING_CHANGE_ORDER_STATUSES])
    .in("commitment_id", commitmentIds)

  if (error) {
    throw new Error(`Failed to load commitment change order totals: ${error.message}`)
  }

  return bucketCommitmentChangeOrderRows(data ?? [])
}

async function loadCommitmentBillRollups(
  supabase: SupabaseClient,
  orgId: string,
  commitmentIds: string[],
): Promise<Map<string, CommitmentBillRollup>> {
  const { data, error } = await supabase
    .from("vendor_bills")
    .select("commitment_id, status, total_cents, paid_cents, retainage_cents, metadata")
    .eq("org_id", orgId)
    .in("commitment_id", commitmentIds)

  if (error) {
    throw new Error(`Failed to load vendor bills: ${error.message}`)
  }

  return summarizeCommitmentBillRows(data ?? [])
}

/**
 * Reads the two tables a commitment's position depends on and composes it.
 * The math itself is pure, in `lib/financials/commitment-position.ts`.
 */
async function enrichCommitments(
  supabase: SupabaseClient,
  orgId: string,
  commitments: CommitmentSummary[],
): Promise<CommitmentSummary[]> {
  const commitmentIds = Array.from(new Set(commitments.map((commitment) => commitment.id)))
  if (commitmentIds.length === 0) return commitments

  const [billRollups, changeOrderTotals] = await Promise.all([
    loadCommitmentBillRollups(supabase, orgId, commitmentIds),
    loadCommitmentChangeOrderTotals(supabase, orgId, commitmentIds),
  ])

  return commitments.map((commitment) =>
    composeCommitmentPosition(
      commitment,
      billRollups.get(commitment.id) ?? emptyCommitmentBillRollup(),
      changeOrderTotals.get(commitment.id) ?? emptyCommitmentChangeOrderTotals(),
    ),
  )
}

async function ensureProjectVendorForCommitment({
  supabase,
  orgId,
  projectId,
  companyId,
  scope,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  companyId: string
  scope?: string | null
}) {
  const { data: existing, error: existingError } = await supabase
    .from("project_vendors")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .limit(1)

  if (existingError) {
    throw new Error(`Failed to check project vendor roster: ${existingError.message}`)
  }
  if ((existing ?? []).length > 0) return

  // The roster role comes from the party's roles, not `company_type`. A company
  // that became a vendor through `ensureVendorRoleWithClient` never had its type
  // column touched, so reading it here produced a roster entry that disagreed
  // with the directory about what this company is.
  const role = await resolveProjectVendorRole(supabase, orgId, companyId)

  const { error } = await supabase.from("project_vendors").insert({
    org_id: orgId,
    project_id: projectId,
    company_id: companyId,
    role,
    status: "active",
    scope: scope ?? null,
  })

  if (error && !String(error.message ?? "").toLowerCase().includes("duplicate")) {
    throw new Error(`Failed to add commitment company to project vendors: ${error.message}`)
  }
}

export async function listProjectCommitments(projectId: string, orgId?: string, type?: CommitmentType): Promise<CommitmentSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  let query = supabase
    .from("commitments")
    .select(COMMITMENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (type) query = query.eq("commitment_type", type)
  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list commitments: ${error.message}`)
  }

  return enrichCommitments(supabase, resolvedOrgId, (data ?? []).map(mapCommitment))
}

// ============================================================================
// Company commitment register
// ============================================================================

export type CommitmentRegister = CommitmentRegisterResult<CommitmentSummary & CommitmentRegisterRow>

const REGISTER_SOURCE_LIMIT = 500

/**
 * One vendor's contract register: every commitment we hold with them, with the
 * position on each and the exceptions worth acting on.
 */
export async function getCompanyCommitmentRegister(
  companyId: string,
  query: CommitmentRegisterQuery = {},
  orgId?: string,
): Promise<CommitmentRegister> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "company",
    resourceId: companyId,
  })

  const { data, error } = await supabase
    .from("commitments")
    .select(COMMITMENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(REGISTER_SOURCE_LIMIT + 1)

  if (error) {
    throw new Error(`Failed to list commitments: ${error.message}`)
  }

  const rawRows = data ?? []
  const composed = await enrichCommitments(
    supabase,
    resolvedOrgId,
    rawRows.slice(0, REGISTER_SOURCE_LIMIT).map(mapCommitment),
  )

  return buildCommitmentRegister(
    composed as Array<CommitmentSummary & CommitmentRegisterRow>,
    query,
    rawRows.length > REGISTER_SOURCE_LIMIT,
  )
}

/**
 * Approving a commitment is what turns it into money the org owes, so the
 * approve permission and the prequalification rules gate every path into the
 * approved state — creating one there included, not just the draft→approved
 * transition. Returns the warning that was overridden, if any.
 */
async function gateCommitmentApproval({
  supabase,
  orgId,
  userId,
  projectId,
  companyId,
  commitmentId,
  creatorUserId,
  totalCents,
  overrideNote,
}: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  companyId: string | null
  commitmentId?: string
  creatorUserId: string | null
  totalCents: number
  overrideNote?: string | null
}): Promise<string | null> {
  await requireAuthorization({
    permission: "commitment.approve",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: commitmentId ? "commitment" : "project",
    resourceId: commitmentId ?? projectId,
  })
  await assertCommitmentApprovalSeparated({
    orgId,
    userId,
    creatorUserId,
    resourceType: commitmentId ? "commitment" : "project",
    resourceId: commitmentId ?? projectId,
    projectId,
  })

  const warning = await getCompanyPrequalificationWarning({
    companyId,
    commitmentTotalCents: totalCents,
    excludeCommitmentId: commitmentId,
    orgId,
  })
  if (!warning) return null

  const rules = await getComplianceRules(orgId)
  if (rules.block_commitment_on_prequal) throw new Error(warning)
  if (!overrideNote?.trim()) throw new Error("A prequalification override justification is required")
  return warning
}

const PO_COMPLETION_PATH_MESSAGE = "A purchase order is completed by approving its completion report, not by changing its status."
const PO_COMPLETE_FROM_APPROVED_MESSAGE = "A purchase order is completed from an approved order, not created or moved there directly. Approve it first."

export async function createCommitment({ input, orgId }: { input: CommitmentInput; orgId?: string }): Promise<CommitmentSummary> {
  const parsed = commitmentInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: parsed.project_id,
  })

  const status = parsed.status ?? "draft"
  // An order is complete only after it was approved, so none is created complete.
  if (status === "complete") throw new Error(PO_COMPLETE_FROM_APPROVED_MESSAGE)
  const prequalificationWarning =
    status === "approved"
      ? await gateCommitmentApproval({
          supabase,
          orgId: resolvedOrgId,
          userId,
          projectId: parsed.project_id,
          companyId: parsed.company_id,
          creatorUserId: userId,
          totalCents: parsed.total_cents,
          overrideNote: parsed.prequal_override_note,
        })
      : null

  // An order enters an issued status only through the service, after the checks above.
  const { data, error } = await (isIssuedPurchaseOrder(parsed.commitment_type, status) ? createServiceSupabaseClient() : supabase)
    .from("commitments")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      company_id: parsed.company_id,
      commitment_type: parsed.commitment_type,
      title: parsed.title,
      status,
      total_cents: parsed.total_cents,
      currency: "usd",
      contract_number: parsed.contract_number ?? null,
      scope: parsed.scope ?? null,
      terms: parsed.terms ?? null,
      retainage_percent: parsed.retainage_percent ?? 0,
      start_date: parsed.start_date ?? null,
      end_date: parsed.end_date ?? null,
      metadata: {
        created_by_user_id: userId,
        ...(prequalificationWarning
          ? {
              prequalification_warning: prequalificationWarning,
              prequal_override_note: parsed.prequal_override_note?.trim() ?? null,
            }
          : {}),
      },
    })
    .select(COMMITMENT_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create commitment: ${error?.message}`)
  }

  await ensureProjectVendorForCommitment({
    supabase,
    orgId: resolvedOrgId,
    projectId: parsed.project_id,
    companyId: parsed.company_id,
    scope: parsed.scope,
  })

  // If this org's money runs through a company, that company is a vendor —
  // whatever its type column says. Recording it here is what lets the account
  // shell resolve tabs from roles alone instead of inferring "vendor" from the
  // absence of architect/engineer, which is what it used to have to do.
  await ensureVendorRoleWithClient(supabase, resolvedOrgId, parsed.company_id, userId)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "commitment_created",
    entityType: "commitment",
    entityId: data.id as string,
    payload: { company_id: parsed.company_id, project_id: parsed.project_id, total_cents: parsed.total_cents },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment",
    entityId: data.id as string,
    after: data,
  })

  // A commitment created this instant has no bills and no change orders, so its
  // position is composable without reading them back.
  return composeCommitmentPosition(
    mapCommitment(data),
    emptyCommitmentBillRollup(),
    emptyCommitmentChangeOrderTotals(),
  )
}

/**
 * A purchase order that was billed or paid against cannot be un-issued: the
 * money would reference an order the vendor no longer holds.
 */
async function assertNothingBilledAgainst(orgId: string, commitmentId: string) {
  const service = createServiceSupabaseClient()
  const [completions, bills, receipts] = await Promise.all([
    service.from("po_completions").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitmentId).in("status", ["reported", "verified", "approved", "billed"]),
    service.from("vendor_bills").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitmentId).neq("status", "rejected"),
    service.from("po_receipts").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("commitment_id", commitmentId).neq("status", "void"),
  ])
  const failure = completions.error ?? bills.error ?? receipts.error
  if (failure) throw new Error(`Failed to check the purchase order's activity: ${failure.message}`)
  if ((completions.count ?? 0) > 0 || (bills.count ?? 0) > 0 || (receipts.count ?? 0) > 0) {
    throw new Error("This purchase order has completions, bills or deliveries against it, so it cannot be returned to draft or cancelled. Raise a variance order instead.")
  }
}

/**
 * The one-step create: an order is built as a draft, its line lands, and it is approved when the caller
 * asked for that. An approved purchase order is locked, so it cannot be created with its line already on
 * it. The approval gate is run before anything is written, and if the approval is still refused (it
 * re-checks everything against the written order) the draft is removed again, so a refusal never leaves
 * an unlabeled draft behind.
 */
export async function createCommitmentWithLine({
  input,
  line,
  orgId,
}: {
  input: CommitmentInput
  line: CommitmentLineInput
  orgId?: string
}): Promise<CommitmentSummary> {
  const parsed = commitmentInputSchema.parse(input)
  const validatedLine = commitmentLineInputSchema.parse(line)
  const wantsApproval = parsed.status === "approved"
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  if (wantsApproval) {
    await requireAuthorization({
      permission: "commitment.write",
      userId,
      orgId: resolvedOrgId,
      projectId: parsed.project_id,
      supabase,
      logDecision: true,
      resourceType: "project",
      resourceId: parsed.project_id,
    })
    await gateCommitmentApproval({
      supabase,
      orgId: resolvedOrgId,
      userId,
      projectId: parsed.project_id,
      companyId: parsed.company_id,
      creatorUserId: userId,
      totalCents: poLinesTotalCents([validatedLine]),
      overrideNote: parsed.prequal_override_note,
    })
  }

  const created = await createCommitment({ input: { ...parsed, status: "draft" }, orgId: resolvedOrgId })
  try {
    await createCommitmentLine(created.id, validatedLine)
    if (!wantsApproval) return created
    return await updateCommitment({
      commitmentId: created.id,
      input: { status: "approved", prequal_override_note: parsed.prequal_override_note },
      orgId: resolvedOrgId,
    })
  } catch (error) {
    const service = createServiceSupabaseClient()
    const { error: linesError } = await service.from("commitment_lines").delete().eq("org_id", resolvedOrgId).eq("commitment_id", created.id)
    const { error: orderError } = linesError
      ? { error: linesError }
      : await service.from("commitments").delete().eq("org_id", resolvedOrgId).eq("id", created.id).eq("status", "draft")
    await recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: orderError ? "commitment_create_discard_failed" : "commitment_create_discarded",
      entityType: "commitment",
      entityId: created.id,
      payload: { project_id: parsed.project_id, reason: error instanceof Error ? error.message : "Unknown error" },
    })
    if (orderError) {
      const detail = error instanceof Error ? error.message : "The order could not be completed"
      throw new Error(`${detail} (a draft order was left on the project: ${created.title})`)
    }
    throw error
  }
}

export async function updateCommitment({
  commitmentId,
  input,
  orgId,
}: {
  commitmentId: string
  input: CommitmentUpdateInput
  orgId?: string
}): Promise<CommitmentSummary> {
  const parsed = commitmentUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // A purchasing manager works across houses from the desk without being on a
  // home's team, so the order is read by the service, scoped to the org; the
  // permission check below carries the project and division scope.
  const db = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await db
    .from("commitments")
    .select("id, org_id, project_id, company_id, commitment_type, title, status, total_cents, currency, contract_number, scope, terms, retainage_percent, executed_at, executed_file_id, source_document_id, signature_envelope_id, start_date, end_date, issued_at, metadata, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Commitment not found")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  // An issued purchase order is locked: its terms change through a variance
  // order, or it goes back to draft (un-issuing it) and is approved again.
  const issued = isIssuedPurchaseOrder(existing.commitment_type, existing.status)
  if (parsed.status === "complete" && existing.status !== "approved" && existing.status !== "complete") {
    throw new Error(PO_COMPLETE_FROM_APPROVED_MESSAGE)
  }
  // A purchase order is completed by approving a completion report, never by editing its status, and an
  // order that was completed is not reopened by editing it either: it is returned to draft or left alone.
  if (existing.commitment_type === "purchase_order" && parsed.status !== undefined && parsed.status !== existing.status) {
    if (parsed.status === "complete") throw new Error(PO_COMPLETION_PATH_MESSAGE)
    if (existing.status === "complete" && isIssuedPurchaseOrder("purchase_order", parsed.status)) throw new Error(PO_COMPLETION_PATH_MESSAGE)
  }
  const unissues = issued && parsed.status !== undefined && !isIssuedPurchaseOrder("purchase_order", parsed.status)
  if (issued) {
    const changed = lockedTermsChanged(existing, parsed)
    if (changed.length) throw new Error(`${PO_LOCKED_MESSAGE} (${changed.join(", ")})`)
  }
  if (unissues) {
    await requireAuthorization({
      permission: "commitment.approve",
      userId,
      orgId: resolvedOrgId,
      projectId: existing.project_id,
      supabase,
      logDecision: true,
      resourceType: "commitment",
      resourceId: commitmentId,
    })
    await assertNothingBilledAgainst(resolvedOrgId, commitmentId)
  }

  const lineRollup = await getCommitmentLineRollup(db, resolvedOrgId, commitmentId)
  const nextTotalCents =
    lineRollup.lineCount > 0
      ? lineRollup.totalCents
      : parsed.total_cents ?? existing.total_cents

  let prequalificationWarning: string | null = null
  if (parsed.status === "approved" && existing.status !== "approved" && !issued) {
    prequalificationWarning = await gateCommitmentApproval({
      supabase: db,
      orgId: resolvedOrgId,
      userId,
      projectId: existing.project_id,
      companyId: existing.company_id,
      commitmentId,
      creatorUserId: commitmentCreatedByUserId(existing.metadata),
      totalCents: nextTotalCents ?? 0,
      overrideNote: parsed.prequal_override_note,
    })
  }

  // Written by the service, after the permission checks above.
  const { data, error } = await db
    .from("commitments")
    .update({
      status: parsed.status ?? existing.status,
      // An issued order's terms are not part of the write at all.
      ...(issued ? {} : {
        title: parsed.title ?? existing.title,
        total_cents: nextTotalCents,
        contract_number: parsed.contract_number ?? existing.contract_number,
        scope: parsed.scope ?? existing.scope,
        terms: parsed.terms ?? existing.terms,
        retainage_percent: parsed.retainage_percent ?? existing.retainage_percent ?? 0,
        start_date: parsed.start_date ?? existing.start_date,
        end_date: parsed.end_date ?? existing.end_date,
      }),
      metadata: {
        ...(existing.metadata ?? {}),
        prequalification_warning: prequalificationWarning ?? existing.metadata?.prequalification_warning ?? null,
        prequal_override_note: prequalificationWarning
          ? parsed.prequal_override_note?.trim() ?? null
          : existing.metadata?.prequal_override_note ?? null,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    // What was read, gated and approved is what is written: a regeneration or line edit that landed since is refused.
    .eq("updated_at", existing.updated_at)
    .select(COMMITMENT_SELECT)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to update commitment: ${error.message}`)
  }
  if (!data) {
    throw new Error("The order changed while you were working on it. Reload it and review the current lines and total.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment",
    entityId: data.id as string,
    before: existing,
    after: data,
    // Approving is what issues the commitment to the vendor; going back to draft un-issues it.
    critical: (parsed.status === "approved" && existing.status !== "approved") || unissues,
  })

  if (unissues) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "commitment_unissued",
      entityType: "commitment",
      entityId: commitmentId,
      payload: { project_id: existing.project_id, from_status: existing.status, to_status: parsed.status },
    })
  }

  const [composed] = await enrichCommitments(db, resolvedOrgId, [mapCommitment(data)])
  return composed
}

const EXECUTION_SELECT =
  "id, org_id, project_id, company_id, commitment_type, title, status, total_cents, executed_at, executed_file_id, source_document_id, signature_envelope_id, metadata"

/**
 * The only writer of `executed_at`. Both routes into execution — a counterparty
 * signing an Arc envelope, and a countersigned agreement recorded by hand — land
 * here so the stored evidence has the same shape either way.
 */
async function applyCommitmentExecution({
  supabase,
  orgId,
  existing,
  executedAt,
  executedFileId,
  documentId,
  envelopeId,
  evidence,
  actorId,
  eventPayload,
  approvesDraft,
}: {
  supabase: SupabaseClient
  orgId: string
  existing: Record<string, any>
  executedAt: string
  executedFileId: string
  documentId?: string | null
  envelopeId?: string | null
  evidence: Record<string, unknown>
  actorId?: string
  eventPayload: Record<string, unknown>
  /**
   * Only a person who passed the approval checks turns a draft into an approved
   * commitment. A counterparty's signature records execution but approves
   * nothing: a draft that went back to draft after it was sent still needs a
   * person to approve it.
   */
  approvesDraft: boolean
}): Promise<CommitmentSummary> {
  // The callers have authorized the execution; approving a draft order is the service's write.
  const { data, error } = await createServiceSupabaseClient()
    .from("commitments")
    .update({
      status: existing.status === "draft" && approvesDraft ? "approved" : existing.status,
      executed_at: executedAt,
      executed_file_id: executedFileId,
      source_document_id: documentId ?? existing.source_document_id ?? null,
      signature_envelope_id: envelopeId ?? existing.signature_envelope_id ?? null,
      metadata: {
        ...(existing.metadata ?? {}),
        executed_signature: evidence,
      },
    })
    .eq("org_id", orgId)
    .eq("id", existing.id)
    .select(COMMITMENT_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to mark commitment executed: ${error?.message}`)
  }

  await recordEvent({
    orgId,
    eventType: "commitment_executed",
    entityType: "commitment",
    entityId: existing.id as string,
    payload: { project_id: existing.project_id, ...eventPayload },
  })

  await recordAudit({
    orgId,
    actorId,
    action: "update",
    entityType: "commitment",
    entityId: existing.id as string,
    before: existing,
    after: data,
    critical: true,
  })

  const [composed] = await enrichCommitments(supabase, orgId, [mapCommitment(data)])
  return composed
}

export async function markCommitmentExecutedFromEnvelope(input: {
  orgId: string
  commitmentId: string
  envelopeId: string
  documentId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}): Promise<CommitmentSummary> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: existing, error: existingError } = await supabase
    .from("commitments")
    .select(EXECUTION_SELECT)
    .eq("org_id", input.orgId)
    .eq("id", input.commitmentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(`Commitment not found for executed subcontract: ${existingError?.message ?? "not found"}`)
  }

  return applyCommitmentExecution({
    supabase,
    orgId: input.orgId,
    existing,
    executedAt: nowIso,
    executedFileId: input.executedFileId,
    documentId: input.documentId,
    envelopeId: input.envelopeId,
    approvesDraft: false,
    evidence: {
      method: "esign",
      signer_name: input.signerName ?? null,
      signer_email: input.signerEmail ?? null,
      signer_ip: input.signerIp ?? null,
      executed_at: nowIso,
      envelope_id: input.envelopeId,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
    },
    eventPayload: {
      method: "esign",
      envelope_id: input.envelopeId,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signer_email: input.signerEmail ?? null,
    },
  })
}

/**
 * Records an agreement executed outside Arc — signed on paper, or countersigned
 * and returned by email. The signed document is required: an executed
 * commitment with nothing to produce later is not evidence of anything.
 */
export async function executeCommitment({
  commitmentId,
  input,
  orgId,
}: {
  commitmentId: string
  input: CommitmentExecutionInput
  orgId?: string
}): Promise<CommitmentSummary> {
  const parsed = commitmentExecutionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("commitments")
    .select(EXECUTION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Commitment not found")
  }

  // Recording execution asserts the org is bound to the contract, so it takes
  // the same authority as approving one.
  await requireAuthorization({
    permission: "commitment.approve",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  if (existing.executed_at) {
    throw new Error("This commitment is already executed.")
  }
  if (existing.commitment_type === "purchase_order" && existing.status === "draft") {
    // Recording a signature must not issue an order that skipped the approval gate and its total re-roll.
    throw new Error("Approve this purchase order first; recording a signed copy does not issue it.")
  }
  if (existing.status === "draft") {
    await assertCommitmentApprovalSeparated({
      orgId: resolvedOrgId,
      userId,
      creatorUserId: commitmentCreatedByUserId(existing.metadata),
      resourceType: "commitment",
      resourceId: commitmentId,
      projectId: existing.project_id,
    })
  }
  await assertCommitmentExecutable({
    supabase,
    orgId: resolvedOrgId,
    commitmentId,
    action: "recording its execution",
  })
  await assertSubcontractExecutionCompliance({
    supabase,
    orgId: resolvedOrgId,
    sourceEntityType: "subcontract",
    sourceEntityId: commitmentId,
    action: "recording this subcontract as executed",
  })

  // The signed agreement has to be a real file in this org, on this project.
  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.executed_file_id)
    .maybeSingle()

  if (fileError || !file) {
    throw new Error("The signed agreement could not be found.")
  }
  if (file.project_id && file.project_id !== existing.project_id) {
    throw new Error("The signed agreement belongs to a different project.")
  }

  return applyCommitmentExecution({
    supabase,
    orgId: resolvedOrgId,
    existing,
    executedAt: parsed.executed_at,
    executedFileId: parsed.executed_file_id,
    approvesDraft: true,
    evidence: {
      method: "recorded",
      executed_at: parsed.executed_at,
      executed_file_id: parsed.executed_file_id,
      note: parsed.note ?? null,
      recorded_by: userId,
      recorded_at: new Date().toISOString(),
    },
    actorId: userId,
    eventPayload: {
      method: "recorded",
      executed_file_id: parsed.executed_file_id,
      executed_at: parsed.executed_at,
    },
  })
}

// ============================================================================
// Commitment Lines
// ============================================================================

function mapCommitmentLine(row: any): CommitmentLine {
  return {
    id: row.id,
    org_id: row.org_id,
    commitment_id: row.commitment_id,
    cost_code_id: row.cost_code_id,
    budget_line_id: row.budget_line_id ?? null,
    cost_code_code: row.cost_code?.code ?? undefined,
    cost_code_name: row.cost_code?.name ?? undefined,
    description: row.description,
    quantity: row.quantity ?? 1,
    unit: row.unit,
    unit_cost_cents: row.unit_cost_cents,
    total_cents: extendedLineCents(row),
    scheduled_value_cents: row.scheduled_value_cents ?? null,
    retainage_percent: row.retainage_percent != null ? Number(row.retainage_percent) : null,
    sort_order: row.sort_order ?? 0,
  }
}

async function getCommitmentLineRollup(
  supabase: SupabaseClient,
  orgId: string,
  commitmentId: string,
): Promise<{ lineCount: number; totalCents: number }> {
  const { data, error } = await supabase
    .from("commitment_lines")
    .select("quantity, unit_cost_cents")
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)

  if (error) {
    throw new Error(`Failed to load commitment line totals: ${error.message}`)
  }

  return {
    lineCount: data?.length ?? 0,
    totalCents: poLinesTotalCents(data ?? []),
  }
}

/**
 * The only writer of a line. The database function locks the order's row, refuses an
 * approved purchase order and re-totals the order in the same transaction, so a line
 * never lands on an order that is being, or has just been, approved.
 */
async function writeLine(
  orgId: string,
  op: "insert" | "update" | "delete",
  commitmentId: string,
  lineId: string | null,
  values: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await createServiceSupabaseClient().rpc("write_commitment_line", {
    p_org_id: orgId,
    p_op: op,
    p_commitment_id: commitmentId,
    p_line_id: lineId,
    p_values: values,
  })
  if (error) throw new Error(error.message)
  const result = z.object({ line_id: z.string().uuid() }).parse(data)
  return result.line_id
}

async function readLine(orgId: string, lineId: string) {
  const { data, error } = await createServiceSupabaseClient()
    .from("commitment_lines")
    .select(LINE_SELECT)
    .eq("id", lineId)
    .eq("org_id", orgId)
    .single()
  if (error || !data) throw new Error(`Failed to load commitment line: ${error?.message}`)
  return data
}

const LINE_FIELDS = "id, org_id, commitment_id, cost_code_id, budget_line_id, description, quantity, unit, unit_cost_cents, scheduled_value_cents, retainage_percent, sort_order"
const LINE_SELECT = `${LINE_FIELDS}, cost_code:cost_codes(code, name)`

/**
 * The order a line belongs to, read by the service scoped to the org: a purchasing
 * manager works across houses from the desk without being on a home's team, so
 * row security would hide the order. Every caller authorizes on the home (project
 * and division scope) before it reads or writes a line.
 */
async function loadOrderForLines(orgId: string, commitmentId: string) {
  const { data, error } = await createServiceSupabaseClient()
    .from("commitments")
    .select("id, project_id, commitment_type, status")
    .eq("id", commitmentId)
    .eq("org_id", orgId)
    .maybeSingle()
  if (error || !data) throw new Error("Commitment not found or access denied")
  return data
}

/** The lines of an issued purchase order are locked; a line is edited on a draft. */
function assertLineEditable(order: { commitment_type: string; status: string }) {
  if (isIssuedPurchaseOrder(order.commitment_type, order.status)) throw new Error(PO_LOCKED_MESSAGE)
}

async function loadLineForWrite(orgId: string, lineId: string) {
  const { data: line, error } = await createServiceSupabaseClient()
    .from("commitment_lines")
    .select(LINE_FIELDS)
    .eq("id", lineId)
    .eq("org_id", orgId)
    .maybeSingle()
  if (error || !line) throw new Error("Commitment line not found or access denied")
  const order = await loadOrderForLines(orgId, String(line.commitment_id))
  return { line, order }
}

export async function listCommitmentLines(commitmentId: string): Promise<CommitmentLine[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const commitment = await loadOrderForLines(orgId, commitmentId)

  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId,
    projectId: commitment.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  const { data, error } = await createServiceSupabaseClient()
    .from("commitment_lines")
    .select(LINE_SELECT)
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to list commitment lines: ${error.message}`)
  }

  return (data ?? []).map(mapCommitmentLine)
}

export async function createCommitmentLine(commitmentId: string, input: CommitmentLineInput): Promise<CommitmentLine> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const commitment = await loadOrderForLines(orgId, commitmentId)

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: commitment.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })
  assertLineEditable(commitment)

  const validated = commitmentLineInputSchema.parse(input)
  const data = await readLine(orgId, await writeLine(orgId, "insert", commitmentId, null, validated))

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment_line",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_created",
    payload: {
      project_id: commitment.project_id,
      commitment_id: commitmentId,
      commitment_line_id: data.id,
      cost_code_id: validated.cost_code_id,
    },
  })

  return mapCommitmentLine(data)
}

export async function updateCommitmentLine(lineId: string, input: CommitmentLineUpdateInput): Promise<CommitmentLine> {
  const { supabase, orgId, userId } = await requireOrgContext()

  const validated = commitmentLineUpdateSchema.parse(input)
  const { line: existing, order } = await loadLineForWrite(orgId, lineId)

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: order.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_line",
    resourceId: lineId,
  })
  assertLineEditable(order)

  const data = await readLine(orgId, await writeLine(orgId, "update", order.id, lineId, validated))

  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_line",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_updated",
    payload: {
      project_id: order.project_id,
      commitment_id: existing.commitment_id,
      commitment_line_id: data.id,
    },
  })

  return mapCommitmentLine(data)
}

export async function deleteCommitmentLine(lineId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const { line: existing, order } = await loadLineForWrite(orgId, lineId)

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId,
    projectId: order.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_line",
    resourceId: lineId,
  })
  assertLineEditable(order)

  await writeLine(orgId, "delete", order.id, lineId, {})

  await recordAudit({
    orgId,
    actorId: userId,
    action: "delete",
    entityType: "commitment_line",
    entityId: lineId,
    before: existing,
  })

  await recordEvent({
    orgId,
    eventType: "commitment_line_deleted",
    payload: {
      project_id: order.project_id,
      commitment_id: existing.commitment_id,
      commitment_line_id: lineId,
    },
  })
}

// ============================================================================
// Commitment detail
// ============================================================================

/** A change order as the commitment's own history needs it, without its lines. */
export interface CommitmentChangeOrderRef {
  id: string
  title: string
  status: string
  total_cents: number
  reason_code: string | null
  reason_label: string | null
  approved_at: string | null
  created_at: string
}

/** A bill as the commitment's own history needs it, without its coding. */
export interface CommitmentBillRef {
  id: string
  bill_number: string | null
  bill_date: string | null
  due_date: string | null
  status: string
  total_cents: number
  paid_cents: number
  retainage_cents: number
  lien_waiver_status: string | null
  is_credit: boolean
  file_id: string | null
}

export interface CommitmentDetail {
  commitment: CommitmentSummary
  lines: CommitmentLine[]
  change_orders: CommitmentChangeOrderRef[]
  bills: CommitmentBillRef[]
}

/**
 * Everything behind one commitment in a single read: the position, the lines
 * that build the total, the change orders that revised it, and the bills that
 * have drawn it down.
 */
export async function getCommitmentDetail(commitmentId: string, orgId?: string): Promise<CommitmentDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // A purchasing manager works across houses without being on a home's team, so row
  // security would hide the order: it is read by the service scoped to the org, and the
  // permission check below carries the project and division scope before anything is returned.
  const db = createServiceSupabaseClient()
  const { data: row, error } = await db
    .from("commitments")
    .select(COMMITMENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (error || !row) {
    throw new Error("Commitment not found or access denied")
  }
  const stored = mapCommitment(row)

  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    projectId: stored.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: commitmentId,
  })

  const [enriched, linesResult, changeOrdersResult, billsResult] = await Promise.all([
    enrichCommitments(db, resolvedOrgId, [stored]),
    db
      .from("commitment_lines")
      .select(
        `
      id, org_id, commitment_id, cost_code_id, budget_line_id, description, quantity, unit, unit_cost_cents, scheduled_value_cents, retainage_percent, sort_order,
      cost_code:cost_codes(code, name)
    `,
      )
      .eq("org_id", resolvedOrgId)
      .eq("commitment_id", commitmentId)
      .order("sort_order", { ascending: true }),
    db
      .from("commitment_change_orders")
      .select(
        "id, title, status, total_cents, approved_at, created_at, reason:variance_reason_codes(code, label)",
      )
      .eq("org_id", resolvedOrgId)
      .eq("commitment_id", commitmentId)
      .order("created_at", { ascending: false }),
    db
      .from("vendor_bills")
      .select(
        "id, bill_number, bill_date, due_date, status, total_cents, paid_cents, retainage_cents, lien_waiver_status, file_id, metadata",
      )
      .eq("org_id", resolvedOrgId)
      .eq("commitment_id", commitmentId)
      .order("bill_date", { ascending: false, nullsFirst: false }),
  ])

  if (linesResult.error) {
    throw new Error(`Failed to load commitment lines: ${linesResult.error.message}`)
  }
  if (changeOrdersResult.error) {
    throw new Error(`Failed to load commitment change orders: ${changeOrdersResult.error.message}`)
  }
  if (billsResult.error) {
    throw new Error(`Failed to load commitment bills: ${billsResult.error.message}`)
  }

  return {
    commitment: enriched[0],
    lines: (linesResult.data ?? []).map(mapCommitmentLine),
    change_orders: (changeOrdersResult.data ?? []).map((changeOrder: any) => {
      const reason = Array.isArray(changeOrder.reason) ? changeOrder.reason[0] : changeOrder.reason
      return {
        id: changeOrder.id,
        title: changeOrder.title,
        status: String(changeOrder.status ?? "draft"),
        total_cents: Number(changeOrder.total_cents ?? 0),
        reason_code: reason?.code ?? null,
        reason_label: reason?.label ?? null,
        approved_at: changeOrder.approved_at ?? null,
        created_at: changeOrder.created_at,
      }
    }),
    // Drafts are excluded to match the position: a payable still being written
    // has not drawn anything down yet.
    bills: (billsResult.data ?? [])
      .filter((bill: any) => (bill.metadata ?? {}).creation_state !== "draft")
      .map((bill: any) => ({
        id: bill.id,
        bill_number: bill.bill_number ?? null,
        bill_date: bill.bill_date ?? null,
        due_date: bill.due_date ?? null,
        status: String(bill.status ?? "pending"),
        total_cents: Number(bill.total_cents ?? 0),
        paid_cents: Number(bill.paid_cents ?? 0),
        retainage_cents: Number(bill.retainage_cents ?? 0),
        lien_waiver_status: bill.lien_waiver_status ?? null,
        is_credit: (bill.metadata ?? {}).source === "vendor_credit",
        file_id: bill.file_id ?? null,
      })),
  }
}
