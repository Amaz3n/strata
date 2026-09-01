import "server-only"

import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  daysUntilDue,
  type MobilePayableCodingLineDTO,
  type MobilePayableCodingSummaryDTO,
  type MobilePayableDTO,
  type MobilePayableDecisionResultDTO,
  type MobilePayableDetailDTO,
  type MobilePayableDocumentDTO,
  type MobilePayableEvidenceDTO,
  type MobilePayableHoldsDTO,
} from "@/lib/mobile/contracts"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { readLineMatchAssessment } from "@/lib/financials/payable-line-match"
import { summarizeWaiverMismatches, waiverVerificationSchema } from "@/lib/payments/ap-verification"
import { authorizeMany } from "@/lib/services/authorization"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import { getComplianceRules } from "@/lib/services/compliance"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { evaluateHolds } from "@/lib/services/payment-holds"
import { hasPermission } from "@/lib/services/permissions"
import {
  hydrateVendorBills,
  updateVendorBillStatus,
  vendorBillSelect,
  type VendorBillSummary,
} from "@/lib/services/vendor-bills"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"
import type { ComplianceRules, ComplianceStatusSummary } from "@/lib/types"

/**
 * Bill approval from the phone.
 *
 * ## Why there is no step-up here
 *
 * The payment-run sibling (`lib/mobile/payment-runs.ts`) resolves a fresh
 * two-factor challenge before every decision, because approving a run RELEASES
 * money. Approving a bill does not: it accepts an obligation that was already
 * incurred, and the release gate — `assertBillReleasable` plus
 * `assertExternalPaymentControls`, both requiring `payment.release` — still
 * stands between an approved bill and a payment.
 *
 * The web app draws the same line. `updateVendorBillStatus` reaches for
 * `requireRecentPaymentStepUp` only inside `assertExternalPaymentControls`, which
 * runs for `paid`/`partial` and never for `approved`/`rejected`; the desk's
 * approve path has no step-up UX at all. Adding one on mobile would make the
 * phone stricter than the desk for the same decision, which trains people to go
 * find a laptop — the exact behaviour this endpoint exists to end. Making it
 * looser is not on the table either: `bill.approve` is enforced, by the service.
 *
 * So the control model is: bearer token validated by Supabase, active membership
 * in the org, `bill.approve` on the payable's project, and an
 * `expected_updated_at` guard so a phone cannot overwrite a desk decision.
 */

/** A page of a queue this size is already more than anyone triages on a phone. */
const MAX_SEARCH_LENGTH = 120

/** Bounds the project-scope lookup for approvers who hold `bill.approve` per project. */
const PROJECT_SCOPE_LIMIT = 500

/** Bounds the lot lookup that decorates a page with house/community context. */
const LOT_LOOKUP_LIMIT = 500

export interface MobilePayablesPage {
  payables: MobilePayableDTO[]
  pagination: { page: number; page_size: number; total: number; page_count: number }
}

interface ApprovalScope {
  /** True when `bill.approve` is held org-wide, so no project filter is needed. */
  orgWide: boolean
  /** Projects where it is held individually. Empty when `orgWide`. */
  projectIds: string[]
}

/**
 * Where this person may approve.
 *
 * A queue that lists payables the viewer cannot decide is a queue they learn to
 * ignore, so the scope is resolved before the query rather than filtered after
 * it — that also keeps the page counts honest. `bill.approve` is deliberately not
 * held by `pm`/`org_project_lead` in the shipped RBAC catalog; whether a given
 * builder grants it is their configuration, and this reads the answer rather
 * than assuming one.
 */
async function resolveApprovalScope(context: MobileOrgContext): Promise<ApprovalScope> {
  const orgWide = await hasPermission("bill.approve", {
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    userId: context.user.id,
  })
  if (orgWide) return { orgWide: true, projectIds: [] }

  // Without an org-wide grant the only remaining source is a project role, so
  // the candidate set is exactly this person's project memberships.
  const { data, error } = await context.serviceSupabase
    .from("project_members")
    .select("project_id")
    .eq("org_id", context.orgId)
    .eq("user_id", context.user.id)
    .eq("status", "active")
    .limit(PROJECT_SCOPE_LIMIT)
  if (error) {
    throw new MobileAPIError(500, "payables_unavailable", "Your approval queue could not be loaded.")
  }

  const candidates = (data ?? [])
    .map((row: { project_id: string | null }) => row.project_id)
    .filter((projectId: string | null): projectId is string => Boolean(projectId))
  if (candidates.length === 0) return { orgWide: false, projectIds: [] }

  const verdicts = await authorizeMany({
    permission: "bill.approve",
    userId: context.user.id,
    orgId: context.orgId,
    projectIds: candidates,
  })
  return {
    orgWide: false,
    projectIds: candidates.filter((projectId) => verdicts.get(projectId) === true),
  }
}

