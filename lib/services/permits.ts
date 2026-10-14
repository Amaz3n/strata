import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { loadApprovalGateSettings } from "@/lib/financials/approval-gates"
import { readAllRows } from "@/lib/land/paging"
import {
  PERMIT_FEE_DUE,
  PERMIT_FEE_KIND_LABELS,
  PERMIT_FEE_KINDS,
  feeRemainingToLinkCents,
  permitFeeSummary,
  type PermitFeeFact,
  type PermitFeePaymentFact,
} from "@/lib/permits/fees"
import {
  PERMIT_DECISIONS,
  PERMIT_STAGE_LABELS,
  PERMIT_TYPE_LABELS,
  PERMIT_TYPES,
  ROUND_STATUSES,
  approvalBlockers,
  daysBetween,
  permitAging,
  permitApplicationStage,
  permitReminderDue,
  permitReminderKey,
  rankPermitQueue,
} from "@/lib/permits/lifecycle"
import { authorize, getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { listCostCodes } from "@/lib/services/cost-codes"
import { createProjectExpense } from "@/lib/services/cost-plus"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { ensureVendorRoleWithClient } from "@/lib/services/party-roles"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { createProjectVendorBill, deleteVendorBill } from "@/lib/services/vendor-bills"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { chunk } from "@/lib/utils"
import {
  assessPermitFeeSchema,
  assignPermitApplicationSchema,
  createPermitApplicationSchema,
  linkPermitFeePaymentSchema,
  payPermitFeeSchema,
  permitQueueFiltersSchema,
  recordCorrectionRoundSchema,
  recordPermitDecisionSchema,
  recordPermitSubmissionSchema,
  setCommunityPermitAuthoritySchema,
  setPermitDocumentSchema,
  setPermitJurisdictionProfileSchema,
  updateCorrectionRoundSchema,
  voidPermitFeeSchema,
} from "@/lib/validation/permits"

/**
 * Permit applications on a home: what was submitted, what the authority sent
 * back, what it decided, and what its fees cost. Every write is one SQL
 * function (20261013120000_permits) that takes the actor from the session,
 * re-checks permit.write and the home's reach, and records its audit, event
 * and reindex in the same transaction — the service checks first so a refusal
 * reads well. Reads run on the caller's session, so row security scopes them.
 */

/** Applications a home shows before it says it is truncated. */
const HOME_APPLICATION_CAP = 50
const HOME_FILE_CAP = 200
const MEMBER_CAP = 300
/** Rows the Starts desk's permits band draws; past this it says how many it left out. */
export const PERMIT_QUEUE_CAP = 200
const AUTHORITY_PAGE_SIZE = 25
/** Unlinked payables to a home's authorities offered for linking. */
const LINKABLE_CAP = 50

const APPLICATION_SELECT =
  "id,org_id,project_id,lot_id,jurisdiction_company_id,permit_type,owner_user_id,house_plan_version_id,house_plan_elevation_id,permit_number,decision,decided_on,decided_by,issued_on,expires_on,issued_permit_file_id,approved_plans_file_id,decision_note,supersedes_id,superseded_at,created_at"

const applicationRow = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  lot_id: z.string().uuid().nullable(),
  jurisdiction_company_id: z.string().uuid(),
  permit_type: z.enum(PERMIT_TYPES),
  owner_user_id: z.string().uuid().nullable(),
  house_plan_version_id: z.string().uuid().nullable(),
  house_plan_elevation_id: z.string().uuid().nullable(),
  permit_number: z.string().nullable(),
  decision: z.enum(PERMIT_DECISIONS).nullable(),
  decided_on: z.string().nullable(),
  decided_by: z.string().uuid().nullable(),
  issued_on: z.string().nullable(),
  expires_on: z.string().nullable(),
  issued_permit_file_id: z.string().uuid().nullable(),
  approved_plans_file_id: z.string().uuid().nullable(),
  decision_note: z.string().nullable(),
  supersedes_id: z.string().uuid().nullable(),
  superseded_at: z.string().nullable(),
  created_at: z.string(),
})

const documentRow = z.object({
  id: z.string().uuid(), application_id: z.string().uuid(), document_kind: z.string(), label: z.string(),
  required_for: z.enum(["submission", "decision"]), source: z.enum(["default", "jurisdiction", "added"]),
  file_id: z.string().uuid().nullable(), attached_at: z.string().nullable(), sort_order: z.number().int(),
})

const submissionRow = z.object({
  id: z.string().uuid(), application_id: z.string().uuid(), submission_no: z.number().int(),
  kind: z.enum(["initial", "resubmission", "revision"]), submitted_on: z.string(), submitted_by: z.string().uuid(),
  reference: z.string().nullable(), expected_decision_on: z.string(), note: z.string().nullable(),
})

const roundRow = z.object({
  id: z.string().uuid(), application_id: z.string().uuid(), round_no: z.number().int(), received_on: z.string(),
  comments: z.string(), comment_file_id: z.string().uuid().nullable(), owner_user_id: z.string().uuid().nullable(),
  due_on: z.string().nullable(), status: z.enum(ROUND_STATUSES), responded_on: z.string().nullable(), resolved_on: z.string().nullable(),
})

const historyRow = z.object({
  id: z.string().uuid(), round_id: z.string().uuid(), actor_id: z.string().uuid().nullable(),
  from_status: z.string().nullable(), to_status: z.string(), from_owner_user_id: z.string().uuid().nullable(),
  to_owner_user_id: z.string().uuid().nullable(), from_due_on: z.string().nullable(), to_due_on: z.string().nullable(),
  note: z.string().nullable(), created_at: z.string(),
})

const feeRow = z.object({
  id: z.string().uuid(), application_id: z.string().uuid(), kind: z.enum(PERMIT_FEE_KINDS), description: z.string().nullable(),
  amount_cents: z.coerce.number().int(), assessed_on: z.string(), due_before: z.enum(PERMIT_FEE_DUE).nullable(),
  cost_code_id: z.string().uuid().nullable(), status: z.enum(["open", "void"]), void_reason: z.string().nullable(),
  replaces_fee_id: z.string().uuid().nullable(),
})

const relationObject = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (Array.isArray(value) ? value[0] ?? null : value), schema.nullable())

const paymentRow = z.object({
  id: z.string().uuid(), fee_id: z.string().uuid(), vendor_bill_id: z.string().uuid().nullable(), project_expense_id: z.string().uuid().nullable(),
  bill: relationObject(z.object({ bill_number: z.string().nullable(), status: z.string(), total_cents: z.coerce.number().nullable(), paid_cents: z.coerce.number() })),
  expense: relationObject(z.object({ status: z.string(), amount_cents: z.coerce.number(), tax_cents: z.coerce.number(), expense_date: z.string() })),
})

