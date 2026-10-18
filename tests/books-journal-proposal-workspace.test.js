require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
const rules = require("../lib/services/books/journal-proposal-review");
const id = (n) => "88400000-0000-4000-8000-" + String(n).padStart(12, "0");
const proposal = (n) => ({
  id: id(n),
  entry_date: "2026-10-01",
  memo: "Reviewed accrual",
  reversing_on: "2026-11-01",
  policy_version: 3,
  status: "pending",
  proposed_by: id(2),
  proposed_at: "2026-10-04T20:00:00.123456+00:00",
  proposer: { full_name: "Builder maker", email: null },
  lines: [
    {
      line_no: 1,
      account_id: id(3),
      project_id: id(4),
      description: "Cost allocation",
      debit_cents: "9007199254740993",
      credit_cents: "0",
      dimensions: { cost_code: "Concrete", division: "North" },
    },
    {
      line_no: 2,
      account_id: id(5),
      company_id: id(6),
      debit_cents: "0",
      credit_cents: "9007199254740993",
    },
  ],
});
test("review arithmetic and formatting retain cents beyond safe Number precision; unsafe JSON numbers fail closed", () => {
  const p = rules.pendingJournalProposalSchema.parse(proposal(10));
  assert.deepEqual(rules.proposalReviewTotals(p.lines), {
    debit: "9007199254740993",
    credit: "9007199254740993",
    balanced: true,
  });
  assert.equal(
    rules.formatProposalCents("9007199254740993"),
    "$90,071,992,547,409.93",
  );
  assert.throws(() =>
    rules.pendingJournalProposalSchema.parse({
      ...p,
      lines: p.lines.map((l) => ({ ...l, debit_cents: Number(l.debit_cents) })),
    }),
  );
  assert.throws(() =>
    rules.journalProposalCursorSchema.parse({
      id: id(10),
      proposedAt: "2026-10-04T20:00:00Z),status.eq.posted",
    }),
  );
});
test("actual service gates pending queue, bounded keyset pages and same-org labels including inactive accounts", async () => {
  const filename = require.resolve("../lib/services/books/bookkeeping"),
    load = Module._load;
  let denied = false,
    queries = [],
    filters = [];
  const service = {
    from(table) {
      queries.push(table);
      const calls = [];
      return {
        select() {
          return this;
        },
        eq(k, v) {
          calls.push([k, v]);
          return this;
        },
        order(k, v) {
          calls.push(["order", k, v]);
          return this;
        },
        limit(n) {
          assert.equal(n, 26);
          return this;
        },
        or(value) {
          filters.push(value);
          return this;
        },
        in: async (k, v) => {
          assert.ok(calls.some(([k, v]) => k === "org_id" && v === id(1)));
          return {
            data:
              table === "gl_accounts"
                ? [{ id: id(3), code: "5000", name: "Concrete", active: false }]
                : [],
            error: null,
          };
        },
        then(resolve, reject) {
          assert.deepEqual(calls.slice(0, 2), [
            ["org_id", id(1)],
            ["status", "pending"],
          ]);
          return Promise.resolve({
            data: Array.from({ length: 26 }, (_, i) => proposal(100 - i)),
            error: null,
          }).then(resolve, reject);
        },
      };
    },
  };
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: id(1),
            userId: id(7),
            supabase: service,
          }),
        };
      if (name === "@/lib/services/books/access")
        return {
          requireBooksAuthorization: async () => {
            if (denied) throw Error("Books denied");
          },
        };
      return load.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = load;
  }
  denied = true;
  await assert.rejects(api.listJournalProposals(), /Books denied/);
  assert.equal(queries.length, 0);
  denied = false;
  const page = await api.listJournalProposals();
  assert.equal(page.proposals.length, 25);
  assert.deepEqual(page.nextCursor, {
    id: id(76),
    proposedAt: proposal(76).proposed_at,
  });
  assert.equal(page.accounts[0].active, false);
  assert.deepEqual(
    new Set(queries),
    new Set([
      "books_journal_proposals",
      "gl_accounts",
      "projects",
      "companies",
    ]),
  );
  await api.listJournalProposals(undefined, page.nextCursor);
  assert.equal(
    filters[0],
    `proposed_at.lt.${page.nextCursor.proposedAt},and(proposed_at.eq.${page.nextCursor.proposedAt},id.lt.${page.nextCursor.id})`,
  );
  await assert.rejects(
    api.listJournalProposals(undefined, {
      id: id(76),
      proposedAt: "injected,filter",
    }),
  );
});
function card(own = false) {
  const slots = [],
    requests = [];
  let cursor = 0,
    completed = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: initial };
      return [
        slots[i].value,
        (v) => {
          slots[i].value = v;
        },
      ];
    },
    useRef(value) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { current: value };
      return slots[i];
    },
  };
  const compiled = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/journal-proposal-review.tsx", "utf8") +
        "\nexports.TestCard=ProposalCard;",
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    {
      exports: compiled.exports,
      require(name) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime")
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          };
        if (name === "@/lib/services/books/journal-proposal-review")
          return rules;
        if (name === "@/lib/services/books/journal-recovery-client")
          return {
            executeJournalRecovery: (_scope, record) =>
              new Promise((resolve, reject) =>
                requests.push({
                  input: record.request,
                  resolve: (result) =>
                    result.success
                      ? resolve(result.data)
                      : reject(new Error(result.error)),
                }),
              ),
          };
        if (name.endsWith("/books/actions"))
          return {
            reviewJournalProposalAction: (input) =>
              new Promise((resolve) => requests.push({ input, resolve })),
          };
        return new Proxy({}, { get: (_, k) => k });
      },
    },
  );
  const props = {
    proposal: rules.pendingJournalProposalSchema.parse(proposal(10)),
    page: {
      orgId: id(1),
      currentUserId: own ? id(2) : id(7),
      accounts: [{ id: id(3), code: "5000", name: "Concrete", active: false }],
      projects: [{ id: id(4), name: "North job" }],
      companies: [{ id: id(6), name: "Concrete subcontractor" }],
    },
    onReviewed: () => completed++,
  };
  const render = () => {
    cursor = 0;
    return compiled.exports.TestCard(props);
  };
  function nodes(tree, predicate, result = []) {
    if (!tree || typeof tree !== "object") return result;
    if (predicate(tree)) result.push(tree);
    for (const child of [tree.props?.children].flat(Infinity))
      nodes(child, predicate, result);
    return result;
  }
  const button = (tree, label) =>
    nodes(tree, (n) => n.type === "Button" && n.props.children === label)[0];
  return {
    render,
    nodes,
    button,
    requests,
    completed: () => completed,
    inspect: () =>
      nodes(render(), (n) => n.type === "details")[0].props.onToggle({
        currentTarget: { open: true },
      }),
    note: (value) =>
      nodes(render(), (n) => n.type === "Textarea")[0].props.onChange({
        target: { value },
      }),
    flush: async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}
