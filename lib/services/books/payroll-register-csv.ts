import { z } from "zod";
import {
  payrollAllocationSchema,
  payrollImportSchema,
} from "./payroll-import-rules";

import { payrollRegisterFields } from "./payroll-register-fields";
export { payrollRegisterFields } from "./payroll-register-fields";

const amountFields = [
  "gross",
  "net",
  "employee_taxes",
  "employee_deductions",
  "employer_taxes",
  "employer_benefits",
] as const;
export const payrollCsvMappingSchema = z
  .object({
    columns: z
      .object(
        Object.fromEntries(
          payrollRegisterFields.map((field) => [
            field,
            z.string().trim().min(1),
          ]),
        ) as Record<(typeof payrollRegisterFields)[number], z.ZodString>,
      )
      .strict(),
    amount_unit: z.enum(["dollars", "cents"]),
    employee_row_value: z.string().trim().min(1),
    control_row_value: z.string().trim().min(1),
  })
  .strict();
export const payrollWorkerMappingSchema = z
  .array(
    z
      .object({
        employee_reference: z.string().trim().min(1).max(200),
        worker_id: z.string().uuid().toLowerCase(),
        allocations: z.array(payrollAllocationSchema).min(1),
      })
      .strict(),
  )
  .min(1);

/** Strict CSV: extra cells, broken quotes and duplicate headers must never be
 * truncated into a seemingly valid financial register.
 */
function csvMatrix(text: string) {
  const matrix: string[][] = [];
  let cells: string[] = [],
    cell = "",
    state: "plain" | "quoted" | "closed" = "plain";
  const endRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim())) matrix.push(cells);
    cells = [];
    cell = "";
    state = "plain";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else state = "closed";
      } else cell += char;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
      state = "plain";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (char === '"' && state === "plain" && !cell) state = "quoted";
    else {
      if (state === "closed" || char === '"')
        throw new Error("Payroll CSV has malformed quotes");
      cell += char;
    }
  }
  if (state === "quoted")
    throw new Error("Payroll CSV has unterminated quotes");
  endRow();
  if (matrix.length < 3)
    throw new Error(
      "Payroll register requires employees and an independent control row",
    );
  const headers = matrix.shift()!.map((value) => value.trim());
  if (
    headers.some((value) => !value) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("Payroll CSV has blank or duplicate headers");
  for (const cells of matrix)
    if (cells.length !== headers.length)
      throw new Error("Payroll CSV row width differs from its headers");
  return {
    headers,
    rows: matrix.map((cells) =>
      Object.fromEntries(headers.map((header, i) => [header, cells[i].trim()])),
    ),
  };
}
function cents(text: string, unit: "dollars" | "cents") {
  if (
    text.length > 24 ||
    !(
      unit === "dollars" ? /^(0|[1-9]\d*)(?:\.\d{1,2})?$/ : /^(0|[1-9]\d*)$/
    ).test(text)
  )
    throw new Error(
      "Payroll amount must be an exact nonnegative decimal in its declared unit",
    );
  const [whole, fraction = ""] = text.split(".");
  const value =
    unit === "dollars"
      ? BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))
      : BigInt(whole);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Payroll amount exceeds safe integer cents");
  return result;
}

/** Every provider financial amount and run date comes from the verified file.
 * Worker/project allocation choices remain explicit reviewable mappings.
 * One employee row per reference plus one independent provider control row;
 * unsupported row kinds/extra columns fail instead of silently losing fees.
 */
export function payrollRunFromCsv(input: {
  text: string;
  checksum: string;
  orgId: string;
  runId: string;
  mapping: unknown;
  workers: unknown;
}) {
  const mapping = payrollCsvMappingSchema.parse(input.mapping),
    workers = payrollWorkerMappingSchema.parse(input.workers);
  if (mapping.employee_row_value === mapping.control_row_value)
    throw new Error("Payroll employee and control row kinds must differ");
  const columns = Object.values(mapping.columns);
  if (new Set(columns).size !== columns.length)
    throw new Error("Payroll column mapping reuses a source column");
  const { headers, rows } = csvMatrix(input.text.replace(/^\uFEFF/, ""));
  if (
    headers.length !== columns.length ||
    columns.some((column) => !headers.includes(column))
  )
    throw new Error(
      "Payroll source columns require complete explicit mapping; unsupported columns cannot be ignored",
    );
  const byReference = new Map(
    workers.map((worker) => [worker.employee_reference, worker]),
  );
  if (
    byReference.size !== workers.length ||
    new Set(workers.map((worker) => worker.worker_id)).size !== workers.length
  )
    throw new Error(
      "Payroll worker mapping has duplicate references or workers",
    );
  const controls: Record<string, number>[] = [],
    employees: z.infer<typeof payrollImportSchema>["employees"] = [];
  let metadata: Record<string, string> | null = null;
  const used = new Set<string>();
  for (const row of rows) {
    const read = (field: (typeof payrollRegisterFields)[number]) =>
      row[mapping.columns[field]];
    const current = Object.fromEntries(
      [
        "provider",
        "provider_run_id",
        "period_start",
        "period_end",
        "accrual_date",
        "pay_date",
      ].map((field) => [
        field,
        read(field as (typeof payrollRegisterFields)[number]),
      ]),
    );
    if (!metadata) metadata = current;
    else if (
      Object.keys(current).some((key) => current[key] !== metadata![key])
    )
      throw new Error("Payroll file mixes providers, runs or work/pay periods");
    const amounts = Object.fromEntries(
      amountFields.map((field) => [
        `${field}_cents`,
        cents(read(field), mapping.amount_unit),
      ]),
    );
    if (read("row_type") === mapping.control_row_value) {
      if (read("employee_reference"))
        throw new Error("Payroll control row cannot identify an employee");
      controls.push({
        ...amounts,
        funding_cents: cents(read("funding"), mapping.amount_unit),
      });
    } else if (read("row_type") === mapping.employee_row_value) {
      const reference = read("employee_reference"),
        worker = byReference.get(reference);
      if (!worker || used.has(reference))
        throw new Error(
          "Payroll employee mapping is missing or its provider reference is duplicated",
        );
      if (read("funding"))
        throw new Error(
          "Payroll employee funding needs a separately modeled provider funding policy",
        );
      used.add(reference);
      employees.push({ ...worker, ...amounts } as z.infer<
        typeof payrollImportSchema
      >["employees"][number]);
    } else throw new Error("Payroll register contains an unsupported row kind");
  }
  if (controls.length !== 1 || used.size !== workers.length)
    throw new Error(
      "Payroll requires exactly one independent control row and every worker mapping must be used",
    );
  return payrollImportSchema.parse({
    ...metadata,
    id: input.runId,
    org_id: input.orgId,
    source_checksum: input.checksum,
    employees,
    controls: controls[0],
  });
}

