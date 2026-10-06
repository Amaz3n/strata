import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requirePrivatePayrollRead } from "@/lib/storage/payroll-private-storage";
import { inspectProjectPrivatePayrollUpload } from "./payroll-documents";
import { payrollNativeLaborSelection } from "./payroll-labor-snapshot";
import { payrollCsvMappingSchema } from "./payroll-register-csv";

const uuid = z.string().uuid().toLowerCase();
const schema = z
  .object({
    projectId: uuid,
    fileId: uuid,
    documentVersionId: uuid,
    mapping: payrollCsvMappingSchema,
    workers: z
      .array(
        z
          .object({
            employee_reference: z.string().trim().min(1).max(200),
            worker_id: uuid,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Proves original native wages before allocation. No provider cents, labor IDs
 * or fictional allocations are supplied to discover already-recognized cost. */
export async function previewPayrollWorkerLabor(input: unknown) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const args = schema.parse(input);
  const source = await inspectProjectPrivatePayrollUpload(args);
  if (!source.register)
    throw new Error("Verified provider mapping is required");
  const ids = args.workers.map((worker) => worker.worker_id),
    references = args.workers.map((worker) => worker.employee_reference);
  if (
    new Set(ids).size !== ids.length ||
    new Set(references).size !== references.length ||
    source.register.employees.length !== references.length ||
    source.register.employees.some(
      (employee) => !references.includes(employee.employee_reference),
    )
  )
    throw new Error(
      "Map every provider employee to one distinct native worker",
    );
  const service = createServiceSupabaseClient();
  for (let start = 0; start < ids.length; start += 200) {
    const batch = ids.slice(start, start + 200);
    const r = await service
      .from("memberships")
      .select("org_id,user_id")
      .eq("org_id", c.orgId)
      .in("user_id", batch)
      .limit(1000);
    if (
      r.error ||
      !r.data ||
      r.data.some((row) => row.org_id !== c.orgId) ||
      batch.some((id) => !r.data.some((row) => row.user_id === id))
    )
      throw new Error("Payroll worker is unavailable in this organization");
  }
  const r = await service.rpc("capture_books_export_snapshot", {
    p_org_id: c.orgId,
  });
  if (r.error) throw new Error("Native payroll labor could not be captured");
  const selected = payrollNativeLaborSelection(
    c.orgId,
    {
      workerIds: ids,
      periodStart: source.register.period_start,
      periodEnd: source.register.period_end,
    },
    r.data,
  );
  const ownership = selected.snapshot.tables.books_payroll_labor_ownership;
  const postings = selected.snapshot.tables.books_payroll_postings;
  if (
    !ownership ||
    !postings ||
    [...ownership, ...postings].some((row) => row.org_id !== c.orgId)
  )
    throw new Error("Native payroll ownership evidence is unavailable");
  const ownedNativeLabor = ownership
    .filter((row) =>
      selected.labor.some((labor) => labor.id === row.job_cost_entry_id),
    )
    .map((row) => {
      const posting = postings.filter(
        (posting) => posting.id === row.posting_id,
      );
      if (posting.length !== 1)
        throw new Error(
          "Native payroll ownership has no unique original register posting",
        );
      return {
        jobCostId: uuid.parse(row.job_cost_entry_id),
        postingId: uuid.parse(row.posting_id),
        payrollImportId: uuid.parse(posting[0].payroll_import_id),
      };
    });
  const dimensions = (name: "projects" | "cost_codes") => {
    const rows = selected.snapshot.tables[name];
    if (!rows || rows.some((row) => row.org_id !== c.orgId))
      throw new Error("Payroll construction dimensions are unavailable");
    return rows.map((row) => ({
      id: uuid.parse(row.id),
      label: String(
        row.name ??
          row.code ??
          (name === "projects" ? "Unnamed project" : "Cost code"),
      ),
    }));
  };
  return {
    document: source.document,
    register: source.register,
    workers: args.workers,
    labor: selected.labor,
    ownedNativeLabor,
    capturedAt: selected.snapshot.capturedAt,
    projects: dimensions("projects"),
    costCodes: dimensions("cost_codes"),
    accounts: selected.chart
      .filter(
        (account) =>
          account.active &&
          (["cogs", "expense"].includes(account.account_type) ||
            (account.account_type === "asset" &&
              account.subtype === "work_in_progress")),
      )
      .map((account) => ({
        id: account.id,
        code: account.code,
        subtype: account.subtype,
      })),
  };
}

export async function readProjectPayrollWorkers(input: {
  projectId: string;
  cursor?: string | null;
  search?: string;
}) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const args = z
    .object({
      projectId: uuid,
      cursor: uuid.nullable().optional(),
      search: z.string().max(200).optional(),
    })
    .strict()
    .parse(input);
  const service = createServiceSupabaseClient();
  const project = await service
    .from("projects")
    .select("id,org_id")
    .eq("org_id", c.orgId)
    .eq("id", args.projectId)
    .single();
  if (project.error || !project.data || project.data.org_id !== c.orgId)
    throw new Error("Project is unavailable in this organization");
  const r = await service.rpc("read_books_payroll_workers", {
    p_org_id: c.orgId,
    p_after: args.cursor ?? null,
    p_search: args.search ?? "",
    p_limit: 50,
  });
  if (r.error) throw new Error("Native payroll workers could not be read");
  return z
    .object({
      workers: z
        .array(
          z
            .object({
              id: uuid,
              name: z.string().min(1),
              email: z.string().email(),
              statuses: z.array(z.string()).min(1),
            })
            .strict(),
        )
        .max(50),
      nextCursor: uuid.nullable(),
    })
    .strict()
    .parse(r.data);
}