const positionRow = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), lot_id: z.string().uuid().nullable(), permit_type: z.enum(PERMIT_TYPES),
  owner_user_id: z.string().uuid().nullable(), permit_number: z.string().nullable(), decision: z.enum(PERMIT_DECISIONS).nullable(),
  expires_on: z.string().nullable(), superseded_at: z.string().nullable(), community_id: z.string().uuid().nullable(),
  lot_number: z.string().nullable(), block: z.string().nullable(), community_name: z.string().nullable(),
  submission_count: z.number().int(), expected_decision_on: z.string().nullable(), open_rounds: z.number().int(),
  unresolved_rounds: z.number().int(), next_round_due_on: z.string().nullable(), start_target_week: z.string().nullable(),
  jurisdiction_company_id: z.string().uuid(), today_local: z.string(),
})

type ApplicationRow = z.infer<typeof applicationRow>
type RoundRow = z.infer<typeof roundRow>

function rpcError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

async function readNames(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.from("memberships").select("user_id,user:app_users!memberships_user_id_fkey(full_name,email)")
    .eq("org_id", orgId).eq("status", "active").limit(MEMBER_CAP)
  if (error) throw new Error(`Unable to read the team: ${error.message}`)
  const userSchema = relationObject(z.object({ full_name: z.string().nullable(), email: z.string().nullable() }))
  return (data ?? []).map((row) => {
    const user = userSchema.parse(row.user)
    return { id: z.string().uuid().parse(row.user_id), name: user?.full_name || user?.email || "Team member" }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

async function readCompanyNames(supabase: SupabaseClient, orgId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map<string, string>()
  const results = await Promise.all(chunk(unique, 100).map((batch) =>
    supabase.from("companies").select("id,name").eq("org_id", orgId).in("id", batch)))
  const failed = results.find((result) => result.error)?.error
  if (failed) throw new Error(`Unable to read permitting authorities: ${failed.message}`)
  return new Map(results.flatMap((result) => z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(result.data ?? []))
    .map((row) => [row.id, row.name]))
}

function paymentFact(row: z.infer<typeof paymentRow>): PermitFeePaymentFact {
  if (row.vendor_bill_id) {
    return { feeId: row.fee_id, source: "bill", totalCents: row.bill?.total_cents ?? 0, paidCents: row.bill?.paid_cents ?? 0, status: row.bill?.status ?? "pending" }
  }
  return {
    feeId: row.fee_id, source: "expense", totalCents: (row.expense?.amount_cents ?? 0) + (row.expense?.tax_cents ?? 0),
    paidCents: 0, status: row.expense?.status ?? "submitted",
  }
}

function feeFact(row: z.infer<typeof feeRow>): PermitFeeFact {
  return { id: row.id, kind: row.kind, amountCents: row.amount_cents, status: row.status, dueBefore: row.due_before }
}

function feeLabel(fee: PermitFeeFact) {
  return `${PERMIT_FEE_KIND_LABELS[fee.kind]} $${(fee.amountCents / 100).toFixed(2)}`
}

function roundAgingInput(rounds: RoundRow[]) {
  return rounds.map((round) => ({ status: round.status, dueOn: round.due_on }))
}

/** Everything the home's Permits workbench shows. */
export async function getProjectPermits(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("permit.read", context)
  await requireAuthorization({ permission: "permit.read", orgId: context.orgId, userId: context.userId, projectId,
    supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true })
  const [project, applications, files, members, canWrite, canBill, canReadBills, localToday, costCodes] = await Promise.all([
    context.supabase.from("projects").select("id,name,lots(id,lot_number,block,house_plan_version_id,community:communities(id,name,permit_jurisdiction_company_id))")
      .eq("org_id", context.orgId).eq("id", projectId).maybeSingle(),
    context.supabase.from("permit_applications").select(APPLICATION_SELECT).eq("org_id", context.orgId).eq("project_id", projectId)
      .order("created_at", { ascending: false }).limit(HOME_APPLICATION_CAP + 1),
    context.supabase.from("files").select("id,file_name,created_at").eq("org_id", context.orgId).eq("project_id", projectId)
      .is("archived_at", null).order("created_at", { ascending: false }).limit(HOME_FILE_CAP + 1),
    readNames(context.supabase, context.orgId),
    authorize({ permission: "permit.write", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
    authorize({ permission: "bill.write", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
    authorize({ permission: "bill.read", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
    context.supabase.rpc("permit_local_today", { p_org_id: context.orgId, p_project_id: projectId }),
    listCostCodes(context.orgId),
  ])
  if (project.error) throw new Error(`Unable to read the home: ${project.error.message}`)
  if (!project.data) throw new Error("Home not found")
  if (applications.error) throw new Error(`Unable to read permit applications: ${applications.error.message}`)
  if (files.error) throw new Error(`Unable to read the home's files: ${files.error.message}`)
  rpcError(localToday.error)
  const today = z.string().date().parse(localToday.data)
  const rows = z.array(applicationRow).parse(applications.data ?? [])
  const shown = rows.slice(0, HOME_APPLICATION_CAP)
  const ids = shown.map((row) => row.id)

  const jurisdictionIds = [...new Set(shown.map((row) => row.jurisdiction_company_id))]
  // Bills and expenses offered for linking are payables: only whoever reads
  // payables, and may link them, sees them.
  const offerPayables = canReadBills.allowed && (canWrite.allowed || canBill.allowed) && jurisdictionIds.length > 0
  // A fee's payables are read service-role on this authorized home: whoever
  // reconciles permit fees (the starts coordinator) is rarely a member of the
  // project, and row security would hide the bill and read the fee as unpaid.
  const payables = createServiceSupabaseClient()
  const [documents, submissions, rounds, history, fees, payments, companyNames, bills, expenses] = await Promise.all([
    ids.length ? context.supabase.from("permit_application_documents")
      .select("id,application_id,document_kind,label,required_for,source,file_id,attached_at,sort_order")
      .eq("org_id", context.orgId).in("application_id", ids).order("sort_order").limit(1000) : Promise.resolve({ data: [], error: null }),
    ids.length ? context.supabase.from("permit_submissions")
      .select("id,application_id,submission_no,kind,submitted_on,submitted_by,reference,expected_decision_on,note")
      .eq("org_id", context.orgId).in("application_id", ids).order("submission_no").limit(1000) : Promise.resolve({ data: [], error: null }),
    ids.length ? context.supabase.from("permit_correction_rounds")
      .select("id,application_id,round_no,received_on,comments,comment_file_id,owner_user_id,due_on,status,responded_on,resolved_on")
      .eq("org_id", context.orgId).in("application_id", ids).order("round_no").limit(1000) : Promise.resolve({ data: [], error: null }),
    ids.length ? context.supabase.from("permit_correction_round_history")
      .select("id,round_id,actor_id,from_status,to_status,from_owner_user_id,to_owner_user_id,from_due_on,to_due_on,note,created_at")
      .eq("org_id", context.orgId).in("application_id", ids).order("created_at").limit(2000) : Promise.resolve({ data: [], error: null }),
    ids.length ? context.supabase.from("permit_fees")
      .select("id,application_id,kind,description,amount_cents,assessed_on,due_before,cost_code_id,status,void_reason,replaces_fee_id")
      .eq("org_id", context.orgId).in("application_id", ids).order("assessed_on").order("created_at").limit(1000) : Promise.resolve({ data: [], error: null }),
    ids.length ? payables.from("permit_fee_payments")
      .select("id,fee_id,vendor_bill_id,project_expense_id,bill:vendor_bills(bill_number,status,total_cents,paid_cents),expense:project_expenses(status,amount_cents,tax_cents,expense_date)")
      .eq("org_id", context.orgId).eq("project_id", projectId).limit(1000) : Promise.resolve({ data: [], error: null }),
    readCompanyNames(context.supabase, context.orgId, jurisdictionIds),
    offerPayables ? payables.from("vendor_bills").select("id,company_id,bill_number,status,total_cents,bill_date")
      .eq("org_id", context.orgId).eq("project_id", projectId).in("company_id", jurisdictionIds).neq("status", "rejected")
      .order("bill_date", { ascending: false }).limit(LINKABLE_CAP) : Promise.resolve({ data: [], error: null }),
    offerPayables ? payables.from("project_expenses").select("id,vendor_company_id,status,amount_cents,tax_cents,expense_date")
      .eq("org_id", context.orgId).eq("project_id", projectId).in("vendor_company_id", jurisdictionIds).neq("status", "rejected")
      .order("expense_date", { ascending: false }).limit(LINKABLE_CAP) : Promise.resolve({ data: [], error: null }),
  ])
  for (const [label, result] of [["documents", documents], ["submissions", submissions], ["correction rounds", rounds],
    ["correction history", history], ["fees", fees], ["fee payments", payments], ["bills", bills], ["expenses", expenses]] as const) {
    if (result.error) throw new Error(`Unable to read permit ${label}: ${result.error.message}`)
  }
  const documentRows = z.array(documentRow).parse(documents.data ?? [])
  const submissionRows = z.array(submissionRow).parse(submissions.data ?? [])
  const roundRows = z.array(roundRow).parse(rounds.data ?? [])
  const historyRows = z.array(historyRow).parse(history.data ?? [])
  const feeRows = z.array(feeRow).parse(fees.data ?? [])
  const paymentRows = z.array(paymentRow).parse(payments.data ?? [])
  const names = new Map(members.map((member) => [member.id, member.name]))
  const costCodeLabels = new Map(costCodes.map((code) => [code.id, code.code ? `${code.code} — ${code.name}` : code.name]))
  const linked = new Set(paymentRows.flatMap((row) => [row.vendor_bill_id, row.project_expense_id]).filter((id): id is string => Boolean(id)))
  const linkablePayables = [
    ...z.array(z.object({ id: z.string().uuid(), company_id: z.string().uuid(), bill_number: z.string().nullable(), status: z.string(), total_cents: z.coerce.number().nullable(), bill_date: z.string().nullable() }))
      .parse(bills.data ?? []).filter((row) => !linked.has(row.id)).map((row) => ({
        kind: "bill" as const, id: row.id, companyId: row.company_id, label: `Bill ${row.bill_number ?? ""} · ${row.bill_date ?? ""}`.trim(),
        status: row.status, totalCents: row.total_cents ?? 0,
      })),
    ...z.array(z.object({ id: z.string().uuid(), vendor_company_id: z.string().uuid(), status: z.string(), amount_cents: z.coerce.number(), tax_cents: z.coerce.number(), expense_date: z.string() }))
      .parse(expenses.data ?? []).filter((row) => !linked.has(row.id)).map((row) => ({
        kind: "expense" as const, id: row.id, companyId: row.vendor_company_id, label: `Expense · ${row.expense_date}`,
        status: row.status, totalCents: row.amount_cents + row.tax_cents,
      })),
  ]

  const lotSchema = relationObject(z.object({
    id: z.string().uuid(), lot_number: z.string(), block: z.string().nullable(), house_plan_version_id: z.string().uuid().nullable(),
    community: relationObject(z.object({ id: z.string().uuid(), name: z.string(), permit_jurisdiction_company_id: z.string().uuid().nullable() })),
  }))
  const lot = lotSchema.parse(project.data.lots)
  const fileRows = z.array(z.object({ id: z.string().uuid(), file_name: z.string() })).parse(files.data ?? [])
  const authorityId = lot?.community?.permit_jurisdiction_company_id ?? null
  const authorityName = authorityId ? (await readCompanyNames(context.supabase, context.orgId, [authorityId])).get(authorityId) ?? null : null

  const applicationsDto = shown.map((row) => {
    const docs = documentRows.filter((doc) => doc.application_id === row.id)
    const subs = submissionRows.filter((sub) => sub.application_id === row.id)
    const myRounds = roundRows.filter((round) => round.application_id === row.id)
    const myFees = feeRows.filter((fee) => fee.application_id === row.id)
    const feeFacts = myFees.map(feeFact)
    const myPayments = paymentRows.filter((payment) => myFees.some((fee) => fee.id === payment.fee_id))
    const paymentFacts = myPayments.map(paymentFact)
    const summary = permitFeeSummary(feeFacts, paymentFacts)
    const openRounds = myRounds.filter((round) => round.status === "open").length
    const stage = permitApplicationStage({
      decision: row.decision, supersededAt: row.superseded_at, expiresOn: row.expires_on, submissionCount: subs.length, openRounds,
    }, today)
    const latest = subs[subs.length - 1] ?? null
    return {
      id: row.id,
      permitType: row.permit_type,
      permitTypeLabel: PERMIT_TYPE_LABELS[row.permit_type],
      jurisdiction: { id: row.jurisdiction_company_id, name: companyNames.get(row.jurisdiction_company_id) ?? "Authority" },
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_user_id ? names.get(row.owner_user_id) ?? "Former member" : null,
      permitNumber: row.permit_number,
      decision: row.decision,
      decidedOn: row.decided_on,
      issuedOn: row.issued_on,
      expiresOn: row.expires_on,
      issuedPermitFileId: row.issued_permit_file_id,
      approvedPlansFileId: row.approved_plans_file_id,
      decisionNote: row.decision_note,
      supersedesId: row.supersedes_id,
      supersededAt: row.superseded_at,
      reviewedPlanVersionId: row.house_plan_version_id,
      createdAt: row.created_at,
      stage,
      stageLabel: PERMIT_STAGE_LABELS[stage],
      aging: permitAging({ stage, expectedDecisionOn: latest?.expected_decision_on ?? null, rounds: roundAgingInput(myRounds) }, today),
      expectedDecisionOn: latest?.expected_decision_on ?? null,
      lastSubmittedOn: latest?.submitted_on ?? null,
      documents: docs.map((doc) => ({
        id: doc.id, kind: doc.document_kind, label: doc.label, requiredFor: doc.required_for, source: doc.source,
        fileId: doc.file_id, fileName: doc.file_id ? fileRows.find((file) => file.id === doc.file_id)?.file_name ?? "File on this home" : null,
        attachedAt: doc.attached_at,
      })),
      submissions: subs.map((sub) => ({
        id: sub.id, number: sub.submission_no, kind: sub.kind, submittedOn: sub.submitted_on,
        submittedBy: names.get(sub.submitted_by) ?? "Former member", reference: sub.reference,
        expectedDecisionOn: sub.expected_decision_on, note: sub.note,
      })),
      rounds: myRounds.map((round) => ({
        id: round.id, number: round.round_no, receivedOn: round.received_on, comments: round.comments, commentFileId: round.comment_file_id,
        ownerUserId: round.owner_user_id, ownerName: round.owner_user_id ? names.get(round.owner_user_id) ?? "Former member" : null,
        dueOn: round.due_on, status: round.status, respondedOn: round.responded_on, resolvedOn: round.resolved_on,
        overdueDays: round.status === "open" && round.due_on && round.due_on < today ? daysBetween(round.due_on, today) : 0,
        history: historyRows.filter((entry) => entry.round_id === round.id).map((entry) => ({
          id: entry.id, at: entry.created_at, actor: entry.actor_id ? names.get(entry.actor_id) ?? "Former member" : "System",
          fromStatus: entry.from_status, toStatus: entry.to_status,
          fromOwner: entry.from_owner_user_id ? names.get(entry.from_owner_user_id) ?? "Former member" : null,
          toOwner: entry.to_owner_user_id ? names.get(entry.to_owner_user_id) ?? "Former member" : null,
          fromDueOn: entry.from_due_on, toDueOn: entry.to_due_on, note: entry.note,
        })),
      })),
      fees: myFees.map((fee) => {
        const position = summary.fees.find((entry) => entry.feeId === fee.id)
        return {
          id: fee.id, kind: fee.kind, kindLabel: PERMIT_FEE_KIND_LABELS[fee.kind], description: fee.description, amountCents: fee.amount_cents,
          assessedOn: fee.assessed_on, dueBefore: fee.due_before, status: fee.status,
          costCodeId: fee.cost_code_id, costCodeLabel: fee.cost_code_id ? costCodeLabels.get(fee.cost_code_id) ?? "Inactive cost code" : null, voidReason: fee.void_reason, replacesFeeId: fee.replaces_fee_id,
          paidCents: position?.paidCents ?? 0, linkedCents: position?.linkedCents ?? 0, varianceCents: position?.varianceCents ?? 0,
          reconciled: position?.reconciled ?? false, remainingToLinkCents: feeRemainingToLinkCents(feeFact(fee), paymentFacts),
          payments: myPayments.filter((payment) => payment.fee_id === fee.id).map((payment) => ({
            id: payment.id,
            source: payment.vendor_bill_id ? "bill" as const : "expense" as const,
            sourceId: payment.vendor_bill_id ?? payment.project_expense_id ?? payment.id,
            label: payment.vendor_bill_id ? `Bill ${payment.bill?.bill_number ?? ""}`.trim() : `Expense ${payment.expense?.expense_date ?? ""}`.trim(),
            status: payment.bill?.status ?? payment.expense?.status ?? "unknown",
            totalCents: paymentFact(payment).totalCents,
          })),
        }
      }),
      feeTotals: { obligatedCents: summary.obligatedCents, paidCents: summary.paidCents, varianceCents: summary.varianceCents, reconciled: summary.reconciled },
      approvalBlockers: stage === "draft" || stage === "submitted" || stage === "corrections_requested"
        ? approvalBlockers({
          submissionCount: subs.length,
          missingDocuments: docs.filter((doc) => !doc.file_id).map((doc) => doc.label),
          openRounds,
          needsReviewedPlan: Boolean(row.lot_id) && !row.house_plan_version_id,
          unpaidPreIssuanceFees: summary.unpaidPreIssuance.map(feeLabel),
        })
        : [],
      missingSubmissionDocuments: docs.filter((doc) => doc.required_for === "submission" && !doc.file_id).map((doc) => doc.label),
    }
  })

  return {
    projectId,
    today,
    projectName: z.string().parse(project.data.name),
    lot: lot ? { id: lot.id, label: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number, planPinned: Boolean(lot.house_plan_version_id) } : null,
    communityAuthority: authorityId ? { id: authorityId, name: authorityName ?? "Authority" } : null,
    applications: applicationsDto,
    truncated: rows.length > HOME_APPLICATION_CAP,
    files: fileRows.slice(0, HOME_FILE_CAP).map((file) => ({ id: file.id, name: file.file_name })),
    filesTruncated: fileRows.length > HOME_FILE_CAP,
    members,
    linkablePayables,
    costCodes,
    canWrite: canWrite.allowed,
    canPayByBill: canBill.allowed,
  }
}

export type ProjectPermitsDTO = Awaited<ReturnType<typeof getProjectPermits>>
export type PermitApplicationDTO = ProjectPermitsDTO["applications"][number]

async function writeContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("permit.write", context)
  return context
}

async function applicationProject(context: OrgServiceContext, applicationId: string) {
  const { data, error } = await context.supabase.from("permit_applications").select("project_id")
    .eq("org_id", context.orgId).eq("id", applicationId).maybeSingle()
  if (error) throw new Error(`Unable to read the permit application: ${error.message}`)
  if (!data) throw new Error("Permit application not found")
  return z.string().uuid().parse(data.project_id)
}

async function authorizeHome(context: OrgServiceContext, projectId: string, permission = "permit.write") {
  await requireAuthorization({ permission, orgId: context.orgId, userId: context.userId, projectId,
    supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true })
}

export async function createPermitApplication(input: unknown, orgId?: string) {
  const parsed = createPermitApplicationSchema.parse(input)
  const context = await writeContext(orgId)
  await authorizeHome(context, parsed.projectId)
  const { data, error } = await context.supabase.rpc("create_permit_application", {
    p_org_id: context.orgId, p_project_id: parsed.projectId, p_jurisdiction_company_id: parsed.jurisdictionCompanyId,
    p_permit_type: parsed.permitType, p_owner_user_id: parsed.ownerUserId ?? null, p_supersedes_id: parsed.supersedesId ?? null,
  })
  if (error) {
    throw new Error(error.code === "23505" ? "This home already has a live building application; open a revision of it instead." : error.message)
  }
  return { applicationId: z.string().uuid().parse(data) }
}

export async function assignPermitApplication(input: unknown, orgId?: string) {
  const parsed = assignPermitApplicationSchema.parse(input)
  const context = await writeContext(orgId)
  await authorizeHome(context, await applicationProject(context, parsed.applicationId))
  rpcError((await context.supabase.rpc("assign_permit_application", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_owner_user_id: parsed.ownerUserId,
  })).error)
}

export async function setPermitDocument(input: unknown, orgId?: string) {
  const parsed = setPermitDocumentSchema.parse(input)
  const context = await writeContext(orgId)
  await authorizeHome(context, await applicationProject(context, parsed.applicationId))
  rpcError((await context.supabase.rpc("set_permit_document", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_document_kind: parsed.documentKind,
    p_label: parsed.label ?? null, p_required_for: parsed.requiredFor ?? null, p_file_id: parsed.fileId,
  })).error)
}

export async function recordPermitSubmission(input: unknown, orgId?: string) {
  const parsed = recordPermitSubmissionSchema.parse(input)
  const context = await writeContext(orgId)
  await authorizeHome(context, await applicationProject(context, parsed.applicationId))
  const { data, error } = await context.supabase.rpc("record_permit_submission", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_submitted_on: parsed.submittedOn,
    p_reference: parsed.reference ?? null, p_note: parsed.note ?? null, p_responds_to_round_id: parsed.respondsToRoundId ?? null,
  })
  rpcError(error)
  return { submissionId: z.string().uuid().parse(data) }
}

export async function recordCorrectionRound(input: unknown, orgId?: string) {
  const parsed = recordCorrectionRoundSchema.parse(input)
  const context = await writeContext(orgId)
  await authorizeHome(context, await applicationProject(context, parsed.applicationId))
  const { data, error } = await context.supabase.rpc("record_permit_correction_round", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_received_on: parsed.receivedOn, p_comments: parsed.comments,
    p_comment_file_id: parsed.commentFileId ?? null, p_owner_user_id: parsed.ownerUserId ?? null, p_due_on: parsed.dueOn,
  })
  rpcError(error)
  return { roundId: z.string().uuid().parse(data) }
}

export async function updateCorrectionRound(input: unknown, orgId?: string) {
  const parsed = updateCorrectionRoundSchema.parse(input)
  const context = await writeContext(orgId)
  const { data: round, error: readError } = await context.supabase.from("permit_correction_rounds").select("project_id")
    .eq("org_id", context.orgId).eq("id", parsed.roundId).maybeSingle()
  if (readError) throw new Error(`Unable to read the correction round: ${readError.message}`)
  if (!round) throw new Error("Correction round not found")
  await authorizeHome(context, z.string().uuid().parse(round.project_id))
  const patch = {
    ...(parsed.ownerUserId !== undefined ? { owner_user_id: parsed.ownerUserId } : {}),
    ...(parsed.dueOn !== undefined ? { due_on: parsed.dueOn } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
  }
  rpcError((await context.supabase.rpc("update_permit_correction_round", {
    p_org_id: context.orgId, p_round_id: parsed.roundId, p_patch: patch, p_note: parsed.note ?? null,
  })).error)
}

export async function recordPermitDecision(input: unknown, orgId?: string) {
  const parsed = recordPermitDecisionSchema.parse(input)
  const context = await writeContext(orgId)
  const projectId = await applicationProject(context, parsed.applicationId)
  await authorizeHome(context, projectId)
  if (parsed.decision === "not_required" && parsed.issuedPermitFileId) {
    rpcError((await context.supabase.rpc("set_permit_document", {
      p_org_id: context.orgId, p_application_id: parsed.applicationId, p_document_kind: "authority_letter",
      p_label: "Authority's no-permit letter", p_required_for: "decision", p_file_id: parsed.issuedPermitFileId,
    })).error)
  }
  rpcError((await context.supabase.rpc("record_permit_decision", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_decision: parsed.decision, p_decided_on: parsed.decidedOn,
    p_permit_number: parsed.permitNumber ?? null, p_issued_on: parsed.issuedOn ?? null, p_expires_on: parsed.expiresOn ?? null,
    p_issued_permit_file_id: parsed.issuedPermitFileId ?? null, p_approved_plans_file_id: parsed.approvedPlansFileId ?? null,
    p_note: parsed.note ?? null,
  })).error)
}

export async function assessPermitFee(input: unknown, orgId?: string) {
  const parsed = assessPermitFeeSchema.parse(input)
  const context = await writeContext(orgId)
  const projectId = await applicationProject(context, parsed.applicationId)
  await authorizeHome(context, projectId)
  // A fee is paid to the home's job cost; where its costs are coded, an
  // uncoded fee would become a bill or expense nobody can approve.
  if (!parsed.costCodeId) {
    const gates = await loadApprovalGateSettings({ supabase: createServiceSupabaseClient(), orgId: context.orgId, projectId })
    if (gates.cost_codes_enabled) throw new Error("This home's costs are coded: choose the cost code the fee is paid to")
  }
  const { data, error } = await context.supabase.rpc("assess_permit_fee", {
    p_org_id: context.orgId, p_application_id: parsed.applicationId, p_kind: parsed.kind, p_description: parsed.description ?? null,
    p_amount_cents: parsed.amountCents, p_assessed_on: parsed.assessedOn, p_due_before: parsed.dueBefore ?? null,
    p_cost_code_id: parsed.costCodeId ?? null, p_replaces_fee_id: parsed.replacesFeeId ?? null,
  })
  rpcError(error)
  return { feeId: z.string().uuid().parse(data) }
}

export async function voidPermitFee(input: unknown, orgId?: string) {
  const parsed = voidPermitFeeSchema.parse(input)
  const context = await writeContext(orgId)
  rpcError((await context.supabase.rpc("void_permit_fee", { p_org_id: context.orgId, p_fee_id: parsed.feeId, p_reason: parsed.reason })).error)
}

/**
 * Link a payable someone already entered, while it is unapproved and unpaid: a
 * bill by whoever manages permits or enters payables, an expense by whoever
 * manages permits. The function re-checks that on the fee's home for the member
 * passed in: it is callable by the service role only.
 */
export async function linkPermitFeePayment(input: unknown, orgId?: string) {
  const parsed = linkPermitFeePaymentSchema.parse(input)
  const context = await requireOrgContext(orgId)
  if (parsed.vendorBillId) await requireAnyPermission(["permit.write", "bill.write"], context)
  else await requirePermission("permit.write", context)
  const { data, error } = await createServiceSupabaseClient().rpc("link_permit_fee_payment", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_fee_id: parsed.feeId, p_vendor_bill_id: parsed.vendorBillId ?? null,
    p_project_expense_id: parsed.projectExpenseId ?? null,
  })
  rpcError(error)
  return { paymentId: z.string().uuid().parse(data) }
}

const payableFeeSchema = z.object({
  id: z.string().uuid(), kind: z.enum(PERMIT_FEE_KINDS), amount_cents: z.coerce.number().int(), status: z.enum(["open", "void"]),
  due_before: z.enum(PERMIT_FEE_DUE).nullable(), cost_code_id: z.string().uuid().nullable(), project_id: z.string().uuid(),
  application: relationObject(z.object({ jurisdiction_company_id: z.string().uuid(), permit_number: z.string().nullable(), permit_type: z.enum(PERMIT_TYPES) })),
})

/** A payable created for a fee that could not be linked to it is removed, so none stands unlinked on the home's job cost. */
async function discardUnlinkedPayable(context: OrgServiceContext, created: { kind: "bill" | "expense"; id: string }) {
  if (created.kind === "bill") {
    await deleteVendorBill({ billId: created.id, orgId: context.orgId })
    return
  }
  const service = createServiceSupabaseClient()
  const { data: before, error: readError } = await service.from("project_expenses").select("*").eq("org_id", context.orgId).eq("id", created.id).maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!before) return
  const { error } = await service.from("project_expenses").delete().eq("org_id", context.orgId).eq("id", created.id)
  if (error) throw new Error(error.message)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "project_expense", entityId: created.id, before, after: null })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "expense_discarded", entityType: "project_expense", entityId: created.id,
    payload: { project_id: before.project_id, reason: "permit_fee_link_failed" } })
}