function requireApprovalScope(scope: ApprovalScope) {
  if (!scope.orgWide && scope.projectIds.length === 0) {
    throw new MobileAPIError(
      403,
      "bill_approval_forbidden",
      "You do not have permission to approve payables in this organization.",
    )
  }
}

interface LotContext {
  lotLabel: string | null
  communityName: string | null
}

/**
 * Lot and community for the projects on this page. Read separately rather than
 * widened into `vendorBillSelect`, which is shared with the desk and the project
 * workbench — a payable is not always a house, and only production postures have
 * a lot row at all.
 */
async function loadLotContext(
  context: MobileOrgContext,
  projectIds: string[],
): Promise<Map<string, LotContext>> {
  const byProjectId = new Map<string, LotContext>()
  if (projectIds.length === 0) return byProjectId

  const { data, error } = await context.serviceSupabase
    .from("lots")
    .select("project_id, lot_number, block, community:communities(name)")
    .eq("org_id", context.orgId)
    .in("project_id", projectIds)
    .limit(LOT_LOOKUP_LIMIT)
  if (error) return byProjectId

  for (const row of data ?? []) {
    if (!row.project_id) continue
    const community = Array.isArray(row.community) ? row.community[0] : row.community
    const communityName = typeof community?.name === "string" ? community.name : null
    const lotNumber = typeof row.lot_number === "string" ? row.lot_number : null
    const block = typeof row.block === "string" ? row.block : null
    byProjectId.set(row.project_id, {
      lotLabel: lotNumber ? (block ? `${block}-${lotNumber}` : lotNumber) : null,
      communityName,
    })
  }
  return byProjectId
}

interface DocumentRow {
  id: string
  file_name: string | null
  mime_type: string | null
  storage_path: string | null
}

/**
 * The invoice document for each payable on the page.
 *
 * Two places record it: `vendor_bills.file_id`, and a `file_links` row with role
 * `invoice` (what the portal and the scan pipeline write, and what the web
 * document pane reads). Both are consulted because neither is present on every
 * payable. `listAttachments` is not used: it gates on `docs.read`, which a
 * superintendent approving from a truck has no reason to hold, and being denied
 * a document is worse than being shown one without a filename.
 */
async function loadDocuments(
  context: MobileOrgContext,
  bills: VendorBillSummary[],
): Promise<Map<string, MobilePayableDocumentDTO>> {
  const byBillId = new Map<string, MobilePayableDocumentDTO>()
  const billIds = bills.map((bill) => bill.id)
  if (billIds.length === 0) return byBillId

  const { data: linkRows } = await context.serviceSupabase
    .from("file_links")
    .select("entity_id, file_id, link_role")
    .eq("org_id", context.orgId)
    .eq("entity_type", "vendor_bill")
    .in("entity_id", billIds)

  const fileIdByBillId = new Map<string, string>()
  for (const bill of bills) {
    if (bill.file_id) fileIdByBillId.set(bill.id, bill.file_id)
  }
  for (const row of linkRows ?? []) {
    if (!row.entity_id || !row.file_id) continue
    // An explicit invoice link wins over whatever else is attached to the bill.
    if (row.link_role === "invoice" || !fileIdByBillId.has(row.entity_id)) {
      fileIdByBillId.set(row.entity_id, row.file_id)
    }
  }
  if (fileIdByBillId.size === 0) return byBillId

  const { data: fileRows } = await context.serviceSupabase
    .from("files")
    .select("id, file_name, mime_type, storage_path")
    .eq("org_id", context.orgId)
    .in("id", [...new Set(fileIdByBillId.values())])

  const filesById = new Map<string, DocumentRow>()
  for (const row of fileRows ?? []) filesById.set(row.id, row)

  await Promise.all(
    [...fileIdByBillId.entries()].map(async ([billId, fileId]) => {
      const file = filesById.get(fileId)
      if (!file) return
      byBillId.set(billId, {
        file_id: file.id,
        file_name: file.file_name,
        mime_type: file.mime_type,
        download_url: await documentUrl(context, file),
      })
    }),
  )
  return byBillId
}

