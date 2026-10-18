import "server-only";
import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksAuthorization } from "./access";
import { requireBooksWorkspaceEnabled } from "./module";
import { verifyPayrollPostingReceipt } from "./payroll-posting-receipt";
import { parsePayrollCorrectionSource } from "./payroll-correction-source";
import { parsePayrollCorrectionProposalEvidence } from "./payroll-correction-proposal";
import { verifyPayrollCorrectionPosting } from "./payroll-correction-posting";
import { getPayrollCorrectionContext } from "./payroll-corrections";
import { booksDigest } from "./hash";

const uuid = z.string().uuid().toLowerCase();
type Tables = Record<string, Record<string, unknown>[]>;
async function access() {
  const c = await requireOrgContext();
  await requireBooksAuthorization({
    permission: "books.adjust",
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "payroll_import",
    resourceId: c.orgId,
    logDecision: true,
  });
  await requireBooksWorkspaceEnabled(c.orgId);
  return c;
}
export const payrollWorkspaceCursorSchema = z
  .object({
    preparedAt: z.string().datetime({ offset: true }),
    id: uuid,
  })
  .strict();
async function snapshot(
  orgId: string,
  projectId: string,
  sourceId?: string,
  cursor?: unknown,
) {
  const before =
    cursor == null ? null : payrollWorkspaceCursorSchema.parse(cursor);
  const r = await createServiceSupabaseClient().rpc(
    "capture_books_payroll_workspace_snapshot",
    {
      p_org_id: orgId,
      p_project_id: projectId,
      p_source_id: sourceId ?? null,
      p_before_time: before?.preparedAt ?? null,
      p_before_id: before?.id ?? null,
      p_limit: 50,
    },
  );
  if (r.error)
    throw new Error(`Payroll review could not load: ${r.error.message}`);
  const result = z
    .object({
      orgId: z.literal(orgId),
      projectId: z.literal(projectId),
      projectName: z.string(),
      sourceIds: z.array(uuid).max(50),
      nextCursor: payrollWorkspaceCursorSchema.nullable(),
      tables: z.record(z.array(z.record(z.unknown()))),
    })
    .parse(r.data);
  if (
    new Set(result.sourceIds).size !== result.sourceIds.length ||
    (sourceId &&
      (result.sourceIds.length !== 1 || result.sourceIds[0] !== sourceId))
  )
    throw new Error("Payroll review source page identity differs");
  return result;
}

const touches = (run: unknown, projectId: string) =>
  z
    .object({
      employees: z.array(
        z.object({
          allocations: z.array(z.object({ project_id: uuid.nullable() })),
        }),
      ),
    })
    .parse(run)
    .employees.some((worker) =>
      worker.allocations.some(
        (allocation) => allocation.project_id === projectId,
      ),
    );
function scopedSource(
  tables: Tables,
  orgId: string,
  projectId: string,
  sourceId: string,
) {
  const project = tables.projects.filter(
    (row) => row.org_id === orgId && row.id === projectId,
  );
  if (project.length !== 1)
    throw new Error("Project is unavailable in this organization");
  const source = parsePayrollCorrectionSource(
    tables.books_payroll_correction_sources.find(
      (row) => row.org_id === orgId && row.id === sourceId,
    ),
    tables,
  );
  const root = verifyPayrollPostingReceipt(
    tables.books_payroll_postings.find(
      (row) => row.org_id === orgId && row.id === source.posting_id,
    ),
    tables,
    { requireNativeOwnership: true },
  );
  const parent = tables.books_payroll_imports.find(
    (row) => row.id === root.payroll_import_id && row.org_id === orgId,
  )!;
  const history = tables.books_payroll_correction_sources.filter(
    (row) => row.org_id === orgId && row.posting_id === root.id,
  );
  if (
    !touches(parent.run, projectId) &&
    !history.some((row) => touches(row.run, projectId))
  )
    throw new Error("Payroll correction does not affect this project");
  return { source, root, parent, project: project[0] };
}