/**
 * Pay a fee: payables stays the one home for creating a bill or an expense.
 * A bill from the authority is for whoever enters payables (bill.write); a
 * counter payment already made is an expense with its receipt, recorded by
 * a permit holder (permit.write): the catalog has no separate expense key. Either is created for what remains
 * of the fee, on the home's job cost, to the authority, then linked to the
 * fee. The fee is claimed first, so two payers cannot each create a payable
 * for the same remainder, and a payable that cannot be linked is removed.
 */
export async function payPermitFee(input: unknown, orgId?: string) {
  const parsed = payPermitFeeSchema.parse(input)
  const context = await requireOrgContext(orgId)
  if (parsed.via === "bill") await requirePermission("bill.write", context)
  else await requirePermission("permit.write", context)
  const { data, error } = await context.supabase.from("permit_fees")
    .select("id,kind,amount_cents,status,due_before,cost_code_id,project_id,application:permit_applications(jurisdiction_company_id,permit_number,permit_type)")
    .eq("org_id", context.orgId).eq("id", parsed.feeId).maybeSingle()
  if (error) throw new Error(`Unable to read the fee: ${error.message}`)
  if (!data) throw new Error("Permit fee not found")
  const fee = payableFeeSchema.parse(data)
  if (!fee.application) throw new Error("Permit application not found")
  const claim = await createServiceSupabaseClient().rpc("claim_permit_fee_payment", { p_org_id: context.orgId, p_actor_id: context.userId, p_fee_id: fee.id })
  rpcError(claim.error)
  const remaining = z.coerce.number().int().positive().parse(claim.data)
  const description = `${PERMIT_FEE_KIND_LABELS[fee.kind]} fee — ${PERMIT_TYPE_LABELS[fee.application.permit_type]} permit${fee.application.permit_number ? ` ${fee.application.permit_number}` : ""}`
  const companyId = fee.application.jurisdiction_company_id
  let created: { kind: "bill" | "expense"; id: string } | null = null
  try {
    if (parsed.via === "bill") {
      const bill = await createProjectVendorBill({
        projectId: fee.project_id,
        orgId: context.orgId,
        input: {
          company_id: companyId, bill_number: parsed.billNumber, bill_date: parsed.billDate, due_date: parsed.dueDate ?? undefined,
          total_cents: remaining, description,
          actual_lines: [{ amount_cents: remaining, project_id: fee.project_id, cost_code_id: fee.cost_code_id, description }],
        },
      })
      created = { kind: "bill", id: bill.id }
      const { paymentId } = await linkPermitFeePayment({ feeId: fee.id, vendorBillId: bill.id }, context.orgId)
      return { paymentId, vendorBillId: bill.id }
    }
    const expense = z.object({ id: z.string().uuid() }).parse(await createProjectExpense({
      projectId: fee.project_id, vendorCompanyId: companyId, costCodeId: fee.cost_code_id, expenseDate: new Date(`${parsed.paidOn}T12:00:00Z`), description,
      amountCents: remaining, taxCents: 0, paymentMethod: parsed.paymentMethod, receiptFileId: parsed.receiptFileId,
      isBillable: true, allowDuplicate: true,
    }, context.orgId))
    created = { kind: "expense", id: expense.id }
    // Money creates roles: the authority is a payee the directory recognises as a vendor.
    await ensureVendorRoleWithClient(context.supabase, context.orgId, companyId, context.userId)
    const { paymentId } = await linkPermitFeePayment({ feeId: fee.id, projectExpenseId: expense.id }, context.orgId)
    return { paymentId, projectExpenseId: expense.id }
  } catch (failure) {
    let leftover = ""
    if (created) {
      try {
        await discardUnlinkedPayable(context, created)
      } catch (discardError) {
        leftover = ` The ${created.kind} it created could not be removed (${discardError instanceof Error ? discardError.message : "unknown error"}); reject it in payables.`
      }
    }
    rpcError((await createServiceSupabaseClient().rpc("release_permit_fee_claim", { p_org_id: context.orgId, p_actor_id: context.userId, p_fee_id: fee.id })).error)
    throw new Error(`${failure instanceof Error ? failure.message : "Unable to record the fee payment"}${leftover}`)
  }
}