test("review card exposes complete money, allocations and schedule, requires inspection and a real rejection note", async () => {
  const f = card(),
    tree = f.render();
  assert.equal(f.button(tree, "Approve & post").props.disabled, true);
  f.button(tree, "Approve & post").props.onClick();
  assert.equal(f.requests.length, 0);
  const text = JSON.stringify(tree);
  for (const expected of [
    "90,071,992,547,409.93",
    "North job",
    "Concrete subcontractor",
    "cost_code",
    "North",
    "Automatic reversal on 2026-11-01",
    "Policy version ",
  ])
    assert.ok(text.includes(expected), expected);
  f.inspect();
  f.button(f.render(), "Reject with note").props.onClick();
  await f.flush();
  assert.equal(f.requests.length, 0);
  assert.ok(JSON.stringify(f.render()).includes("at least four characters"));
  f.note("Missing allocation evidence");
  f.button(f.render(), "Reject with note").props.onClick();
  assert.equal(f.requests[0].input.note, "Missing allocation evidence");
});
test("unknown review response preserves exact note/decision and coalesces duplicate clicks until confirmation", async () => {
  const f = card();
  f.inspect();
  f.note("Original supporting evidence");
  const button = f.button(f.render(), "Approve & post");
  button.props.onClick();
  button.props.onClick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ success: false, error: "Response lost" });
  await f.flush();
  assert.equal(
    f.nodes(f.render(), (n) => n.type === "Textarea")[0].props.disabled,
    true,
  );
  assert.equal(f.button(f.render(), "Reject with note"), undefined);
  f.button(f.render(), "Retry original review").props.onClick();
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.requests[1].input)),
    JSON.parse(JSON.stringify(f.requests[0].input)),
  );
  f.requests[1].resolve({ success: true, data: { created: false } });
  await f.flush();
  assert.equal(f.completed(), 1);
  const own = card(true);
  own.inspect();
  assert.equal(own.button(own.render(), "Approve & post"), undefined);
});
