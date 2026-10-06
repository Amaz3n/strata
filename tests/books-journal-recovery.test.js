require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
const rules = require("../lib/services/books/journal-recovery"),
  id = (n) => "88700000-0000-4000-8000-" + String(n).padStart(12, "0"),
  scope = { orgId: id(1), actorId: id(2) };
const preparation = (intent = 10) => ({
  version: 1,
  kind: "prepare",
  request: {
    expectedOrgId: scope.orgId,
    expectedActorId: scope.actorId,
    intentId: id(intent),
    entryDate: "2026-10-01",
    memo: "Original accrual",
    reversingOn: "2026-11-01",
    lines: [
      {
        accountCode: "1000",
        debitCents: 12500,
        creditCents: 0,
        description: "Original debit",
        dimensions: { cost_code: "Concrete" },
      },
      {
        accountCode: "4000",
        debitCents: 0,
        creditCents: 12500,
        description: "Original credit",
      },
    ],
  },
});
const review = () => ({
  version: 1,
  kind: "review",
  request: {
    expectedOrgId: scope.orgId,
    expectedActorId: scope.actorId,
    proposalId: id(30),
    decision: "approve",
    note: "Checked original allocation",
  },
});
function storage() {
  const rows = new Map();
  let failWrite = false,
    failClear = false;
  return {
    rows,
    failWrite: (v) => (failWrite = v),
    failClear: (v) => (failClear = v),
    getItem: (k) => rows.get(k) ?? null,
    setItem: (k, v) => {
      if (failWrite) throw Error("Storage write denied");
      rows.set(k, v);
    },
    removeItem: (k) => {
      if (failClear) throw Error("Storage clear denied");
      rows.delete(k);
    },
  };
}
function browser(store, sharedLocks) {
  const requests = [],
    events = [],
    compiled = { exports: {} },
    chains = sharedLocks ?? new Map();
  const locks = {
    request(name, fn) {
      const promise = (chains.get(name) ?? Promise.resolve()).then(fn);
      chains.set(
        name,
        promise.catch(() => {}),
      );
      return promise;
    },
  };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("lib/services/books/journal-recovery-client.ts", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    {
      exports: compiled.exports,
      Event: class {
        constructor(type) {
          this.type = type;
        }
      },
      navigator: { locks },
      window: {
        localStorage: store,
        dispatchEvent: (e) => events.push(e.type),
      },
      require(name) {
        if (name === "@/lib/services/books/journal-recovery") return rules;
        if (name.endsWith("/books/actions"))
          return {
            proposeAdjustingJournalAction: (input) =>
              new Promise((resolve) =>
                requests.push({ kind: "prepare", input, resolve }),
              ),
            resolveJournalRecoveryAction: (input) =>
              new Promise((resolve) =>
                requests.push({ kind: "resolve", input, resolve }),
              ),
            reviewJournalProposalAction: (input) =>
              new Promise((resolve) =>
                requests.push({ kind: "review", input, resolve }),
              ),
          };
        throw Error("Unexpected " + name);
      },
    },
  );
  return {
    execute: compiled.exports.executeJournalRecovery,
    resolve: compiled.exports.resolveJournalRecoveryRequest,
    requests,
    events,
    flush: async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}
const prepared = (intent = 10, overrides = {}) => ({
  orgId: scope.orgId,
  actorId: scope.actorId,
  intentId: id(intent),
  id: id(20),
  status: "pending",
  created: false,
  ...overrides,
});
const reviewed = (overrides) => ({
  orgId: scope.orgId,
  reviewerId: scope.actorId,
  proposalId: id(30),
  status: "posted",
  journal_entry_id: id(40),
  reversal_entry_id: id(41),
  created: false,
  ...overrides,
});
test("exact saved requests survive cold storage reload and cannot cross organization/user or overwrite an uncertain request", () => {
  const s = storage(),
    record = preparation();
  rules.persistJournalRecovery(s, scope, record);
  assert.deepEqual(rules.readJournalRecovery(s, scope), record);
  assert.equal(
    rules.readJournalRecovery(s, { ...scope, actorId: id(3) }),
    null,
  );
  assert.throws(
    () => rules.persistJournalRecovery(s, { ...scope, actorId: id(3) }, record),
    /another organization or user/,
  );
  assert.throws(
    () => rules.persistJournalRecovery(s, scope, preparation(11)),
    /previous journal/,
  );
  assert.throws(
    () => rules.clearJournalRecovery(s, scope, preparation(11)),
    /Another journal/,
  );
  assert.deepEqual(rules.readJournalRecovery(s, scope), record);
  s.rows.set(rules.journalRecoveryKey(scope), "malformed JSON");
  assert.throws(() => rules.readJournalRecovery(s, scope));
  assert.throws(() => rules.persistJournalRecovery(s, scope, record));
  assert.equal(s.rows.get(rules.journalRecoveryKey(scope)), "malformed JSON");
});
test("save failure prevents the action; lost response survives a new browser runtime and recovers the exact original proposal", async () => {
  const s = storage(),
    first = browser(s),
    record = preparation();
  s.failWrite(true);
  await assert.rejects(first.execute(scope, record), /write denied/);
  assert.equal(first.requests.length, 0);
  s.failWrite(false);
  const pending = first.execute(scope, record);
  await first.flush();
  assert.deepEqual(rules.readJournalRecovery(s, scope), record);
  first.requests[0].resolve({
    success: false,
    error: "Submission response lost",
  });
  await assert.rejects(pending, /response lost/);
  const second = browser(s),
    restored = rules.readJournalRecovery(s, scope),
    recovery = second.execute(scope, restored);
  await second.flush();
  assert.deepEqual(
    JSON.parse(JSON.stringify(second.requests[0].input)),
    JSON.parse(JSON.stringify(first.requests[0].input)),
  );
  second.requests[0].resolve({ success: true, data: prepared() });
  assert.deepEqual(await recovery, { id: id(20), status: "pending" });
  assert.equal(rules.readJournalRecovery(s, scope), null);
});
test("committed approval absent from the pending queue can recover from saved decision/note; forged receipt preserves recovery", async () => {
  const s = storage(),
    record = review();
  rules.persistJournalRecovery(s, scope, record);
  const b = browser(s),
    attempt = b.execute(scope, rules.readJournalRecovery(s, scope));
  await b.flush();
  assert.equal(b.requests[0].kind, "review");
  assert.equal(b.requests[0].input.note, record.request.note);
  b.requests[0].resolve({
    success: true,
    data: reviewed({ proposalId: id(31) }),
  });
  await assert.rejects(attempt);
  assert.deepEqual(rules.readJournalRecovery(s, scope), record);
  const cold = browser(s),
    retry = cold.execute(scope, rules.readJournalRecovery(s, scope));
  await cold.flush();
  cold.requests[0].resolve({ success: true, data: reviewed() });
  assert.deepEqual(await retry, { id: id(30), status: "posted" });
  assert.equal(rules.readJournalRecovery(s, scope), null);
});
test("clear failures retain a confirmed request, and matching receipt retries never erase a newer attempt", async () => {
  const s = storage(),
    b = browser(s),
    record = preparation();
  const pending = b.execute(scope, record);
  await b.flush();
  s.failClear(true);
  b.requests[0].resolve({ success: true, data: prepared() });
  await assert.rejects(pending, /clear denied/);
  assert.deepEqual(rules.readJournalRecovery(s, scope), record);
  s.failClear(false);
  const next = b.execute(scope, record);
  await b.flush();
  s.rows.set(rules.journalRecoveryKey(scope), JSON.stringify(preparation(11)));
  b.requests[1].resolve({ success: true, data: prepared() });
  await assert.rejects(next, /Another journal/);
  assert.equal(rules.readJournalRecovery(s, scope).request.intentId, id(11));
});
test("cross-tab lock serializes conflicting requests so an uncertain first attempt cannot be replaced or sent again under another identity", async () => {
  const s = storage(),
    locks = new Map(),
    one = browser(s, locks),
    two = browser(s, locks),
    first = one.execute(scope, preparation()),
    second = two.execute(scope, preparation(11));
  const rejection = assert.rejects(second, /previous journal/);
  await one.flush();
  assert.equal(one.requests.length, 1);
  assert.equal(two.requests.length, 0);
  one.requests[0].resolve({ success: false, error: "Original result unknown" });
  await assert.rejects(first, /unknown/);
  await rejection;
  assert.equal(two.requests.length, 0);
  assert.equal(rules.readJournalRecovery(s, scope).request.intentId, id(10));
});
test("scope/decision/money references must match before any confirmed recovery can be cleared", () => {
  for (const changed of [
    { orgId: id(9) },
    { reviewerId: id(9) },
    { status: "rejected" },
    { journal_entry_id: null },
    { reversal_entry_id: id(40) },
  ])
    assert.throws(() =>
      rules.validateJournalRecoveryReceipt(scope, review(), reviewed(changed)),
    );
  assert.throws(
    () =>
      rules.persistJournalRecovery(storage(), scope, {
        ...preparation(),
        request: {
          ...preparation().request,
          lines: preparation().request.lines.map((l, i) =>
            i ? l : { ...l, debitCents: 1 },
          ),
        },
      }),
    /not balanced/,
  );
});
function recoveryPanel(store) {
  const slots = [],
    effects = [],
    listeners = new Map(),
    requests = [],
    blocked = [];
  let cursor = 0,
    completed = 0;
  const compiled = { exports: {} };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (v) => (slots[i].value = v)];
    },
    useRef(value) {
      const i = cursor++;
      slots[i] ??= { current: value };
      return slots[i];
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
  };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/journal-recovery.tsx", "utf8"),
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
      window: {
        localStorage: store,
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name),
      },
      require(name) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime")
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          };
        if (name === "@/lib/services/books/journal-recovery") return rules;
        if (name === "@/lib/utils")
          return {
            formatMoneyCentsExact: (value) => `$${(value / 100).toFixed(2)}`,
          };
        if (name === "@/lib/services/books/journal-recovery-client")
          return {
            JOURNAL_RECOVERY_EVENT: "journal-changed",
            executeJournalRecovery: (owner, record) =>
              new Promise((resolve, reject) =>
                requests.push({
                  record,
                  resolve: () => {
                    try {
                      rules.clearJournalRecovery(store, owner, record);
                      resolve({ id: id(20), status: "pending" });
                    } catch (e) {
                      reject(e);
                    }
                  },
                  reject,
                }),
              ),
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
  const props = {
      scope,
      onRecovered: () => completed++,
      onBlockedChange: (value) => blocked.push(value),
    },
    render = () => {
      cursor = 0;
      return compiled.exports.JournalRecoveryPanel(props);
    };
  return {
    render,
    nodes,
    requests,
    blocked,
    completed: () => completed,
    mount() {
      render();
      effects[0]();
    },
    event: (name, value) => listeners.get(name)(value),
    flush: async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}
test("cold recovery panel displays original human-readable lines and confirms only after matching request cleanup", async () => {
  const s = storage();
  rules.persistJournalRecovery(s, scope, preparation());
  const panel = recoveryPanel(s);
  panel.mount();
  assert.equal(panel.blocked.at(-1), true);
  const tree = panel.render(),
    text = JSON.stringify(tree);
  assert.ok(text.includes("Original accrual"));
  assert.ok(text.includes("$125.00"));
  assert.ok(text.includes("Concrete"));
  assert.equal(text.includes("expectedActorId"), false);
  const button = panel.nodes(
    tree,
    (n) =>
      n.type === "Button" && n.props.children === "Recover original request",
  )[0];
  button.props.onClick();
  button.props.onClick();
  assert.equal(panel.requests.length, 1);
  assert.deepEqual(panel.requests[0].record, preparation());
  panel.requests[0].resolve();
  await panel.flush();
  assert.equal(panel.completed(), 1);
  assert.equal(panel.blocked.at(-1), false);
  assert.equal(panel.render(), null);
});
test("a corrupt cross-tab recovery change clears old actionable cards and blocks new submissions without deleting the saved request", () => {
  const s = storage();
  rules.persistJournalRecovery(s, scope, review());
  const panel = recoveryPanel(s);
  panel.mount();
  assert.ok(
    JSON.stringify(panel.render()).includes("Checked original allocation"),
  );
  s.rows.set(rules.journalRecoveryKey(scope), "corrupt record");
  panel.event("storage", { key: rules.journalRecoveryKey(scope) });
  const tree = panel.render();
  assert.equal(
    panel.nodes(
      tree,
      (n) =>
        n.type === "Button" && n.props.children === "Recover original request",
    ).length,
    0,
  );
  assert.ok(panel.nodes(tree, (n) => n.props.role === "alert").length);
  assert.equal(panel.blocked.at(-1), true);
  assert.equal(s.rows.get(rules.journalRecoveryKey(scope)), "corrupt record");
});
test("uncertain resolution keeps its original saved nonce and reason across a fresh runtime, then clears only a matching resolution receipt", async () => {
  const s = storage(),
    record = preparation();
  rules.persistJournalRecovery(s, scope, record);
  const one = browser(s),
    choice = { id: id(70), reason: "Original submission no longer needed" },
    pending = one.resolve(scope, record, choice);
  await one.flush();
  const saved = rules.readJournalRecovery(s, scope);
  assert.deepEqual(saved.resolution, choice);
  one.requests[0].resolve({
    success: false,
    error: "Resolution response lost",
  });
  await assert.rejects(pending, /response lost/);
  assert.throws(
    () =>
      rules.persistJournalResolution(s, scope, saved, {
        id: id(71),
        reason: choice.reason,
      }),
    /original saved resolution/,
  );
  const cold = browser(s),
    retry = cold.resolve(scope, saved, saved.resolution);
  await cold.flush();
  assert.equal(cold.requests[0].input.resolutionId, id(70));
  assert.equal(cold.requests[0].input.reason, choice.reason);
  cold.requests[0].resolve({
    success: true,
    data: {
      orgId: scope.orgId,
      actorId: scope.actorId,
      id: id(70),
      kind: "prepare",
      requestText: JSON.stringify(record.request),
      resolution: "cancelled_preparation",
      created: false,
    },
  });
  await retry;
  assert.equal(rules.readJournalRecovery(s, scope), null);
});