export async function setPermitJurisdictionProfile(input: unknown, orgId?: string) {
  const parsed = setPermitJurisdictionProfileSchema.parse(input)
  const context = await writeContext(orgId)
  const { error } = await context.supabase.rpc("set_permit_jurisdiction_profile", {
    p_org_id: context.orgId, p_company_id: parsed.companyId, p_review_days: parsed.reviewDays, p_portal_url: parsed.portalUrl ?? null,
    p_requirements: parsed.requirements.map((row) => ({
      permit_type: row.permitType, document_kind: row.documentKind, label: row.label, required_for: row.requiredFor,
    })),
  })
  rpcError(error)
}

export async function getPermitJurisdictionProfile(companyId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("permit.read", context)
  const [profile, requirements] = await Promise.all([
    context.supabase.from("permit_jurisdiction_profiles").select("review_days,portal_url").eq("org_id", context.orgId)
      .eq("company_id", companyId).maybeSingle(),
    context.supabase.from("permit_jurisdiction_requirements").select("permit_type,document_kind,label,required_for,sort_order")
      .eq("org_id", context.orgId).eq("company_id", companyId).order("permit_type").order("sort_order").limit(200),
  ])
  if (profile.error) throw new Error(`Unable to read the authority: ${profile.error.message}`)
  if (requirements.error) throw new Error(`Unable to read the authority's checklist: ${requirements.error.message}`)
  const row = z.object({ review_days: z.number().int(), portal_url: z.string().nullable() }).nullable().parse(profile.data)
  return {
    companyId,
    reviewDays: row?.review_days ?? 30,
    portalUrl: row?.portal_url ?? null,
    configured: Boolean(row),
    requirements: z.array(z.object({
      permit_type: z.enum(PERMIT_TYPES), document_kind: z.string(), label: z.string(), required_for: z.enum(["submission", "decision"]),
    })).parse(requirements.data ?? []).map((requirement) => ({
      permitType: requirement.permit_type, documentKind: requirement.document_kind, label: requirement.label, requiredFor: requirement.required_for,
    })),
  }
}

