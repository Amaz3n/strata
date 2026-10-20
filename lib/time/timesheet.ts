import { calculateTimeEntryCostCents } from "@/lib/financials/job-cost-calculations";
import { toCsv } from "@/lib/services/reports/csv";
import { entryKind } from "@/lib/time/overtime";

// One shape for every period view: the week grid, My hours, the approval queue,
// the period summary and the payroll export all read these rows.
export type TimesheetEntry = {
  id: string;
  worker_user_id: string | null;
  worker_name: string;
  worker_email: string | null;
  project_id: string;
  project_name: string;
  cost_code_id: string | null;
  cost_code_label: string | null;
  work_date: string;
  hours: number;
  status: string;
  rejection_reason: string | null;
  notes: string | null;
  is_overtime: boolean;
  is_double_time: boolean;
  overtime_source: "rule" | "manual" | null;
  base_rate_cents: number;
  burden_multiplier: number;
  ot_multiplier: number;
  dt_multiplier: number;
  cost_cents: number | null;
  reverses_time_entry_id: string | null;
};

export const APPROVED_TIME_STATUSES = ["pm_approved", "client_approved", "locked"] as const;
export const OPEN_TIME_STATUSES = ["draft", "submitted"] as const;

export function isApprovedTime(status: string) {
  return (APPROVED_TIME_STATUSES as readonly string[]).includes(status);
}

