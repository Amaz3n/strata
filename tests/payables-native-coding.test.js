require("../scripts/register-ts-node-test");
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const {
  toFormState,
} = require("../components/payables/workspace/payable-form");
const {
  parsePayablesBookQuery,
  parsePayableSort,
} = require("../lib/financials/payables-book");

const nativeId = "b151b670-0689-4b46-b345-9810bf2325f1";
test("native form reads its GL namespace without interpreting QBO IDs as native accounts", () => {
  const bill = {
    id: "bill",
    total_cents: 100,
    qbo_expense_account_id: "qbo-42",
    actual_lines: [
      {
        amount_cents: 100,
        qbo_expense_account_id: "qbo-42",
        arc_books_gl_account_id: nativeId,
      },
    ],
  };
  const context = {
    costCodesEnabled: false,
    qboDefaults: {},
    defaultBillable: () => false,
  };
  assert.equal(
    toFormState(bill, { ...context, nativeBooks: true }).splitLines[0]
      .qboExpenseAccountId,
    nativeId,
  );
  assert.equal(
    toFormState(bill, context).splitLines[0].qboExpenseAccountId,
    "qbo-42",
  );
  assert.equal(
    toFormState(
      { ...bill, actual_lines: [] },
      { ...context, nativeBooks: true },
    ).qboExpenseAccountId,
    "",
  );
});

test("book URLs bound pagination and whitelist sorting; due filtering is retired", () => {
  const result = parsePayablesBookQuery({
    sort: "DROP TABLE",
    direction: "bad",
    page_ready: Infinity,
    page_approval: "3",
    due: "overdue",
    tab: "paid",
  });
  assert.equal(result.sort, "due");
  assert.equal(result.direction, "asc");
  assert.equal(result.bandPages.ready, 1);
  assert.equal(result.bandPages.approval, 3);
  assert.equal(result.includePaid, true);
  assert.equal(result.due, undefined);
  assert.equal(parsePayableSort("amount"), "amount");
});

// Exercise the real write helper in isolation at the database boundary.
function codingHarness({ authority = "arc", valid = true } = {}) {
  const source = ts.createSourceFile(
    "vendor-bills.ts",
    fs.readFileSync("lib/services/vendor-bills.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name.text === "replaceBillLineCoding",
  );
  const code = ts.transpileModule(`export ${fn.getText(source)}`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const writes = [];
  const queries = [];
  const supabase = {
    from(table) {
      const calls = [];
      const q = new Proxy(
        {},
        {
          get(_, key) {
            if (key === "then")
              return (resolve, reject) =>
                Promise.resolve({
                  data:
                    table === "gl_accounts" && valid
                      ? [{ id: nativeId, code: "5200", name: "Materials" }]
                      : [],
                  error: null,
                }).then(resolve, reject);
            return (...args) => {
              calls.push([key, ...args]);
              if (key === "delete" || key === "insert")
                writes.push([key, args[0]]);
              return q;
            };
          },
        },
      );
      queries.push({ table, calls });
      return q;
    },
  };
  const testModule = { exports: {} };
  vm.runInNewContext(code, {
    module: testModule,
    exports: testModule.exports,
    resolveLedgerAuthority: async () => authority,
    isCostDrivenBillingModel: () => false,
    Map,
    Set,
  });
  const run = () =>
    testModule.exports.replaceBillLineCoding(supabase, {
      orgId: "org-1",
      billId: "bill-1",
      lines: [
        {
          cost_code_id: null,
          description: "Materials",
          amount_cents: 100,
          arc_books_gl_account_id: nativeId,
        },
      ],
    });
  return { run, writes, queries };
}

test("native category reaches the exact bill-line metadata consumed by the posting engine", async () => {
  const h = codingHarness();
  await h.run();
  const row = h.writes.find(([kind]) => kind === "insert")[1][0];
  assert.equal(row.metadata.arc_books_gl_account_id, nativeId);
  assert.equal(row.metadata.arc_books_gl_account_name, "5200 · Materials");
  assert.equal(row.metadata.qbo_expense_account_id, undefined);
  assert.ok(JSON.stringify(h.queries).includes('"org_id","org-1"'));
  assert.ok(JSON.stringify(h.queries).includes('"active",true'));
});

test("foreign, inactive, or wrong-ledger native accounts fail before deleting any allocation", async () => {
  for (const options of [{ valid: false }, { authority: "external" }]) {
    const h = codingHarness(options);
    await assert.rejects(h.run(), /active Arc Books|not the active ledger/);
    assert.equal(h.writes.length, 0);
  }
});