async function documentUrl(context: MobileOrgContext, file: DocumentRow): Promise<string | null> {
  if (!file.storage_path) return null
  try {
    const signed = await createFilesDownloadUrl({
      supabase: context.serviceSupabase,
      orgId: context.orgId,
      path: file.storage_path,
      fileName: file.file_name ?? "invoice",
      expiresIn: 3_600,
    })
    return signed.downloadUrl
  } catch (error) {
    // A payable is still decidable without its scan attached, and the approver
    // can see that the document did not load.
    console.error("Mobile payable document URL failed", { fileId: file.id, error })
    return null
  }
}

/**
 * The same advisory warnings the web desk shows on a payables row
 * (`releaseWarnings` in the payables desk), from the same inputs.
 *
 * The authoritative verdict is `evaluateHolds`, which is seven queries per bill
 * and requires `payment.release`. Neither is available here: a page cannot afford
 * the queries, and a field approver holds `bill.approve`, not `payment.release`.
 * Detail requests attempt the real evaluation and fall back to this.
 */
function advisoryHolds(
  bill: VendorBillSummary,
  rules: ComplianceRules,
  complianceByCompanyId: Record<string, ComplianceStatusSummary>,
): MobilePayableHoldsDTO {
  const reasons: string[] = []
  const compliance = bill.company_id ? complianceByCompanyId[bill.company_id] : undefined
  if (compliance && !compliance.is_compliant) {
    reasons.push(
      compliance.expired.length > 0
        ? "Vendor compliance documents have expired"
        : "Vendor is missing required compliance documents",
    )
  }
  if (rules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    reasons.push("Lien waiver not received")
  }
  if (bill.over_budget) reasons.push("Exceeds the linked commitment")
  return { present: reasons.length > 0, reasons }
}

function codingSummary(bill: VendorBillSummary): MobilePayableCodingSummaryDTO {
  const lines: MobilePayableCodingLineDTO[] = (bill.actual_lines ?? []).map((line) => ({
    cost_code: line.cost_code_code ?? null,
    cost_code_name: line.cost_code_name ?? null,
    description: line.description ?? null,
    amount_cents: line.amount_cents,
    project_name: line.project_name ?? null,
  }))
  const codedCents = (bill.actual_lines ?? [])
    .filter((line) => Boolean(line.cost_code_id ?? line.budget_line_id))
    .reduce((sum, line) => sum + line.amount_cents, 0)
  const totalCents = bill.total_cents ?? 0
  return {
    lines,
    coded_cents: codedCents,
    uncoded_cents: totalCents - codedCents,
    fully_coded: lines.length > 0 && codedCents === totalCents,
  }
}

function mapPayable(
  bill: VendorBillSummary,
  context: {
    rules: ComplianceRules
    complianceByCompanyId: Record<string, ComplianceStatusSummary>
    lots: Map<string, LotContext>
    documents: Map<string, MobilePayableDocumentDTO>
  },
): MobilePayableDTO {
  const lot = bill.project_id ? context.lots.get(bill.project_id) : undefined
  return {
    id: bill.id,
    bill_number: bill.bill_number ?? null,
    vendor_name: bill.company_name ?? bill.qbo_vendor_name ?? null,
    project_id: bill.project_id,
    project_name: bill.project_name ?? null,
    lot_label: lot?.lotLabel ?? null,
    community_name: lot?.communityName ?? null,
    status: bill.status,
    total_cents: bill.total_cents ?? 0,
    outstanding_cents: payableOutstandingCents({
      payable_type: bill.payable_type,
      total_cents: bill.total_cents ?? 0,
      paid_cents: bill.paid_cents ?? 0,
      retainage_cents: bill.retainage_cents ?? 0,
    }),
    currency: bill.currency,
    bill_date: bill.bill_date ?? null,
    due_date: bill.due_date ?? null,
    days_until_due: daysUntilDue(bill.due_date),
    updated_at: bill.updated_at ?? null,
    coding: codingSummary(bill),
    holds: advisoryHolds(bill, context.rules, context.complianceByCompanyId),
    document: context.documents.get(bill.id) ?? null,
    commitment: bill.commitment_id
      ? {
          id: bill.commitment_id,
          title: bill.commitment_title ?? null,
          total_cents: bill.commitment_total_cents ?? null,
          billed_cents: bill.commitment_billed_cents ?? null,
        }
      : null,
    over_budget: Boolean(bill.over_budget),
    accounting_sync_status: bill.qbo_sync_status ?? null,
  }
}