/** Companies that can stand as a permitting authority, one bounded page per search. */
export async function searchPermitAuthorities(query: { search: string; page?: number }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("permit.read", context)
  const page = Math.max(1, query.page ?? 1)
  let request = context.supabase.from("companies").select("id,name,address").eq("org_id", context.orgId).is("archived_at", null)
  const term = query.search.trim().replace(/[%_,()]/g, " ").trim()
  if (term) request = request.ilike("name", `%${term}%`)
  const { data, error } = await request.order("name").order("id")
    .range((page - 1) * AUTHORITY_PAGE_SIZE, page * AUTHORITY_PAGE_SIZE)
  if (error) throw new Error(`Unable to search authorities: ${error.message}`)
  const rows = z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.unknown() })).parse(data ?? [])
  const addressSchema = z.object({ city: z.string().optional(), state: z.string().optional() }).passthrough().nullable().catch(null)
  return {
    items: rows.slice(0, AUTHORITY_PAGE_SIZE).map((row) => {
      const address = addressSchema.parse(row.address)
      return { id: row.id, name: row.name, detail: [address?.city, address?.state].filter(Boolean).join(", ") }
    }),
    nextCursor: null,
    nextPage: rows.length > AUTHORITY_PAGE_SIZE ? page + 1 : null,
  }
}

