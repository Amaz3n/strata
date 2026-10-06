require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  payrollRegisterFields,
  inspectPayrollRegisterCsv,
  payrollRegisterHeaders,
} = require("../lib/services/books/payroll-register-csv");
const mapping = {
  columns: Object.fromEntries(
    payrollRegisterFields.map((field) => [field, field]),
  ),
  amount_unit: "dollars",
  employee_row_value: "employee",
  control_row_value: "control",
};
const metadata = [
  "Provider",
  "RUN-1",
  "2026-09-01",
  "2026-09-15",
  "2026-09-15",
  "2026-09-18",
];
const rows = () => [
  [
    "employee",
    ...metadata,
    "W-1",
    "240.00",
    "180.00",
    "50.00",
    "10.00",
    "25.00",
    "5.00",
    "",
  ],
  [
    "control",
    ...metadata,
    "",
    "240.00",
    "180.00",
    "50.00",
    "10.00",
    "25.00",
    "5.00",
    "270.00",
  ],
];
const csv = (r) =>
  [payrollRegisterFields, ...r].map((row) => row.join(",")).join("\r\n");
test("inspection verifies provider controls before worker or construction mapping and returns no invented identities", () => {
  const text = "\uFEFF" + csv(rows());
  assert.deepEqual(payrollRegisterHeaders(text), payrollRegisterFields);
  const inspected = inspectPayrollRegisterCsv(text, mapping);
  assert.equal(inspected.controls.funding_cents, 27000);
  assert.equal(inspected.employees[0].gross_cents, 24000);
  assert.equal(inspected.provider_run_id, "RUN-1");
  assert.equal(inspected.employees[0].employee_reference, "W-1");
  assert.ok(!("worker_id" in inspected.employees[0]));
  assert.ok(!("allocations" in inspected.employees[0]));
});
test("inspection rejects source, row, date, employee, control, funding and exact-cent inconsistencies", () => {
  for (const mutate of [
    (r) => (r[1][8] = "241.00"),
    (r) => (r[0][9] = "179.00"),
    (r) => (r[1][14] = "269.00"),
    (r) => (r[0][8] = "240.001"),
    (r) => (r[0][7] = ""),
    (r) => r.push([...r[0]]),
    (r) => r.push([...r[1]]),
    (r) => (r[0][0] = "fee"),
    (r) => (r[0][1] = "Other provider"),
    (r) => r.forEach((row) => (row[5] = "2026-09-16")),
    (r) => (r[0][14] = "270.00"),
  ]) {
    const changed = rows();
    mutate(changed);
    assert.throws(() => inspectPayrollRegisterCsv(csv(changed), mapping));
  }
  for (const changed of [
    { ...mapping, employee_row_value: "control" },
    { ...mapping, columns: { ...mapping.columns, gross: "net" } },
  ])
    assert.throws(() => inspectPayrollRegisterCsv(csv(rows()), changed));
  assert.throws(
    () =>
      inspectPayrollRegisterCsv(
        csv(rows()).replace("row_type,", "row_type,ignored,"),
        mapping,
      ),
    /width|complete/,
  );
  assert.throws(() => payrollRegisterHeaders("a,a\n1,2\n3,4"), /duplicate/);
});
