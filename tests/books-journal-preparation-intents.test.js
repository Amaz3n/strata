require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  Module = require("node:module");
const id = (n) => "88500000-0000-4000-8000-" + String(n).padStart(12, "0");
const { fixture } = require("./fixtures/books-journal-database");

test("lost preparation retries retain original policy/accounts and reviewed receipt while distinct identical intent IDs post separately", async (t) => {
  const f = await fixture(t),
    first = await f.prepare();
  assert.equal(first.created, true);
  assert.equal(first.policyVersion, 3);
  assert.equal((await f.prepare()).id, first.id);
  await f.review(first.id);
  const second = await f.prepare({ intent: id(11) });
  assert.notEqual(first.id, second.id);
  await f.review(second.id);
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    2,
  );
  await f.db.exec(
    "update books_settings set active_policy_version=4;update gl_accounts set active=false,code=code||'X';",
  );
  const retry = await f.prepare();
  assert.equal(retry.id, first.id);
  assert.equal(retry.status, "posted");
  assert.equal(retry.policyVersion, 3);
  assert.equal(retry.created, false);
  await assert.rejects(f.prepare({ intent: id(12) }), /active and scoped/);
});
test("changed submission, foreign actor/workflow, unbalanced or unsafe cents cannot produce a second receipt or any money", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  for (const change of [
    { memo: "Changed accrual" },
    { reversing: "2026-10-02" },
    { lines: f.lines.map((l) => ({ ...l, dimensions: { basis: "Changed" } })) },
    { actor: id(7) },
  ])
    await assert.rejects(f.prepare(change), /differs from retained/);
  await assert.rejects(f.prepare({ actor: id(8) }), /membership/);
  await assert.rejects(
    f.prepare({
      intent: id(11),
      lines: f.lines.map((l, i) => (i ? l : { ...l, debit_cents: 100 })),
    }),
    /unbalanced/,
  );
  await assert.rejects(
    f.prepare({
      intent: id(11),
      lines: f.lines.map((l) => ({
        ...l,
        debit_cents: l.debit_cents ? 9007199254740992 : 0,
        credit_cents: l.credit_cents ? 9007199254740992 : 0,
      })),
    }),
    /safe integer/,
  );
  await f.db.exec(
    `insert into projects(id,org_id) values('${id(15)}','${id(9)}')`,
  );
  await assert.rejects(
    f.prepare({
      intent: id(11),
      lines: f.lines.map((l) => ({ ...l, project_id: id(15) })),
    }),
    /project belongs/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from books_journal_proposals"))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
});
test("RPC remains private invoker and frozen account codes cannot be changed after preparation", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await assert.rejects(
    f.db.exec(
      "update books_journal_proposals set lines=jsonb_set(lines,'{0,account_code}','\"changed\"')",
    ),
    /intent is immutable/,
  );
  const acl = (
    await f.db.query(
      "select prosecdef,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where proname='prepare_books_journal_proposal_atomic'",
    )
  ).rows[0];
  assert.deepEqual(acl, { prosecdef: false, allowed: false });
});
test("actual service validates preparation receipt, gates before RPC, and records only the first committed submission event", async (t) => {
  const f = await fixture(t),
    filename = require.resolve("../lib/services/books/bookkeeping"),
    load = Module._load;
  let denied = false,
    forged = false,
    calls = 0,
    events = [],
    api;
  const service = {
    rpc: async (name, a) => {
      calls++;
      assert.equal(name, "prepare_books_journal_proposal_atomic");
      assert.equal(a.p_org, id(1));
      assert.equal(a.p_actor, id(2));
      const data = await f.prepare({
        intent: a.p_intent,
        date: a.p_date,
        memo: a.p_memo,
        reversing: a.p_reversing,
        lines: a.p_lines,
      });
      return { data: forged ? { ...data, actorId: id(7) } : data, error: null };
    },
  };
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: id(1),
            userId: id(2),
            supabase: service,
          }),
        };
      if (name === "@/lib/services/books/access")
        return {
          requireBooksAuthorization: async () => {
            if (denied) throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/events")
        return { recordEvent: async (e) => events.push(e) };
      return load.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = load;
  }
  const input = {
    intentId: id(10),
    entryDate: "2026-10-01",
    memo: "Original accrual",
    lines: f.lines.map((l) => ({
      accountCode: l.account_code,
      debitCents: l.debit_cents,
      creditCents: l.credit_cents,
      description: l.description,
      dimensions: l.dimensions,
    })),
  };
  denied = true;
  await assert.rejects(api.proposeAdjustingJournal(input), /Books denied/);
  assert.equal(calls, 0);
  denied = false;
  const beforeScopeCheck = calls;
  await assert.rejects(
    api.proposeAdjustingJournal({
      ...input,
      expectedOrgId: id(9),
      expectedActorId: id(2),
    }),
    /another organization or user/,
  );
  await assert.rejects(
    api.proposeAdjustingJournal({
      ...input,
      expectedOrgId: id(1),
      expectedActorId: id(7),
    }),
    /another organization or user/,
  );
  assert.equal(calls, beforeScopeCheck);
  const receipt = await api.proposeAdjustingJournal(input);
  assert.equal(events.length, 1);
  assert.equal((await api.proposeAdjustingJournal(input)).id, receipt.id);
  assert.equal(events.length, 1);
  forged = true;
  await assert.rejects(api.proposeAdjustingJournal(input));
  assert.equal(events.length, 1);
});
test("actual adjustment editor freezes a UUID-bearing original submission and coalesces clicks through an uncertain response", async () => {
  const vm = require("node:vm"),
    ts = require("typescript"),
    money = require("../lib/financials/money-input");
  let cursor = 0,
    completed = 0,
    pending = false,
    uuid = 900;
  const slots = [],
    requests = [],
    compiled = { exports: {} };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= {
        value: typeof initial === "function" ? initial() : initial,
      };
      return [
        slots[i].value,
        (v) => {
          slots[i].value = typeof v === "function" ? v(slots[i].value) : v;
        },
      ];
    },
    useRef(value) {
      const i = cursor++;
      slots[i] ??= { current: value };
      return slots[i];
    },
    useMemo: (fn) => fn(),
    useTransition() {
      return [
        pending,
        (fn) => {
          pending = true;
          Promise.resolve(fn()).finally(() => (pending = false));
        },
      ];
    },
  };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/books-journals.tsx", "utf8") +
        "\nexports.TestEditor=NewEntryPane;",
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
      crypto: { randomUUID: () => id(uuid++) },
      require(name) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime")
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          };
        if (name === "@/lib/financials/money-input") return money;
        if (name === "@/lib/utils")
          return {
            cn: (...values) => values.join(" "),
            formatMoneyCentsExact: (value) => String(value),
          };
        if (name === "sonner") return { toast: { error() {}, success() {} } };
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
            proposeAdjustingJournalAction: (input) =>
              new Promise((resolve) => requests.push({ input, resolve })),
          };
        return new Proxy({}, { get: (_, k) => k });
      },
    },
  );
  function nodes(tree, predicate, result = []) {
    if (!tree || typeof tree !== "object") return result;
    if (predicate(tree)) result.push(tree);
    for (const child of [tree.props?.children].flat(Infinity))
      nodes(child, predicate, result);
    return result;
  }
  const render = () => {
      cursor = 0;
      return compiled.exports.TestEditor({
        scope: { orgId: id(1), actorId: id(2) },
        accounts: [],
        asOf: "2026-10-01",
        onCancel() {},
        onSubmitted() {
          completed++;
        },
      });
    },
    button = (tree, label) =>
      nodes(tree, (n) => n.type === "Button" && n.props.children === label)[0],
    flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
  const initial = render();
  nodes(
    initial,
    (n) => n.type === "Input" && n.props["aria-label"] === "Memo",
  )[0].props.onChange({ target: { value: "Original accrual" } });
  nodes(
    initial,
    (n) => typeof n.type === "function" && n.type.name === "LineEditor",
  )[0].props.onChange([
    {
      key: "one",
      accountCode: "1000",
      description: "Original",
      debit: "125",
      credit: "",
    },
    {
      key: "two",
      accountCode: "4000",
      description: "Original",
      debit: "",
      credit: "125",
    },
  ]);
  const submit = button(render(), "Submit for approval");
  submit.props.onClick();
  submit.props.onClick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input.intentId, id(900));
  requests[0].resolve({ success: false, error: "Response lost" });
  await flush();
  assert.equal(
    nodes(render(), (n) => n.type === "fieldset")[0].props.disabled,
    true,
  );
  button(render(), "Retry original submission").props.onClick();
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests[1].input)),
    JSON.parse(JSON.stringify(requests[0].input)),
  );
  requests[1].resolve({
    success: true,
    data: { id: id(10), created: false, status: "pending" },
  });
  await flush();
  assert.equal(completed, 1);
});