/** A community's default permitting authority: what the start gate holds its homes' permits to. */
export async function setCommunityPermitAuthority(input: unknown, orgId?: string) {
  const parsed = setCommunityPermitAuthoritySchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  rpcError((await context.supabase.rpc("set_community_permit_authority", {
    p_org_id: context.orgId, p_community_id: parsed.communityId, p_company_id: parsed.companyId,
  })).error)
}

export async function getCommunityPermitAuthority(communityId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const { data, error } = await context.supabase.from("communities").select("permit_jurisdiction_company_id")
    .eq("org_id", context.orgId).eq("id", communityId).maybeSingle()
  if (error) throw new Error(`Unable to read the community: ${error.message}`)
  const id = z.string().uuid().nullable().parse(data?.permit_jurisdiction_company_id ?? null)
  if (!id) return null
  const names = await readCompanyNames(context.supabase, context.orgId, [id])
  return { id, name: names.get(id) ?? "Authority", detail: "" }
}

export interface PermitQueueRow {
  id: string
  projectId: string
  lotLabel: string
  communityName: string
  permitTypeLabel: string
  permitNumber: string | null
  stageLabel: string
  ownerName: string | null
  jurisdictionName: string
  aging: ReturnType<typeof permitAging>
  startTargetWeek: string | null
  href: string
}