/**
 * Everything the page needs beyond the bill rows themselves. Each read is
 * independent of the others, so none of them waits on another.
 */
async function decorate(context: MobileOrgContext, bills: VendorBillSummary[]) {
  const companyIds = [...new Set(bills.map((bill) => bill.company_id).filter((id): id is string => Boolean(id)))]
  const projectIds = [...new Set(bills.map((bill) => bill.project_id).filter((id): id is string => Boolean(id)))]

  const [rules, complianceByCompanyId, lots, documents] = await Promise.all([
    runWithServiceOrgContext(context.serviceContext, () => getComplianceRules(context.orgId)),
    companyIds.length > 0
      ? runWithServiceOrgContext(context.serviceContext, () =>
          // Scoped to the jobs these payables are on — the release gate reads a
          // vendor against the project overlay, and a signal resolved without
          // it reads clear on a bill the gate will stop.
          getCompaniesComplianceStatus(companyIds, context.orgId, { projectIds }),
        )
      : Promise.resolve<Record<string, ComplianceStatusSummary>>({}),
    loadLotContext(context, projectIds),
    loadDocuments(context, bills),
  ])
  return { rules, complianceByCompanyId, lots, documents }
}

export async function listMobilePayables(
  context: MobileOrgContext,
  params: { page?: number; pageSize?: number; search?: string } = {},
): Promise<MobilePayablesPage> {
  const scope = await resolveApprovalScope(context)
  requireApprovalScope(scope)

  const page = Math.max(1, Math.floor(params.page ?? 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)))
  const from = (page - 1) * pageSize
  const search = String(params.search ?? "").trim().slice(0, MAX_SEARCH_LENGTH).replace(/[,%()]/g, " ").trim()

  let query = context.serviceSupabase
    .from("vendor_bills")
    .select(vendorBillSelect, { count: "exact" })
    .eq("org_id", context.orgId)
    // Awaiting a decision, and a real obligation: a quick capture nobody has
    // finished is not approvable, and a vendor credit is money coming back.
    .eq("status", "pending")
    .or("metadata->>creation_state.is.null,metadata->>creation_state.neq.draft")
    .or("metadata->>source.is.null,metadata->>source.neq.vendor_credit")

  if (!scope.orgWide) query = query.in("project_id", scope.projectIds)
  if (search) query = query.or(`bill_number.ilike.%${search}%,qbo_vendor_name.ilike.%${search}%`)

  const { data, error, count } = await query
    // Oldest due first: the queue is a deadline list, so if it truncates, what
    // it covers is the most urgent rather than an arbitrary page.
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1)

  if (error) {
    throw new MobileAPIError(500, "payables_unavailable", "Your approval queue could not be loaded.")
  }

  const bills = await hydrateVendorBills(context.serviceSupabase, context.orgId, data ?? [])
  const decorations = await decorate(context, bills)
  const total = count ?? 0
  return {
    payables: bills.map((bill) => mapPayable(bill, decorations)),
    pagination: {
      page,
      page_size: pageSize,
      total,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
    },
  }
}

function readEvidence(bill: VendorBillSummary, metadata: Record<string, unknown>): MobilePayableEvidenceDTO {
  const lineMatch = readLineMatchAssessment(metadata) ?? bill.line_match ?? null
  const waiver = waiverVerificationSchema.safeParse(metadata.waiver_verification)
  return {
    line_match: lineMatch
      ? {
          commitment_id: lineMatch.commitmentId,
          matched_at: lineMatch.matchedAt,
          unmatched_count: lineMatch.rollup.unmatchedCount,
          over_line_count: lineMatch.rollup.overLineCount,
          over_commitment_cents: lineMatch.rollup.overCommitmentCents,
          projected_total_cents: lineMatch.rollup.projectedTotalCents,
          revised_commitment_cents: lineMatch.rollup.revisedCommitmentCents,
          notes: lineMatch.notes,
        }
      : null,
    waiver_verification: waiver.success
      ? {
          matches: waiver.data.matches,
          confidence: waiver.data.confidence,
          mismatch_summary: waiver.data.matches ? null : summarizeWaiverMismatches(waiver.data.mismatches),
        }
      : null,
  }
}

