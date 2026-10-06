import { z } from "zod";
import { booksDigest } from "./hash";
import {
  economicLaborBasis,
  laborBasisFromJobCost,
  laborBasisSchema,
} from "./labor-evidence";
import {
  payrollImportSchema,
  payrollLaborEvidenceSchema,
  reconcilePayrollImport,
} from "./payroll-import-rules";
import { resolveBooksPostingState, timestampMicros } from "./posting-state";
import { payrollConstructionImpact } from "./payroll-construction-impact";
import { payrollLiabilityHistory } from "./payroll-liability-history";
import { payrollWorkflowEvidence } from "./payroll-workflow-evidence";

const row = z.record(z.unknown());
const snapshotSchema = z.object({
  orgId: z.string().uuid(),
  capturedAt: z.string().datetime({ offset: true }),
  databaseSnapshot: z.string().min(1),
  tables: z.record(z.array(row)),
});
const chartSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  code: z.string().min(1),
  account_type: z.string(),
  subtype: z.string(),
  active: z.boolean(),
});
const classificationSchema = z.object({
  version: z.literal(1),
  account_id: z.string().uuid(),
  code: z.string().min(1),
  account_type: z.string(),
  subtype: z.string(),
  legacy_unknown: z.literal(false).optional(),
});
const lineSchema = z.object({
  entry_id: z.string().uuid(),
  account_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  debit_cents: z.number().int().safe().nonnegative(),
  credit_cents: z.number().int().safe().nonnegative(),
  dimensions: row,
});
const approvedTime = new Set(["pm_approved", "client_approved", "locked"]);
function indexed(records: Record<string, unknown>[], label: string) {
  const result = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const id = z.string().uuid().parse(record.id);
    if (result.has(id)) throw new Error(`Duplicate payroll snapshot ${label}`);
    result.set(id, record);
  }
  return result;
}
function bySource(records: Record<string, unknown>[]) {
  const result = new Map<string, Record<string, unknown>[]>();
  for (const record of records)
    if (record.source_type === "labor_cost") {
      const key = String(record.source_id),
        list = result.get(key) ?? [];
      list.push(record);
      result.set(key, list);
    }
  return result;
}

/** A preview only. Frozen wage decomposition supplies amounts; operational rows
 * prove completeness and freshness, never fill missing historical evidence.
 * Revised/reversed labor needs reviewed historical attribution before import.
 */