/**
 * The Starts desk's permits band: applications the coordinator has to chase —
 * a decision past the authority's review clock, a response owed, or a
 * correction round still unresolved — inside the desk's ambient scope.
 */
export async function listPermitQueue(filters: { communityId?: string; divisionId?: string } = {}, orgId?: string) {
  const parsed = permitQueueFiltersSchema.parse(filters)
  const context = await requireOrgContext(orgId)
  await requirePermission("permit.read", context)
  const access = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (parsed.divisionId && access.assignedOnly && !access.divisionIds.includes(parsed.divisionId)) {
    return { rows: [] as PermitQueueRow[], total: 0, truncated: false }
  }
  // Each application is aged on its own home's date (the community's time zone);
  // the view says which are due for a chase.
  let query = context.supabase.from("permit_application_positions")
    .select("id,project_id,lot_id,permit_type,owner_user_id,permit_number,decision,expires_on,superseded_at,community_id,lot_number,block,community_name,submission_count,expected_decision_on,open_rounds,unresolved_rounds,next_round_due_on,start_target_week,jurisdiction_company_id,today_local", { count: "exact" })
    .eq("org_id", context.orgId).is("decision", null).is("superseded_at", null).gt("submission_count", 0)
    .eq("chase", true)
  if (parsed.communityId) query = query.eq("community_id", parsed.communityId)
  if (parsed.divisionId) query = query.eq("division_id", parsed.divisionId)
  const { data, error, count } = await query.order("expected_decision_on", { ascending: true }).order("id").limit(PERMIT_QUEUE_CAP)
  if (error) throw new Error(`Unable to read the permit queue: ${error.message}`)
  const rows = z.array(positionRow).parse(data ?? [])
  const [names, authorities, rounds] = await Promise.all([
    readNames(context.supabase, context.orgId),
    readCompanyNames(context.supabase, context.orgId, rows.map((row) => row.jurisdiction_company_id)),
    rows.length
      ? Promise.all(chunk(rows.map((row) => row.id), 100).map((batch) => context.supabase.from("permit_correction_rounds")
        .select("application_id,status,due_on").eq("org_id", context.orgId).in("application_id", batch).in("status", ["open", "responded"]).limit(2000)))
      : Promise.resolve([]),
  ])
  const roundError = rounds.find((result) => result.error)?.error
  if (roundError) throw new Error(`Unable to read correction rounds: ${roundError.message}`)
  const roundRows = rounds.flatMap((result) => z.array(z.object({
    application_id: z.string().uuid(), status: z.enum(ROUND_STATUSES), due_on: z.string().nullable(),
  })).parse(result.data ?? []))
  const people = new Map(names.map((member) => [member.id, member.name]))
  const candidates: PermitQueueRow[] = rows.map((row) => {
    const stage = permitApplicationStage({
      decision: row.decision, supersededAt: row.superseded_at, expiresOn: row.expires_on, submissionCount: row.submission_count, openRounds: row.open_rounds,
    }, row.today_local)
    return {
      id: row.id,
      projectId: row.project_id,
      lotLabel: row.lot_number ? (row.block ? `${row.block}-${row.lot_number}` : row.lot_number) : "Home",
      communityName: row.community_name ?? "Custom home",
      permitTypeLabel: PERMIT_TYPE_LABELS[row.permit_type],
      permitNumber: row.permit_number,
      stageLabel: PERMIT_STAGE_LABELS[stage],
      ownerName: row.owner_user_id ? people.get(row.owner_user_id) ?? "Former member" : null,
      jurisdictionName: authorities.get(row.jurisdiction_company_id) ?? "Authority",
      aging: permitAging({
        stage, expectedDecisionOn: row.expected_decision_on,
        rounds: roundRows.filter((round) => round.application_id === row.id).map((round) => ({ status: round.status, dueOn: round.due_on })),
      }, row.today_local),
      startTargetWeek: row.start_target_week,
      href: `/projects/${row.project_id}/permits?permit=${row.id}`,
    }
  })
  const total = count ?? rows.length
  return { rows: rankPermitQueue(candidates), total, truncated: total > rows.length }
}

