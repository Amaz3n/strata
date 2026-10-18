import "server-only";
import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/lib/services/context";
import { requirePrivatePayrollRead } from "@/lib/storage/payroll-private-storage";
import { payrollEvidenceFromRecord } from "./payroll-register-request";
import { reviewPayrollImport, withdrawPayrollImport } from "./payroll-imports";
import { payrollLiabilityHistory } from "./payroll-liability-history";
import { payrollWorkflowTablesSchema } from "./payroll-workflow-evidence";
const uuid = z.string().uuid().toLowerCase();
export const payrollDraftCursorSchema = z
  .object({ preparedAt: z.string().datetime({ offset: true }), id: uuid })
  .strict();
const metadataSchema = z.object({
  id: uuid,
  org_id: uuid,
  status: z.enum(["draft", "reviewed", "withdrawn"]),
  provider: z.string(),
  provider_run_id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  prepared_at: z.string(),
  prepared_by: uuid,
  preparation_notes: z.string(),
  reviewed_by: uuid.nullable(),
  reviewed_at: z.string().nullable(),
  review_notes: z.string().nullable(),
  withdrawn_by: uuid.nullable(),
  withdrawn_at: z.string().nullable(),
  withdrawal_reason: z.string().nullable(),
});
async function read(projectId: string, importId?: string, cursor?: unknown) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const project = uuid.parse(projectId),
    id = importId === undefined ? null : uuid.parse(importId),
    before = cursor == null ? null : payrollDraftCursorSchema.parse(cursor);
  const r = await createServiceSupabaseClient().rpc(
    "read_books_project_payroll_drafts",
    {
      p_org_id: c.orgId,
      p_project_id: project,
      p_import_id: id,
      p_before_time: before?.preparedAt ?? null,
      p_before_id: before?.id ?? null,
      p_limit: 50,
    },
  );
  if (r.error)
    throw new Error(`Payroll drafts could not load: ${r.error.message}`);
  const page = z
    .object({
      orgId: z.literal(c.orgId),
      projectId: z.literal(project),
      projectName: z.string(),
      projects: z.array(
        z.object({ id: uuid, org_id: z.literal(c.orgId), name: z.string() }),
      ),
      costCodes: z.array(
        z.object({ id: uuid, org_id: z.literal(c.orgId), name: z.string() }),
      ),
      imports: z.array(z.record(z.unknown())).max(50),
      nextCursor: payrollDraftCursorSchema.nullable(),
    })
    .parse(r.data);
  const imports = page.imports.map((row) => {
    const metadata = metadataSchema.parse(row),
      evidence = payrollEvidenceFromRecord(row);
    if (
      metadata.org_id !== c.orgId ||
      evidence.run.org_id !== c.orgId ||
      metadata.id !== evidence.run.id ||
      metadata.provider !== evidence.run.provider ||
      metadata.provider_run_id !== evidence.run.provider_run_id ||
      metadata.period_start !== evidence.run.period_start ||
      metadata.period_end !== evidence.run.period_end
    )
      throw new Error("Payroll draft identity differs from frozen evidence");
    const projects = evidence.run.employees
      .flatMap((w) => w.allocations.map((a) => a.project_id))
      .filter(Boolean);
    if (projects.length && !projects.includes(project))
      throw new Error("Payroll draft does not affect this project");
    return { metadata, evidence, overheadOnly: projects.length === 0 };
  });
  if (
    new Set(imports.map((r) => r.metadata.id)).size !== imports.length ||
    (id && (imports.length !== 1 || imports[0].metadata.id !== id))
  )
    throw new Error("Payroll draft page identity differs");
  return { c, page, imports };
}
function summary(row: Awaited<ReturnType<typeof read>>["imports"][number]) {
  return {
    id: row.metadata.id,
    provider: row.metadata.provider,
    runReference: row.metadata.provider_run_id,
    status: row.metadata.status,
    periodStart: row.metadata.period_start,
    periodEnd: row.metadata.period_end,
    preparedAt: row.metadata.prepared_at,
    overheadOnly: row.overheadOnly,
    grossCents: row.evidence.run.controls.gross_cents,
    fundingCents: row.evidence.run.controls.funding_cents,
  };
}
export async function getProjectPayrollDrafts(
  projectId: string,
  cursor?: unknown,
) {
  const result = await read(projectId, undefined, cursor);
  return {
    projectId: result.page.projectId,
    projectName: result.page.projectName,
    drafts: result.imports.map(summary),
    nextCursor: result.page.nextCursor,
  };
}
export async function getProjectPayrollDraftDetail(input: {
  projectId: string;
  importId: string;
}) {
  const result = await read(input.projectId, input.importId),
    row = result.imports[0],
    e = row.evidence;
  return {
    ...summary(row),
    projectId: result.page.projectId,
    preparationNotes: row.metadata.preparation_notes,
    preparedBy: row.metadata.prepared_by,
    reviewedBy: row.metadata.reviewed_by,
    reviewNotes: row.metadata.review_notes,
    withdrawalReason: row.metadata.withdrawal_reason,
    canReview:
      row.metadata.status === "draft" &&
      row.metadata.prepared_by !== result.c.userId,
    canWithdraw: row.metadata.status !== "withdrawn",
    source: {
      fileId: e.source_proof.file_id,
      documentVersionId: e.source_proof.document_version_id,
      fileName: e.source_proof.file_name,
      checksum: e.source_proof.checksum,
    },
    controls: e.run.controls,
    employees: e.run.employees,
    reconciliation: z
      .object({
        recognizedGrossCents: z.number().int().safe(),
        estimatedBurdenCents: z.number().int().safe(),
        wageVarianceCents: z.number().int().safe(),
        burdenVarianceCents: z.number().int().safe(),
        costVarianceCents: z.number().int().safe(),
      })
      .parse(e.reconciliation),
    workflowPresent: e.reconciliation.evidenceVersion === 2,
    liabilities:
      e.reconciliation.evidenceVersion === 2
        ? (() => {
            const history = payrollLiabilityHistory(
              e.run.org_id,
              z
                .object({ sourceTables: payrollWorkflowTablesSchema })
                .parse(e.reconciliation.workflowEvidence).sourceTables,
            );
            return {
              unpaidStatusProven: false as const,
              movements: history.movements.map((row) => ({
                journal: {
                  id: row.journal.id,
                  entry_date: row.journal.entry_date,
                  status: row.journal.status,
                },
                wagesMovementCents: row.wagesMovementCents,
                deductionsMovementCents: row.deductionsMovementCents,
                lines: row.lines.map((line) => ({
                  id: line.id,
                  accountCode: line.accountCode,
                  project_id: line.project_id ?? null,
                  debit_cents: line.debit_cents,
                  credit_cents: line.credit_cents,
                  classificationSource: line.classificationSource,
                })),
              })),
            };
          })()
        : null,
    projects: result.page.projects,
    costCodes: result.page.costCodes,
    labor: e.labor_evidence.map((row) => ({
      id: row.id,
      workerId: row.worker_id,
      date: row.incurred_on,
      grossCents: row.gross_cents,
      burdenCents: row.estimated_burden_cents,
      journalId: row.journal_id,
    })),
  };
}
export async function reviewProjectPayrollDraft(input: {
  projectId: string;
  importId: string;
  notes: string;
}) {
  await read(input.projectId, input.importId);
  return reviewPayrollImport({ id: input.importId, notes: input.notes });
}
export async function withdrawProjectPayrollDraft(input: {
  projectId: string;
  importId: string;
  reason: string;
}) {
  await read(input.projectId, input.importId);
  return withdrawPayrollImport({ id: input.importId, reason: input.reason });
}