/** No private snapshot or payroll table read occurs before whole-org authorization. */
export async function getProjectPayrollCorrectionWorkspace(
  projectId: string,
  cursor?: unknown,
) {
  const c = await access(),
    id = uuid.parse(projectId),
    captured = await snapshot(c.orgId, id, undefined, cursor),
    tables = captured.tables;
  const projects = tables.projects.filter(
    (row) => row.org_id === c.orgId && row.id === id,
  );
  if (projects.length !== 1)
    throw new Error("Project is unavailable in this organization");
  const sources = captured.sourceIds
    .map((sourceId) => {
      const matches = tables.books_payroll_correction_sources.filter(
        (row) => row.org_id === c.orgId && row.id === sourceId,
      );
      if (matches.length !== 1)
        throw new Error("Payroll review page source is missing or ambiguous");
      return matches[0];
    })
    .map((row) => {
      const { source } = scopedSource(tables, c.orgId, id, String(row.id));
      const receipts = tables.books_payroll_correction_postings.filter(
        (p) => p.org_id === c.orgId && p.source_id === source.id,
      );
      if (receipts.length > 1)
        throw new Error("Payroll correction has ambiguous posting ownership");
      const receipt = receipts[0]
        ? verifyPayrollCorrectionPosting(receipts[0], tables)
        : null;
      return {
        id: source.id,
        provider: source.run.provider,
        runReference: source.run.provider_run_id,
        periodStart: source.run.period_start,
        periodEnd: source.run.period_end,
        accountingDate: source.request.accountingDate,
        revision: source.revision,
        status: receipt ? ("posted" as const) : source.status,
        reason: source.request.reason,
        postedAt: receipt?.posted_at ?? null,
      };
    });
  return {
    projectId: id,
    projectName: String(projects[0].name ?? "Project"),
    sources,
    nextCursor: captured.nextCursor,
  };
}

