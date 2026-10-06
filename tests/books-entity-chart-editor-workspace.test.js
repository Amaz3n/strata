require("../scripts/register-ts-node-test");
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
  const {
    constructionEntityChart,
  } = require("../lib/services/books/entity-chart");
  const definition = constructionEntityChart();
  const context = {
    orgId: id(1),
    entityId: id(10),
    latestReviewedChartId: reviewed ? id(30) : null,
    latestReviewedEffectiveOn: reviewed ? "2026-01-01" : null,
    profiles: [
      {
        id: id(20),
        revision: 2,
        effective_on: "2026-01-01",
        legal_name: "Builder LLC",
      },
    ],
    nextProfileCursor: 2,
    ledgerActivated: false,
  };
  const detail = {
    chart: { definition_text: JSON.stringify(definition) },
    review: { id: id(40) },
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
    readBooksEntityChartEditorContextAction: async (body) =>
      loadFail
        ? { success: false, error: "Read access revoked" }
        : {
            success: true,
            data: body.before
              ? {
                  ...context,
                  profiles: [
                    {
                      id: id(21),
                      revision: 1,
                      effective_on: "2025-01-01",
                      legal_name: "Original Builder LLC",
                    },
                  ],
                  nextProfileCursor: null,
                }
              : context,
          },
    readBooksEntityChartAction: async () => ({ success: true, data: detail }),
    prepareBooksEntityChartAction: async (body) => {
      calls.push(["prepare", body]);
      return fail
        ? { success: false, error: "Outcome uncertain" }
        : { success: true, data: {} };
    },
  };
  const compiled = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/entity-chart-editor.tsx", "utf8"),
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
        if (name.startsWith("@/lib/services/books/"))
          return require("../lib/services/books/" + name.split("/").at(-1));
        if (name === "zod") return require("zod");
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
    onPrepared: async () => {},
  };
  function nodes(tree, p, out = []) {
    if (!tree || typeof tree !== "object") return out;
    if (p(tree)) out.push(tree);
    for (const x of [tree.props?.children].flat(Infinity)) nodes(x, p, out);
    return out;
  }
  const render = () => {
    cursor = 0;
    return compiled.exports.BooksEntityChartEditor(props);
  };
  return {
    render,
    nodes,
    calls,
    notices,
    props,

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

test("editor sends selected historical profile and reviewed predecessor, retaining exact retry identity", async () => {
  const h = harness({ reviewed: true });
  await h.mount();
  let form = h.nodes(h.render(), (n) => n.type === "form")[0];
  const body = {
    profile: id(21),
    effective: "2027-01-01",
    notes: "Reviewed historical profile and original mappings",
  };
  await h.submit(form, body);
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[0], body);
  assert.equal(h.calls[0][1].chartId, h.calls[1][1].chartId);
  assert.equal(h.calls[0][1].profileId, id(21));
  assert.equal(h.calls[0][1].previousChartId, id(30));
  assert.ok(h.calls[0][1].definition.accounts.length > 40);
});
test("account code edits preserve draft parent and control references; invalid controls block preparation", async () => {
  const h = harness();
  await h.mount();
  const code = h.nodes(
    h.render(),
    (n) => n.props["aria-label"] === "Account 1 code",
  )[0];
  code.props.onChange({ target: { value: "Bank Main" } });
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[0], {
    profile: id(20),
    effective: "2026-01-01",
    notes: "Custom operating cash mapped explicitly",
  });
  assert.equal(h.calls[0][1].definition.accounts[0].code, "Bank Main");
  assert.equal(h.calls[0][1].definition.controls.operatingCash, "Bank Main");
  const kind = h.nodes(
    h.render(),
    (n) => n.props["aria-label"] === "Account 1 classification",
  )[0];
  kind.props.onChange({ target: { value: "other_expense" } });
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[0], {
    profile: id(20),
    effective: "2026-01-01",
    notes: "Incompatible cash classification",
  });
  assert.equal(h.calls.length, 1);
  assert.ok(JSON.stringify(h.render()).includes("incompatible"));
});
test("editor pages retained identities and clears stale preparation after revoked context", async () => {
  const h = harness();
  await h.mount();
  await h.click(
    h.nodes(
      h.render(),
      (n) => n.props.children === "Load older reviewed identities",
    )[0],
  );
  assert.ok(JSON.stringify(h.render()).includes("Original Builder LLC"));
  h.setLoadFailure();
  await h.click(
    h.nodes(h.render(), (n) => n.props.children === "Reload reviewed chart")[0],
  );
  assert.equal(h.nodes(h.render(), (n) => n.type === "form").length, 0);
});