export function payrollNativeLaborSelection(
  orgId: string,
  selectionInput: unknown,
  snapshotInput: unknown,
) {
  const selection = z
      .object({
        workerIds: z.array(z.string().uuid().toLowerCase()).min(1),
        periodStart: z.string().date(),
        periodEnd: z.string().date(),
      })
      .strict()
      .parse(selectionInput),
    snapshot = snapshotSchema.parse(snapshotInput);
  if (snapshot.orgId !== orgId)
    throw new Error("Payroll snapshot organization mismatch");
  if (
    selection.periodStart > selection.periodEnd ||
    new Set(selection.workerIds).size !== selection.workerIds.length
  )
    throw new Error("Invalid payroll worker selection or period");
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of [
    "time_entries",
    "job_cost_entries",
    "accounting_facts",
    "journal_entries",
    "journal_lines",
    "books_projection_receipts",
    "gl_accounts",
  ]) {
    const records = snapshot.tables[name];
    if (!records) throw new Error(`Payroll snapshot is missing ${name}`);
    if (records.some((record) => record.org_id !== orgId))
      throw new Error(
        `Payroll snapshot has foreign organization rows in ${name}`,
      );
    tables[name] = records;
  }
  const workers = new Set(selection.workerIds);
  const inPeriod = (value: unknown) =>
    typeof value === "string" &&
    value >= selection.periodStart &&
    value <= selection.periodEnd;
  const times = indexed(tables.time_entries, "time entry"),
    costs = indexed(tables.job_cost_entries, "job cost"),
    facts = indexed(tables.accounting_facts, "fact"),
    journals = indexed(tables.journal_entries, "journal");
  const factsBySource = bySource(tables.accounting_facts),
    journalsBySource = bySource(tables.journal_entries);
  const receipts = new Map<string, Record<string, unknown>>();
  for (const receipt of tables.books_projection_receipts) {
    const key = `${receipt.source_type}:${receipt.source_id}`;
    if (receipts.has(key))
      throw new Error("Duplicate payroll projection receipt");
    receipts.set(key, receipt);
  }
  const linesByJournal = new Map<string, Record<string, unknown>[]>();
  for (const line of tables.journal_lines) {
    const key = String(line.entry_id),
      lines = linesByJournal.get(key) ?? [];
    lines.push(line);
    linesByJournal.set(key, lines);
  }
  const selected = new Set<string>();
  for (const cost of costs.values()) {
    if (cost.source_type !== "time_entry") continue;
    const metadata = row.parse(cost.metadata),
      time = times.get(String(cost.source_id));
    if (!inPeriod(cost.incurred_on) && !inPeriod(time?.work_date)) continue;
    // An unowned source cannot safely be presumed unrelated to these workers.
    if (!metadata.worker_user_id)
      throw new Error(
        "Payroll labor source requires reviewed worker attribution",
      );
    if (
      workers.has(String(metadata.worker_user_id)) ||
      workers.has(String(time?.worker_user_id))
    )
      selected.add(String(cost.id));
  }
  for (const fact of facts.values()) {
    if (fact.source_type !== "labor_cost" || !inPeriod(fact.accounting_date))
      continue;
    const payload = row.parse(fact.payload),
      basis = payload.labor_basis
        ? laborBasisSchema.parse(payload.labor_basis)
        : null;
    if (!basis)
      throw new Error(
        "Historical payroll labor requires original wage and worker evidence",
      );
    if (basis.org_id !== orgId || basis.job_cost_id !== fact.source_id)
      throw new Error("Payroll frozen source organization or identity differs");
    if (workers.has(basis.worker_id)) selected.add(String(fact.source_id));
  }
  // Approved time that never reached job cost must not appear as fresh wages
  // simply because the planner received no existing labor IDs.
  const costByTime = new Map<string, Record<string, unknown>[]>();
  for (const cost of costs.values())
    if (cost.source_type === "time_entry") {
      const key = String(cost.source_id),
        list = costByTime.get(key) ?? [];
      list.push(cost);
      costByTime.set(key, list);
    }
  for (const time of times.values()) {
    if (!inPeriod(time.work_date)) continue;
    if (!time.worker_user_id && approvedTime.has(String(time.status)))
      throw new Error(
        "Approved time requires reviewed payroll worker attribution",
      );
    if (!workers.has(String(time.worker_user_id))) continue;
    if (!approvedTime.has(String(time.status)))
      throw new Error("Finish time approval before reconciling payroll");
    const matches = costByTime.get(String(time.id)) ?? [];
    if (matches.length !== 1)
      throw new Error("Payroll time has missing or ambiguous job-cost posting");
    selected.add(String(matches[0].id));
  }
  const evidence = [...selected].sort().map((id) => {
    const cost = costs.get(id);
    if (!cost || cost.source_type !== "time_entry" || cost.status !== "posted")
      throw new Error("Payroll labor has no posted operational source");
    const receipt = receipts.get(`labor_cost:${id}`),
      fact = receipt ? facts.get(String(receipt.fact_id)) : undefined,
      journal = receipt ? journals.get(String(receipt.journal_id)) : undefined;
    if (
      !receipt ||
      !fact ||
      !journal ||
      fact.source_type !== "labor_cost" ||
      fact.source_id !== id ||
      journal.fact_id !== fact.id ||
      journal.source_type !== "labor_cost" ||
      journal.source_id !== id ||
      journal.entry_date !== fact.accounting_date ||
      journal.reversal_of_entry_id != null ||
      resolveBooksPostingState({
        sourceUpdatedAt: String(cost.updated_at),
        receipt: {
          sourceObservedAt: String(receipt.source_observed_at),
          journalStatus: String(journal.status),
        },
      }) !== "posted"
    )
      throw new Error("Refresh payroll labor posting before reconciliation");
    const payload = row.parse(fact.payload),
      basis = laborBasisSchema.parse(payload.labor_basis);
    const current = laborBasisFromJobCost(orgId, cost),
      time = times.get(basis.time_entry_id);
    if (!current || !time || !approvedTime.has(String(time.status)))
      throw new Error(
        "Payroll original labor has missing or unapproved time evidence",
      );
    // Compare mutable time only to detect stale job cost. Ownership and cents
    // still come exclusively from the original immutable basis above.
    const timeBasis = laborBasisFromJobCost(orgId, {
      ...cost,
      source_id: time.id,
      project_id: time.project_id,
      cost_code_id: time.cost_code_id,
      incurred_on: time.work_date,
      cost_cents: time.cost_cents,
      metadata: {
        worker_user_id: time.worker_user_id,
        hours: time.hours,
        base_rate_cents: time.base_rate_cents,
        burden_multiplier: time.burden_multiplier,
        is_overtime: time.is_overtime,
        ot_multiplier: time.ot_multiplier,
        is_double_time: time.is_double_time,
        dt_multiplier: time.dt_multiplier,
        labor_cost_policy_version: time.labor_cost_policy_version,
      },
    });
    if (
      !timeBasis ||
      booksDigest(economicLaborBasis(current)) !==
        booksDigest(economicLaborBasis(basis)) ||
      booksDigest(economicLaborBasis(timeBasis)) !==
        booksDigest(economicLaborBasis(basis))
    )
      throw new Error(
        "Payroll time, job cost and frozen wages differ; refresh or review correction",
      );
    if (
      basis.org_id !== orgId ||
      basis.job_cost_id !== id ||
      basis.project_id !== payload.project_id ||
      basis.cost_cents !== payload.amount_cents ||
      basis.incurred_on !== fact.accounting_date ||
      basis.cost_code_id !==
        (row.parse(payload.dimensions ?? {}).cost_code_id ?? null)
    )
      throw new Error("Payroll frozen source identity differs");
    const originalRevision = timestampMicros(basis.source_revision),
      observed = timestampMicros(String(receipt.source_observed_at));
    if (
      originalRevision === null ||
      observed === null ||
      originalRevision > observed
    )
      throw new Error("Payroll original revision exceeds posting evidence");
    const related = (journalsBySource.get(id) ?? []).filter((entry) =>
      ["posted", "reversed"].includes(String(entry.status)),
    );
    if (related.length !== 1 || related[0].id !== journal.id)
      throw new Error(
        "Revised payroll labor requires reviewed historical attribution",
      );
    const sourceFacts = factsBySource.get(id) ?? [],
      version = z.number().int().positive().parse(fact.source_version);
    if (
      sourceFacts.some(
        (record) =>
          z.number().int().positive().parse(record.source_version) > version,
      )
    )
      throw new Error("Payroll receipt is not the latest labor fact");
    const lines = (linesByJournal.get(String(journal.id)) ?? []).map((record) =>
      lineSchema.parse(record),
    );
    if (lines.length !== 2)
      throw new Error(
        "Payroll original labor journal is incomplete or ambiguous",
      );
    const classified = lines.map((line) => {
      const classification = classificationSchema.parse(
        line.dimensions.books_account_classification,
      );
      if (
        classification.account_id !== line.account_id ||
        line.project_id !== basis.project_id ||
        (line.dimensions.cost_code_id ?? null) !== basis.cost_code_id ||
        line.dimensions.labor_job_cost_id !== id ||
        line.dimensions.labor_time_entry_id !== basis.time_entry_id ||
        line.dimensions.labor_worker_id !== basis.worker_id ||
        line.dimensions.labor_basis_hash !== booksDigest(basis)
      )
        throw new Error(
          "Payroll journal identity or original account classification differs",
        );
      return { ...line, classification };
    });
    const clearing = classified.find(
        (line) => line.classification.code === "2200",
      ),
      costLine = classified.find((line) => line.classification.code !== "2200");
    if (
      !clearing ||
      !costLine ||
      clearing.classification.account_type !== "liability" ||
      !(
        ["cogs", "expense"].includes(costLine.classification.account_type) ||
        (costLine.classification.account_type === "asset" &&
          costLine.classification.subtype === "work_in_progress")
      ) ||
      clearing.debit_cents !== 0 ||
      clearing.credit_cents !== basis.cost_cents ||
      costLine.credit_cents !== 0 ||
      costLine.debit_cents !== basis.cost_cents ||
      costLine.classification.code !== (payload.cost_account_code ?? "5030")
    )
      throw new Error("Payroll journal wages and clearing do not reconcile");
    return {
      id,
      org_id: orgId,
      worker_id: basis.worker_id,
      project_id: basis.project_id,
      cost_code_id: basis.cost_code_id,
      account_code: costLine.classification.code,
      incurred_on: basis.incurred_on,
      fact_id: String(fact.id),
      journal_id: String(journal.id),
      source_revision: basis.source_revision,
      gross_cents: basis.gross_cents,
      estimated_burden_cents: basis.estimated_burden_cents,
      cost_cents: basis.cost_cents,
      clearing_cents: clearing.credit_cents,
    };
  });
  // Catch posted orphan journals even when the operational source or fact was
  // absent from the candidate population.
  for (const journal of journals.values())
    if (
      journal.source_type === "labor_cost" &&
      inPeriod(journal.entry_date) &&
      ["posted", "reversed"].includes(String(journal.status))
    ) {
      const fact = facts.get(String(journal.fact_id)),
        payload = fact ? row.parse(fact.payload) : null;
      const basis = payload?.labor_basis
        ? laborBasisSchema.parse(payload.labor_basis)
        : null;
      if (
        !basis ||
        (workers.has(basis.worker_id) &&
          !selected.has(String(journal.source_id)))
      )
        throw new Error("Payroll ledger has unattributed or orphan labor");
    }
  const labor = payrollLaborEvidenceSchema.parse(evidence),
    chart = tables.gl_accounts.map((record) => chartSchema.parse(record));
  return { labor, chart, snapshot };
}