/** Immutable project relationship remains available for exact request recovery
 * after posting or withdrawal; it grants no new review or posting transition. */
export async function requireProjectPayrollImportScope(
  projectId: string,
  importId: string,
) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const project = uuid.parse(projectId),
    id = uuid.parse(importId),
    service = createServiceSupabaseClient();
  const p = await service
    .from("projects")
    .select("id,org_id")
    .eq("org_id", c.orgId)
    .eq("id", project)
    .single();
  if (p.error || !p.data || p.data.org_id !== c.orgId || p.data.id !== project)
    throw Error("Project is unavailable in this organization");
  const row = await service
    .from("books_payroll_imports")
    .select("*")
    .eq("org_id", c.orgId)
    .eq("id", id)
    .single();
  if (
    row.error ||
    !row.data ||
    row.data.org_id !== c.orgId ||
    row.data.id !== id
  )
    throw Error("Payroll import is unavailable in this organization");
  const evidence = payrollEvidenceFromRecord(row.data);
  if (evidence.run.org_id !== c.orgId || evidence.run.id !== id)
    throw Error("Payroll import identity differs");
  const projects = evidence.run.employees
    .flatMap((w) => w.allocations.map((a) => a.project_id))
    .filter(Boolean);
  if (projects.length && !projects.includes(project))
    throw Error("Payroll import does not affect this project");
  return id;
}