export function isOpenTime(status: string) {
  return (OPEN_TIME_STATUSES as readonly string[]).includes(status);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

type HourTotals = { hours: number; regular: number; overtime: number; doubleTime: number };

function emptyTotals(): HourTotals {
  return { hours: 0, regular: 0, overtime: 0, doubleTime: 0 };
}

function addHours(totals: HourTotals, entry: TimesheetEntry) {
  const kind = entryKind(entry);
  totals.hours = round2(totals.hours + entry.hours);
  if (kind === "regular") totals.regular = round2(totals.regular + entry.hours);
  if (kind === "overtime") totals.overtime = round2(totals.overtime + entry.hours);
  if (kind === "double_time") totals.doubleTime = round2(totals.doubleTime + entry.hours);
}

export type TimesheetGridRow = {
  projectId: string;
  projectName: string;
  byDay: Record<string, number>;
  total: number;
};

export type TimesheetGridWorker = HourTotals & {
  key: string;
  workerUserId: string | null;
  workerName: string;
  rows: TimesheetGridRow[];
  dayTotals: Record<string, number>;
  waiting: number;
  rejected: number;
  approved: number;
};

const workerKey = (entry: TimesheetEntry) => entry.worker_user_id ?? `name:${entry.worker_name}`;

// Rejected entries are shown to the worker but never counted as hours.
export function buildTimesheetGrid(entries: TimesheetEntry[]): TimesheetGridWorker[] {
  const workers = new Map<string, TimesheetGridWorker>();
  for (const entry of entries) {
    const key = workerKey(entry);
    let worker = workers.get(key);
    if (!worker) {
      worker = {
        key,
        workerUserId: entry.worker_user_id,
        workerName: entry.worker_name,
        rows: [],
        dayTotals: {},
        waiting: 0,
        rejected: 0,
        approved: 0,
        ...emptyTotals(),
      };
      workers.set(key, worker);
    }
    if (entry.status === "rejected") {
      worker.rejected += 1;
      continue;
    }
    if (isOpenTime(entry.status)) worker.waiting += 1;
    if (isApprovedTime(entry.status)) worker.approved += 1;
    let row = worker.rows.find((candidate) => candidate.projectId === entry.project_id);
    if (!row) {
      row = { projectId: entry.project_id, projectName: entry.project_name, byDay: {}, total: 0 };
      worker.rows.push(row);
    }
    row.byDay[entry.work_date] = round2((row.byDay[entry.work_date] ?? 0) + entry.hours);
    row.total = round2(row.total + entry.hours);
    worker.dayTotals[entry.work_date] = round2((worker.dayTotals[entry.work_date] ?? 0) + entry.hours);
    addHours(worker, entry);
  }
  return [...workers.values()]
    .map((worker) => ({
      ...worker,
      rows: worker.rows.sort((a, b) => a.projectName.localeCompare(b.projectName)),
    }))
    .sort((a, b) => a.workerName.localeCompare(b.workerName));
}

export type PeriodSummaryLine = HourTotals & { key: string; label: string; costCents: number };

export type PeriodSummary = {
  byWorker: PeriodSummaryLine[];
  byJob: PeriodSummaryLine[];
  totals: HourTotals & { costCents: number };
};

// Payroll counts approved and locked hours only.
export function summarizePeriod(entries: TimesheetEntry[]): PeriodSummary {
  const byWorker = new Map<string, PeriodSummaryLine>();
  const byJob = new Map<string, PeriodSummaryLine>();
  const totals = { ...emptyTotals(), costCents: 0 };
  for (const entry of entries) {
    if (!isApprovedTime(entry.status)) continue;
    const cost = calculateTimeEntryCostCents(entry);
    for (const [map, key, label] of [
      [byWorker, workerKey(entry), entry.worker_name],
      [byJob, entry.project_id, entry.project_name],
    ] as const) {
      const line = map.get(key) ?? { key, label, costCents: 0, ...emptyTotals() };
      addHours(line, entry);
      line.costCents += cost;
      map.set(key, line);
    }
    addHours(totals, entry);
    totals.costCents += cost;
  }
  const sorted = (map: Map<string, PeriodSummaryLine>) =>
    [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { byWorker: sorted(byWorker), byJob: sorted(byJob), totals };
}

export type PayrollExportLayout = "generic" | "gusto";

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] ?? "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

// Formula characters at the start of a cell run as formulas in spreadsheet apps.
function safeText(value: string) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function payrollExportCsv(
  entries: TimesheetEntry[],
  layout: PayrollExportLayout,
  period: { startsOn: string; endsOn: string },
) {
  const approved = entries.filter((entry) => isApprovedTime(entry.status));
  if (layout === "gusto") {
    const rows = new Map<string, { first: string; last: string; email: string } & HourTotals>();
    for (const entry of approved) {
      const key = workerKey(entry);
      const name = splitName(entry.worker_name);
      const row = rows.get(key) ?? {
        first: safeText(name.first),
        last: safeText(name.last),
        email: safeText(entry.worker_email ?? ""),
        ...emptyTotals(),
      };
      addHours(row, entry);
      rows.set(key, row);
    }
    return toCsv(
      [...rows.values()].sort((a, b) => `${a.last} ${a.first}`.localeCompare(`${b.last} ${b.first}`)),
      [
        { key: "last", header: "last_name" },
        { key: "first", header: "first_name" },
        { key: "email", header: "email" },
        { key: "regular", header: "regular_hours", format: (value) => Number(value).toFixed(2) },
        { key: "overtime", header: "overtime_hours", format: (value) => Number(value).toFixed(2) },
        { key: "doubleTime", header: "double_overtime_hours", format: (value) => Number(value).toFixed(2) },
      ],
    );
  }
  const rows = new Map<
    string,
    { worker: string; email: string; job: string; costCode: string; costCents: number } & HourTotals
  >();
  for (const entry of approved) {
    const key = `${workerKey(entry)}|${entry.project_id}|${entry.cost_code_id ?? ""}`;
    const row = rows.get(key) ?? {
      worker: safeText(entry.worker_name),
      email: safeText(entry.worker_email ?? ""),
      job: safeText(entry.project_name),
      costCode: safeText(entry.cost_code_label ?? ""),
      costCents: 0,
      ...emptyTotals(),
    };
    addHours(row, entry);
    row.costCents += calculateTimeEntryCostCents(entry);
    rows.set(key, row);
  }
  const hours = (value: unknown) => Number(value).toFixed(2);
  return toCsv(
    [...rows.values()]
      .sort((a, b) => a.worker.localeCompare(b.worker) || a.job.localeCompare(b.job))
      .map((row) => ({ ...row, periodStart: period.startsOn, periodEnd: period.endsOn })),
    [
      { key: "periodStart", header: "Period start" },
      { key: "periodEnd", header: "Period end" },
      { key: "worker", header: "Worker" },
      { key: "email", header: "Email" },
      { key: "job", header: "Job" },
      { key: "costCode", header: "Cost code" },
      { key: "regular", header: "Regular hours", format: hours },
      { key: "overtime", header: "Overtime hours", format: hours },
      { key: "doubleTime", header: "Double time hours", format: hours },
      { key: "costCents", header: "Labor cost", format: (value) => (Number(value) / 100).toFixed(2) },
    ],
  );
}