/** The same proven native selection powers mapping and financial reconciliation. */
export function payrollReconciliationFromSnapshot(
  orgId: string,
  runInput: unknown,
  snapshotInput: unknown,
) {
  const run = payrollImportSchema.parse(runInput);
  if (run.org_id !== orgId)
    throw new Error("Payroll snapshot organization mismatch");
  const { labor, chart, snapshot } = payrollNativeLaborSelection(
    orgId,
    {
      workerIds: run.employees.map((employee) => employee.worker_id),
      periodStart: run.period_start,
      periodEnd: run.period_end,
    },
    snapshotInput,
  );
  const postingCodes = new Set([
    "2200",
    "2230",
    ...run.employees.flatMap((employee) =>
      employee.allocations.map((allocation) => allocation.cost_account_code),
    ),
  ]);
  const postingAccounts = chart
    .filter((account) => postingCodes.has(account.code))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const reconciliation = reconcilePayrollImport(run, labor, chart);
  const workflowEvidence = ["budgets", "budget_lines", "billable_costs"].every(
    (name) => snapshot.tables[name],
  )
    ? payrollWorkflowEvidence(reconciliation, labor, snapshot.tables)
    : null;
  return {
    ...reconciliation,
    workflowEvidence,
    liabilityHistory: payrollLiabilityHistory(orgId, snapshot.tables),
    constructionImpact: payrollConstructionImpact(
      reconciliation,
      labor,
      snapshot.tables,
    ),
    postingAccounts,
    laborEvidence: labor,
    capturedAt: snapshot.capturedAt,
    databaseSnapshot: snapshot.databaseSnapshot,
    previewOnly: true as const,
    providerSourceVerified: false as const,
  };
}