export async function getProjectPayrollCorrectionDetail(input: {
  projectId: string;
  sourceId: string;
}) {
  const c = await access(),
    projectId = uuid.parse(input.projectId),
    sourceId = uuid.parse(input.sourceId),
    tables = (await snapshot(c.orgId, projectId, sourceId)).tables;
  const { source, root, parent } = scopedSource(
    tables,
    c.orgId,
    projectId,
    sourceId,
  );
  const original = tables.books_payroll_posting_proposals.find(
      (row) => row.org_id === c.orgId && row.id === root.proposal_id,
    )!,
    payment = tables.books_payroll_payment_reviews.find(
      (row) => row.org_id === c.orgId && row.id === original.payment_review_id,
    );
  const preparers = [
    source.prepared_by,
    parent.prepared_by,
    original.prepared_by,
    payment?.prepared_by,
  ];
  const proposals = tables.books_payroll_correction_proposals
    .filter((row) => row.org_id === c.orgId && row.source_id === sourceId)
    .map((row) => parsePayrollCorrectionProposalEvidence(row, tables));
  const active = proposals.filter(
    (p) => p.row.status !== "withdrawn" && p.row.posted_receipt_id === null,
  );
  if (active.length > 1)
    throw new Error("Payroll correction has ambiguous active monetary review");
  const receipts = tables.books_payroll_correction_postings
    .filter((row) => row.org_id === c.orgId && row.source_id === sourceId)
    .map((row) => verifyPayrollCorrectionPosting(row, tables));
  if (receipts.length > 1)
    throw new Error("Payroll correction has ambiguous posting ownership");
  const receipt = receipts[0] ?? null,
    proposal = receipt
      ? proposals.find((p) => p.row.id === receipt.proposal_id)
      : active[0];
  let current: Awaited<ReturnType<typeof getPayrollCorrectionContext>> | null =
      null,
    currentError: string | null = null;
  if (source.status === "reviewed" && !receipt) {
    try {
      current = await getPayrollCorrectionContext({ id: sourceId });
    } catch (error) {
      currentError =
        error instanceof Error
          ? error.message
          : "Current payroll evidence could not be verified";
    }
  }
  if (current && proposal) {
    const { preflightOnly: _preview, ...fresh } = current;
    void _preview;
    if (booksDigest(fresh) !== booksDigest(proposal.row.plan))
      currentError =
        "The evidence has changed. Withdraw this proposal and prepare a new review.";
  }
  const reservation = tables.books_payroll_correction_proposals.find(
    (row) =>
      row.org_id === c.orgId &&
      row.posting_id === root.id &&
      row.source_id !== sourceId &&
      row.status !== "withdrawn" &&
      row.posted_receipt_id == null,
  );
  if (current && reservation)
    currentError =
      "Another correction for this payroll run already has a monetary proposal. Finish or withdraw that proposal first.";
  const plan = receipt ? proposal?.plan : current;
  const costs = (plan?.projectCosts ?? []).map((row) => ({
    workerId: String(row.workerId),
    allocationId: String(row.allocationId),
    projectId: String(row.projectId),
    costCodeId: row.costCodeId == null ? null : String(row.costCodeId),
    accountId: String(row.accountId),
    accountCode: String(row.accountCode),
    costCodeLabel: String(
      tables.cost_codes.find(
        (code) => code.org_id === c.orgId && code.id === row.costCodeId,
      )?.name ?? "Uncoded",
    ),
    component: String(row.component),
    costCents: Number(row.costCents),
    budgetLineId: row.budgetLineId == null ? null : String(row.budgetLineId),
    gmpClassification:
      row.gmpClassification == null ? null : String(row.gmpClassification),
    blockers: z.array(z.string()).parse(row.blockers),
    projectName: String(
      tables.projects.find(
        (p) => p.id === row.projectId && p.org_id === c.orgId,
      )?.name ?? row.projectId,
    ),
    workerReference:
      source.run.employees.find((worker) => worker.worker_id === row.workerId)
        ?.employee_reference ?? String(row.workerId),
  }));
  const budgetLines = tables.budget_lines
    .filter(
      (line) =>
        line.org_id === c.orgId &&
        costs.some(
          (cost) =>
            cost.projectId ===
              tables.budgets.find(
                (b) => b.id === line.budget_id && b.org_id === c.orgId,
              )?.project_id && cost.costCodeId === (line.cost_code_id ?? null),
        ),
    )
    .map((line) => ({
      id: String(line.id),
      projectId: String(
        tables.budgets.find(
          (b) => b.id === line.budget_id && b.org_id === c.orgId,
        )!.project_id,
      ),
      costCodeId: line.cost_code_id == null ? null : String(line.cost_code_id),
      label: String(
        line.description ??
          line.name ??
          tables.cost_codes.find(
            (code) => code.id === line.cost_code_id && code.org_id === c.orgId,
          )?.name ??
          line.id,
      ),
    }));
  return {
    projectId,
    sourceId,
    provider: source.run.provider,
    runReference: source.run.provider_run_id,
    sourceStatus: source.status,
    reason: source.request.reason,
    accountingDate: source.request.accountingDate,
    sourceFileName: source.source_proof.file_name,
    sourceFileId: source.source_proof.file_id,
    sourceDocumentVersionId: source.source_proof.document_version_id,
    registerTotals: source.run.controls,
    workers: source.run.employees.map((worker) => ({
      id: worker.worker_id,
      reference: worker.employee_reference,
      grossCents: worker.gross_cents,
      netCents: worker.net_cents,
      employeeTaxesCents: worker.employee_taxes_cents,
      employeeDeductionsCents: worker.employee_deductions_cents,
      employerTaxesCents: worker.employer_taxes_cents,
      employerBenefitsCents: worker.employer_benefits_cents,
      allocations: worker.allocations.map((a) => ({
        id: a.id,
        projectId: a.project_id,
        projectName: a.project_id
          ? String(
              tables.projects.find(
                (p) => p.org_id === c.orgId && p.id === a.project_id,
              )?.name ?? a.project_id,
            )
          : "Overhead",
        costCodeId: a.cost_code_id,
        grossCents: a.gross_cents,
        employerTaxesCents: a.employer_taxes_cents,
        employerBenefitsCents: a.employer_benefits_cents,
        accountCode: a.cost_account_code,
      })),
    })),
    sourceReviewedBy: source.reviewed_by,
    sourceReviewedAt: source.reviewed_at,
    sourceReviewNotes: source.review_notes,
    ready:
      !!current &&
      !currentError &&
      current.blockers.length === 0 &&
      !current.requiresConstructionReview,
    canReviewSource: source.status === "draft" && !preparers.includes(c.userId),
    currentError,
    costs,
    budgetLines,
    blockers: plan?.blockers ?? [],
    costDeltaCents: plan?.math.costDeltaCents ?? null,
    remainingNetPayCents:
      plan?.remainingBeforeAdditionalAttribution.netPayCents ?? null,
    proposal: proposal
      ? {
          id: proposal.row.id,
          status: proposal.row.status,
          digest: proposal.row.plan_digest,
          preparedBy: proposal.row.prepared_by,
          reviewedBy: proposal.row.reviewed_by,
          preparationNotes: proposal.row.preparation_notes,
          reviewNotes: proposal.row.review_notes,
          constructionDecisions: proposal.plan.constructionDecisions ?? null,
          canReview:
            !receipt &&
            proposal.row.status === "draft" &&
            ![...preparers, proposal.row.prepared_by].includes(c.userId),
        }
      : null,
    reviewHistory: proposals.map(({ row }) => ({
      id: row.id,
      status: row.status,
      preparedAt: row.prepared_at,
      reviewedAt: row.reviewed_at,
      preparationNotes: row.preparation_notes,
      reviewNotes: row.review_notes,
      withdrawalReason: row.withdrawal_reason,
    })),
    receipt: receipt
      ? {
          id: receipt.id,
          sequence: receipt.sequence,
          postedAt: receipt.posted_at,
          postedBy: receipt.posted_by,
          notes: receipt.posting_notes,
          journalId: receipt.result.journalId,
        }
      : null,
  };
}
export async function requireProjectPayrollCorrectionSource(
  projectId: string,
  sourceId: string,
) {
  const c = await access();
  scopedSource(
    (await snapshot(c.orgId, uuid.parse(projectId), uuid.parse(sourceId)))
      .tables,
    c.orgId,
    uuid.parse(projectId),
    uuid.parse(sourceId),
  );
}
export async function requireProjectPayrollCorrectionProposal(
  projectId: string,
  proposalId: string,
) {
  const c = await access(),
    id = uuid.parse(proposalId);
  const saved = await createServiceSupabaseClient()
    .from("books_payroll_correction_proposals")
    .select("source_id")
    .eq("org_id", c.orgId)
    .eq("id", id)
    .single();
  if (saved.error || !saved.data)
    throw new Error("Payroll proposal is unavailable in this organization");
  const sourceId = uuid.parse(saved.data.source_id),
    tables = (await snapshot(c.orgId, uuid.parse(projectId), sourceId)).tables;
  const { row } = parsePayrollCorrectionProposalEvidence(
    tables.books_payroll_correction_proposals.find(
      (p) => p.org_id === c.orgId && p.id === id,
    ),
    tables,
  );
  scopedSource(tables, c.orgId, uuid.parse(projectId), row.source_id);
  return row.source_id;
}
export type PayrollCorrectionWorkspace = Awaited<
  ReturnType<typeof getProjectPayrollCorrectionWorkspace>
>;
export type PayrollCorrectionDetail = Awaited<
  ReturnType<typeof getProjectPayrollCorrectionDetail>
>;
