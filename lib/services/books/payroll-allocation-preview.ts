import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requirePrivatePayrollRead } from "@/lib/storage/payroll-private-storage";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  payrollRegisterRequestSchema,
  canonicalPayrollRegisterRequest,
} from "./payroll-register-request";
import { previewPayrollWorkerLabor } from "./payroll-worker-labor";
import {
  currentPayrollImportEvidence,
  preparePayrollImport,
} from "./payroll-imports";
import { reconcilePayrollImport } from "./payroll-import-rules";
import {
  payrollWorkflowEvidence,
  payrollWorkflowTablesSchema,
} from "./payroll-workflow-evidence";
import { booksDigest } from "./hash";
const uuid = z.string().uuid().toLowerCase();
const schema = z
  .object({ projectId: uuid, register: payrollRegisterRequestSchema })
  .strict();

/** Re-read the original provider source and native accounting proof. Client
 * allocation choices cannot supply accounting evidence, journals or controls. */
export async function previewProjectPayrollAllocation(input: unknown) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const args = schema.parse(input),
    register = canonicalPayrollRegisterRequest(args.register);
  const choices = await previewPayrollWorkerLabor({
    projectId: args.projectId,
    fileId: register.fileId,
    documentVersionId: register.documentVersionId,
    mapping: register.mapping,
    workers: register.workers.map((worker) => ({
      employee_reference: worker.employee_reference,
      worker_id: worker.worker_id,
    })),
  });
  if (
    choices.ownedNativeLabor.some(
      (owner) => owner.payrollImportId !== register.runId,
    )
  )
    throw new Error(
      "Native labor already belongs to another payroll register; use its correction workflow",
    );
  for (const worker of register.workers)
    for (const allocation of worker.allocations) {
      if (
        (allocation.project_id &&
          !choices.projects.some(
            (project) => project.id === allocation.project_id,
          )) ||
        (allocation.cost_code_id &&
          !choices.costCodes.some(
            (code) => code.id === allocation.cost_code_id,
          )) ||
        !choices.accounts.some(
          (account) => account.code === allocation.cost_account_code,
        )
      )
        throw new Error(
          "Payroll allocation dimension or account is unavailable in this organization",
        );
    }
  const evidence = await currentPayrollImportEvidence(c.orgId, register);
  const accounts = z
    .array(
      z.object({
        org_id: z.string(),
        code: z.string(),
        account_type: z.string(),
        subtype: z.string(),
        active: z.boolean(),
      }),
    )
    .parse(evidence.reconciliation.postingAccounts);
  const result = reconcilePayrollImport(
    evidence.run,
    evidence.labor_evidence,
    accounts,
  );
  const workflow = z
    .object({
      version: z.literal(1),
      sourceTables: payrollWorkflowTablesSchema,
    })
    .passthrough()
    .parse(evidence.reconciliation.workflowEvidence);
  const impact = payrollWorkflowEvidence(
    result,
    evidence.labor_evidence,
    workflow.sourceTables,
  );
  return {
    evidenceDigest: booksDigest(evidence),
    runId: register.runId,
    recognizedGrossCents: result.recognizedGrossCents,
    estimatedBurdenCents: result.estimatedBurdenCents,
    wageVarianceCents: result.wageVarianceCents,
    costVarianceCents: result.costVarianceCents,
    variances: result.variances,
    construction: impact.constructionImpact,
    liabilities: impact.liabilityHistory,
  };
}

/** Exact request retries use the existing preparation recovery contract. New
 * writes must match the preview; this creates only an unapproved draft. */
export async function prepareProjectPayrollAllocation(input: unknown) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const args = schema
    .extend({
      notes: z.string().trim().min(10).max(4000),
      idempotencyKey: z.string().trim().min(10).max(200),
      expectedEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(input);
  const project = await createServiceSupabaseClient()
    .from("projects")
    .select("id,org_id")
    .eq("org_id", c.orgId)
    .eq("id", args.projectId)
    .single();
  if (project.error || !project.data || project.data.org_id !== c.orgId)
    throw new Error("Project is unavailable in this organization");
  return preparePayrollImport({
    register: args.register,
    notes: args.notes,
    idempotencyKey: args.idempotencyKey,
    expectedEvidenceDigest: args.expectedEvidenceDigest,
  });
}