/** Column discovery exposes only header names. Financial rows stay on the
 * authorized server until their complete mapping and provider controls pass. */
export function payrollRegisterHeaders(text: string) {
  return csvMatrix(text.replace(/^\uFEFF/, "")).headers;
}

const providerEmployeeSchema = payrollImportSchema.shape.employees.element.omit(
  { worker_id: true, allocations: true },
);
const providerRegisterSchema = payrollImportSchema
  .omit({ id: true, org_id: true, source_checksum: true })
  .extend({ employees: z.array(providerEmployeeSchema).min(1) });

/** Provider-only inspection never invents worker identities, allocation choices
 * or recognized labor. All values derive from the retained original bytes. */
export function inspectPayrollRegisterCsv(text: string, input: unknown) {
  const mapping = payrollCsvMappingSchema.parse(input);
  if (mapping.employee_row_value === mapping.control_row_value)
    throw new Error("Payroll employee and control row kinds must differ");
  const columns = Object.values(mapping.columns);
  if (new Set(columns).size !== columns.length)
    throw new Error("Payroll column mapping reuses a source column");
  const { headers, rows } = csvMatrix(text.replace(/^\uFEFF/, ""));
  if (
    headers.length !== columns.length ||
    columns.some((column) => !headers.includes(column))
  )
    throw new Error(
      "Payroll source columns require complete explicit mapping; unsupported columns cannot be ignored",
    );
  let metadata: Record<string, string> | null = null;
  const employees: Record<string, unknown>[] = [],
    controls: Record<string, number>[] = [],
    used = new Set<string>();
  for (const row of rows) {
    const read = (field: (typeof payrollRegisterFields)[number]) =>
      row[mapping.columns[field]];
    const current = Object.fromEntries(
      [
        "provider",
        "provider_run_id",
        "period_start",
        "period_end",
        "accrual_date",
        "pay_date",
      ].map((field) => [
        field,
        read(field as (typeof payrollRegisterFields)[number]),
      ]),
    );
    if (!metadata) metadata = current;
    else if (
      Object.keys(current).some((key) => current[key] !== metadata![key])
    )
      throw new Error("Payroll file mixes providers, runs or work/pay periods");
    const amounts = Object.fromEntries(
      amountFields.map((field) => [
        `${field}_cents`,
        cents(read(field), mapping.amount_unit),
      ]),
    );
    if (read("row_type") === mapping.control_row_value) {
      if (read("employee_reference"))
        throw new Error("Payroll control row cannot identify an employee");
      controls.push({
        ...amounts,
        funding_cents: cents(read("funding"), mapping.amount_unit),
      });
    } else if (read("row_type") === mapping.employee_row_value) {
      const reference = read("employee_reference");
      if (!reference || used.has(reference))
        throw new Error("Payroll employee reference is missing or duplicated");
      if (read("funding"))
        throw new Error(
          "Payroll employee funding needs a separately modeled provider funding policy",
        );
      used.add(reference);
      employees.push({ employee_reference: reference, ...amounts });
    } else throw new Error("Payroll register contains an unsupported row kind");
  }
  if (controls.length !== 1)
    throw new Error("Payroll requires exactly one independent control row");
  const result = providerRegisterSchema.parse({
    ...metadata,
    employees,
    controls: controls[0],
  });
  if (
    result.period_start > result.period_end ||
    result.accrual_date < result.period_start ||
    result.accrual_date > result.period_end
  )
    throw new Error("Payroll accrual date must be in its work period");
  for (const key of amountFields) {
    const name = `${key}_cents` as keyof typeof result.controls;
    const total = result.employees.reduce(
      (sum, employee) =>
        sum + BigInt(employee[name as keyof typeof employee] as number),
      BigInt(0),
    );
    if (total !== BigInt(result.controls[name]))
      throw new Error(`Provider payroll control total differs: ${name}`);
  }
  for (const employee of result.employees)
    if (
      BigInt(employee.gross_cents) !==
      BigInt(employee.net_cents) +
        BigInt(employee.employee_taxes_cents) +
        BigInt(employee.employee_deductions_cents)
    )
      throw new Error("Payroll employee net and deductions differ from gross");
  const funding =
    BigInt(result.controls.net_cents) +
    BigInt(result.controls.employee_taxes_cents) +
    BigInt(result.controls.employee_deductions_cents) +
    BigInt(result.controls.employer_taxes_cents) +
    BigInt(result.controls.employer_benefits_cents);
  if (funding !== BigInt(result.controls.funding_cents))
    throw new Error("Provider payroll funding total differs");
  return result;
}
