const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
const id = (n) => "88300000-0000-4000-8000-" + String(n).padStart(12, "0");
function harness({ own = false, reviewed = false } = {}) {
  const slots = [],
    effects = [],
    tasks = [],
    calls = [],
    notices = [];
  let cursor = 0,
    fail = true,
    loadFail = false;
  const chart = {
    id: id(30),
    effective_on: "2026-01-01",
    prepared_by: own ? id(2) : id(3),
    preparation_notes: "Original chart preparation evidence",
  };
  const page = {
    charts: [chart],
    reviews: reviewed ? [{ chart_id: chart.id }] : [],
    nextCursor: null,
  };
  const detail = {
    chart,
    accounts: [{ id: id(50), code: "1000" }],
    definitions: [
      {
        account_id: id(50),
        name: "Cash",
        account_type: "asset",
        subtype: "cash",
        normal_balance: "debit",
      },
    ],
    controls: [{ id: id(60), role: "operatingCash", account_id: id(50) }],
    review: reviewed
      ? {
          reviewed_at: "2026-10-04",
          review_notes: "Original independent review",
        }
      : null,
  };
  const hooks = {
    useState(initial) {
      const n = cursor++;
      slots[n] ??= { value: initial };
      return [slots[n].value, (v) => (slots[n].value = v)];
    },
    useRef(initial) {
      const n = cursor++;
      slots[n] ??= { current: initial };
      return slots[n];
    },
    useEffect: (fn) => effects.push(fn),
    useTransition: () => [
      false,
      (fn) => {
        const task = Promise.resolve().then(fn);
        tasks.push(task);
      },
    ],
  };
  const api = {
    readBooksEntityChartAction: async () => ({ success: true, data: detail }),
    listBooksEntityChartsAction: async () =>
      loadFail
        ? { success: false, error: "Read access revoked" }
        : { success: true, data: page },
    prepareBooksEntityChartAction: async (body) => {
      calls.push(["prepare", body]);
      return fail
        ? { success: false, error: "Outcome uncertain" }
        : { success: true, data: {} };
    },
    reviewBooksEntityChartAction: async (body) => {
      calls.push(["review", body]);
      return fail
        ? { success: false, error: "Outcome uncertain" }
        : { success: true, data: {} };
    },
  };
  const compiled = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/entity-charts.tsx", "utf8"),
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
      crypto: { randomUUID: () => id(90 + calls.length) },
      FormData: class {
        constructor(form) {
          this.form = form;
        }
        get(name) {
          return this.form[name];
        }
      },
      require(name) {
        if (name === "@/lib/services/books/entity-chart")
          return {
            constructionEntityChart: () => ({
              classification_version: 1,
              accounts: [],
              controls: {},
            }),
          };
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime")
          return {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          };
        if (name === "sonner")
          return {
            toast: {
              error: (v) => notices.push(v),
              success: (v) => notices.push(v),
            },
          };
        if (name === "@/app/(app)/books/actions") return api;
        return new Proxy({}, { get: (_, k) => k });
      },
    },
  );
  const props = {
    entityId: id(10),
    profileId: id(20),
    actorId: id(2),
    canPrepare: true,
    canReview: true,
    today: "2026-10-04",
  };
  function nodes(tree, p, out = []) {
    if (!tree || typeof tree !== "object") return out;
    if (p(tree)) out.push(tree);
    for (const x of [tree.props?.children].flat(Infinity)) nodes(x, p, out);
    return out;
  }
  const render = () => {
    cursor = 0;
    return compiled.exports.BooksEntityCharts(props);
  };
  return {
    render,
    nodes,
    calls,
    notices,
    props,
    clearCharts() {
      page.charts = [];
    },
    async mount() {
      render();
      effects[0]();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async submit(node, form) {
      node.props.onSubmit({ preventDefault() {}, currentTarget: form });
      await Promise.all(tasks.splice(0));
    },
    setFailure(v) {
      fail = v;
    },
    setLoadFailure() {
      loadFail = true;
    },
    async click(node) {
      node.props.onClick();
      await Promise.all(tasks.splice(0));
    },
  };
}

test("chart workspace exposes the configurable editor only to entity preparers with a reviewed identity", async () => {
  const h = harness();
  await h.mount();
  assert.equal(
    h.nodes(h.render(), (n) => n.type === "BooksEntityChartEditor").length,
    1,
  );
  h.props.canPrepare = false;
  assert.equal(
    h.nodes(h.render(), (n) => n.type === "BooksEntityChartEditor").length,
    0,
  );
  h.props.canPrepare = true;
  h.props.profileId = null;
  assert.equal(
    h.nodes(h.render(), (n) => n.type === "BooksEntityChartEditor").length,
    0,
  );
});
test("chart inspectors show original accounts and independent approval retries preserve intent", async () => {
  const h = harness();
  await h.mount();
  await h.click(
    h.nodes(h.render(), (n) => n.props.children === "Inspect accounts")[0],
  );
  let form = h.nodes(h.render(), (n) => n.type === "form")[0];
  const body = { notes: "Checked original account classifications" };
  await h.submit(form, body);
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[0], body);
  assert.equal(h.calls[0][1].reviewId, h.calls[1][1].reviewId);
  assert.equal(h.calls[0][1].chartId, id(30));
  for (const opts of [{ own: true }, { reviewed: true }]) {
    const v = harness(opts);
    await v.mount();
    await v.click(
      v.nodes(v.render(), (n) => n.props.children === "Inspect accounts")[0],
    );
    assert.equal(v.nodes(v.render(), (n) => n.type === "form").length, 0);
  }
});
test("revoked chart read refresh removes stale inspection and approval controls", async () => {
  const h = harness();
  await h.mount();
  await h.click(
    h.nodes(h.render(), (n) => n.props.children === "Inspect accounts")[0],
  );
  h.setLoadFailure();
  await h.click(
    h.nodes(h.render(), (n) => n.props.children === "Refresh charts")[0],
  );
  assert.equal(h.nodes(h.render(), (n) => n.type === "form").length, 0);
  assert.ok(JSON.stringify(h.render()).includes("Read access revoked"));
});