const SWEEP_CAP = 2000

/**
 * The daily reminder sweep: a correction response coming due or late is
 * announced to the round's owner, and a decision past the authority's review
 * clock to the application's owner — once per threshold, marked on the row.
 * The mark is written before the event: a failed mark stops the run before
 * anything is announced, so a retry never sends the same reminder twice.
 */
export async function sweepPermitDeadlines(now: Date = new Date()) {
  const service = createServiceSupabaseClient()
  // The sweep reads each application on its own home's date; the window here
  // only has to be wide enough to hold every time zone's tomorrow.
  const reach = new Date(now.getTime() + 4 * 86_400_000).toISOString().slice(0, 10)
  const [rounds, positions] = await Promise.all([
    readAllRows((from, to) => service.from("permit_correction_rounds")
      .select("id,org_id,project_id,application_id,round_no,due_on,owner_user_id,metadata,application:permit_applications!inner(decision,superseded_at,permit_type)")
      .eq("status", "open").not("due_on", "is", null).lte("due_on", reach)
      .is("application.decision", null).is("application.superseded_at", null)
      .order("id").range(from, to), { cap: SWEEP_CAP, label: "Failed to load correction rounds coming due" }),
    readAllRows((from, to) => service.from("permit_application_positions")
      .select("id,org_id,project_id,permit_type,owner_user_id,submission_count,expected_decision_on,today_local")
      .eq("decision_overdue", true).order("id").range(from, to), { cap: SWEEP_CAP, label: "Failed to load overdue permit decisions" }),
  ])
  const roundRows = rounds.rows.map((raw) => z.object({
    id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), application_id: z.string().uuid(),
    round_no: z.number().int(), due_on: z.string(), owner_user_id: z.string().uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  }).parse(raw))
  const localDates = new Map<string, string>()
  for (const batch of chunk([...new Set(roundRows.map((row) => row.application_id))], 100)) {
    const { data, error } = await service.from("permit_application_positions").select("id,today_local").in("id", batch)
    if (error) throw new Error(`Failed to read permit dates: ${error.message}`)
    for (const row of z.array(z.object({ id: z.string().uuid(), today_local: z.string() })).parse(data ?? [])) localDates.set(row.id, row.today_local)
  }
  let corrections = 0
  for (const row of roundRows) {
    const today = localDates.get(row.application_id) ?? now.toISOString().slice(0, 10)
    const reminder = permitReminderDue(row.due_on, today, row.metadata)
    if (!reminder) continue
    const { error } = await service.rpc("mark_permit_reminder", {
      p_entity: "permit_correction_round", p_org_id: row.org_id, p_id: row.id, p_key: permitReminderKey(reminder), p_at: now.toISOString(),
    })
    if (error) throw new Error(`Failed to record the correction reminder: ${error.message}`)
    await recordEvent({ orgId: row.org_id, actorId: null, eventType: "permit_correction.due", entityType: "permit_correction_round", entityId: row.id,
      payload: { project_id: row.project_id, application_id: row.application_id, round_no: row.round_no, due_on: row.due_on,
        days_out: daysBetween(today, row.due_on), owner_user_id: row.owner_user_id } })
    corrections += 1
  }
  const overdueRows = positions.rows.map((raw) => z.object({
    id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), permit_type: z.enum(PERMIT_TYPES),
    owner_user_id: z.string().uuid().nullable(), submission_count: z.number().int(), expected_decision_on: z.string(), today_local: z.string(),
  }).parse(raw))
  const markers = new Map<string, Record<string, unknown>>()
  for (const batch of chunk(overdueRows.map((row) => row.id), 100)) {
    const { data, error } = await service.from("permit_applications").select("id,metadata").in("id", batch)
    if (error) throw new Error(`Failed to read permit reminders: ${error.message}`)
    for (const row of z.array(z.object({ id: z.string().uuid(), metadata: z.record(z.string(), z.unknown()) })).parse(data ?? [])) {
      markers.set(row.id, row.metadata)
    }
  }
  let decisions = 0
  for (const row of overdueRows) {
    const metadata = markers.get(row.id) ?? {}
    const scope = `decision_${row.submission_count}`
    if (permitReminderDue(row.expected_decision_on, row.today_local, metadata, scope) !== "overdue") continue
    const { error } = await service.rpc("mark_permit_reminder", {
      p_entity: "permit_application", p_org_id: row.org_id, p_id: row.id, p_key: permitReminderKey("overdue", scope), p_at: now.toISOString(),
    })
    if (error) throw new Error(`Failed to record the decision reminder: ${error.message}`)
    await recordEvent({ orgId: row.org_id, actorId: null, eventType: "permit_application.decision_overdue", entityType: "permit_application", entityId: row.id,
      payload: { project_id: row.project_id, permit_type: row.permit_type, expected_decision_on: row.expected_decision_on,
        days_overdue: daysBetween(row.expected_decision_on, row.today_local), owner_user_id: row.owner_user_id } })
    decisions += 1
  }
  return { corrections, decisions, truncated: rounds.truncated || positions.truncated }
}