export async function getMobilePayable(context: MobileOrgContext, billId: string): Promise<MobilePayableDetailDTO> {
  if (!z.string().uuid().safeParse(billId).success) {
    throw new MobileAPIError(400, "invalid_payable", "That payable id is not valid.")
  }

  const { data, error } = await context.serviceSupabase
    .from("vendor_bills")
    // `vendorBillSelect` already carries `metadata`, which is where the advisory
    // evidence is stored — asking for it twice is what PostgREST calls a duplicate.
    .select(vendorBillSelect)
    .eq("org_id", context.orgId)
    .eq("id", billId)
    .maybeSingle()
  if (error || !data) {
    throw new MobileAPIError(404, "payable_not_found", "That payable could not be found.")
  }

  const [bill] = await hydrateVendorBills(context.serviceSupabase, context.orgId, [data])
  if (!bill) {
    throw new MobileAPIError(404, "payable_not_found", "That payable could not be found.")
  }

  const mayApprove = bill.project_id
    ? (await authorizeMany({
        permission: "bill.approve",
        userId: context.user.id,
        orgId: context.orgId,
        projectIds: [bill.project_id],
      })).get(bill.project_id) === true
    : await hasPermission("bill.approve", {
        supabase: context.serviceSupabase,
        orgId: context.orgId,
        userId: context.user.id,
      })

  const [decorations, holdEvaluation] = await Promise.all([
    decorate(context, [bill]),
    // Exactly what the web desk does when a payable is opened: attempt the real
    // verdict, and let a reader without `payment.release` still see the payable.
    runWithServiceOrgContext(context.serviceContext, () => evaluateHolds(billId, context.orgId)).catch(() => null),
  ])

  const metadata = (data.metadata ?? {}) as Record<string, unknown>
  return {
    ...mapPayable(bill, decorations),
    // Mirrors the desk, which disables Approve while a blocking hold stands. When
    // the evaluation could not run there is nothing to block on, and the release
    // gate still catches it before money moves.
    can_approve: mayApprove && (holdEvaluation?.blockingCount ?? 0) === 0,
    evidence: readEvidence(bill, metadata),
  }
}

const decisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    /**
     * Not optional. An approver decides the payable they were shown, and a phone
     * that has been in a pocket since this morning must not overwrite a decision
     * the AP desk already made. The service compares it to the stored row.
     */
    expected_updated_at: z.string().min(1),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((value) => value.decision !== "rejected" || (value.reason?.length ?? 0) >= 8, {
    // The vendor is shown this verbatim, so the service demands at least a few
    // words. Checking it here too turns a 422 from deep in the service into a
    // field error the app can put under the text box.
    path: ["reason"],
    message: "Tell the vendor why in at least a few words",
  })

/** The service's optimistic-concurrency failure, which is a conflict rather than a rejection. */
const CONFLICT_MARKER = "changed since you opened it"

export async function decideMobilePayable(
  context: MobileOrgContext,
  billId: string,
  body: unknown,
): Promise<MobilePayableDecisionResultDTO> {
  if (!z.string().uuid().safeParse(billId).success) {
    throw new MobileAPIError(400, "invalid_payable", "That payable id is not valid.")
  }
  const parsed = decisionSchema.safeParse(body)
  if (!parsed.success) {
    throw new MobileAPIError(
      400,
      "invalid_decision",
      parsed.error.issues[0]?.message ?? "A decision and the values you reviewed are required.",
    )
  }

  try {
    // `updateVendorBillStatus` is the one home for a bill status change: it holds
    // the `bill.approve` check, the rejection-reason rule, the coding and
    // cost-code gates, and the ledger propagation with its rollback. Nothing
    // about that is re-stated here.
    const updated = await runWithServiceOrgContext(context.serviceContext, () =>
      updateVendorBillStatus({
        billId,
        orgId: context.orgId,
        input: {
          status: parsed.data.decision,
          expected_updated_at: parsed.data.expected_updated_at,
          ...(parsed.data.decision === "rejected" ? { rejection_reason: parsed.data.reason } : {}),
        },
      }),
    )
    return { id: updated.id, status: updated.status, updated_at: updated.updated_at ?? null }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The decision could not be recorded."
    if (message.includes(CONFLICT_MARKER)) {
      throw new MobileAPIError(409, "payable_conflict", message)
    }
    // The service's messages are written for the person deciding — this payable
    // is no longer pending, the coding does not add up — so they are surfaced
    // rather than replaced with a generic failure.
    throw new MobileAPIError(422, "decision_rejected", message)
  }
}
