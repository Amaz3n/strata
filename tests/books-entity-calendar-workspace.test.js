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
  const year = {
    id: id(30),
    org_id: id(1),
    legal_entity_id: id(10),
    profile_id: id(20),
    starts_in_year: 2026,
    starts_on: "2026-07-01",
    ends_on: "2027-06-30",
    prepared_by: own ? id(2) : id(3),
    preparation_notes: "Original fiscal preparation evidence",
  };
  const page = {
    years: [year],
    periods: Array.from({ length: 12 }, (_, i) => ({
      id: id(50 + i),
      calendar_year_id: year.id,
      period_number: i + 1,
      starts_on: "2026-07-01",
      ends_on: "2026-07-31",
    })),
    reviews: reviewed
      ? [
          {
            id: id(40),
            calendar_year_id: year.id,
            review_notes: "Original separate review",
          },
        ]
      : [],
    nextCursor: null,
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
    listBooksEntityCalendarsAction: async () =>
      loadFail
        ? { success: false, error: "Read access revoked" }
        : { success: true, data: page },
    prepareBooksEntityCalendarAction: async (body) => {
      calls.push(["prepare", body]);
      return fail
        ? { success: false, error: "Outcome uncertain" }
        : { success: true, data: {} };
    },
    reviewBooksEntityCalendarAction: async (body) => {
      calls.push(["review", body]);
      return fail
        ? { success: false, error: "Outcome uncertain" }
        : { success: true, data: {} };
    },
  };
  const compiled = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync("components/books/entity-calendars.tsx", "utf8"),
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
    return compiled.exports.BooksEntityCalendars(props);
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
test("calendar workspace shows original periods and reuses preparation identity and notes on uncertain retry", async () => {
  const h = harness();
  await h.mount();
  let tree = h.render();
  assert.equal(
    h.nodes(tree, (n) => n.type === "tbody")[0].props.children.length,
    12,
  );
  const form = h.nodes(tree, (n) => n.type === "form")[0],
    body = {
      year: "2026",
      notes: "Original preparation with supporting evidence",
    };
  await h.submit(form, body);
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[0], body);
  assert.equal(h.calls[0][1].calendarId, h.calls[1][1].calendarId);
  assert.equal(h.calls[1][1].profileId, id(20));
  assert.equal(h.calls[1][1].notes, body.notes);
  assert.ok(h.notices.includes("Outcome uncertain"));
});
test("independent calendar reviewer retries original decision while makers and reviewed records have no approval form", async () => {
  const h = harness();
  await h.mount();
  const forms = h.nodes(h.render(), (n) => n.type === "form"),
    body = { notes: "Checked all original dates and entity profile" };
  await h.submit(forms[1], body);
  await h.submit(h.nodes(h.render(), (n) => n.type === "form")[1], body);
  assert.equal(h.calls[0][1].reviewId, h.calls[1][1].reviewId);
  assert.equal(h.calls[0][1].calendarId, id(30));
  for (const options of [{ own: true }, { reviewed: true }]) {
    const v = harness(options);
    await v.mount();
    assert.equal(v.nodes(v.render(), (n) => n.type === "form").length, 1);
  }
});
test("revoked read refresh removes stale calendar controls and unreviewed identity cannot prepare a year", async () => {
  const h = harness();
  await h.mount();
  h.setLoadFailure();
  const refresh = h.nodes(
    h.render(),
    (n) => n.type === "Button" && n.props.children === "Refresh calendars",
  )[0];
  await h.click(refresh);
  const tree = h.render();
  assert.equal(h.nodes(tree, (n) => n.type === "form").length, 0);
  assert.ok(JSON.stringify(tree).includes("Read access revoked"));
  const no = harness();
  no.props.profileId = null;
  await no.mount();
  assert.equal(
    no.nodes(no.render(), (n) => n.type === "form").length,
    1,
    "only existing independent-review form, no preparation",
  );
});

test("calendar preparation sends the selected retained reviewed identity for historical years", async () => {
  const h = harness();
  h.props.profiles = [
    { id: id(20), label: "Current reviewed identity" },
    { id: id(21), label: "Earlier reviewed fiscal identity" },
  ];
  await h.mount();
  const tree = h.render();
  assert.equal(
    h.nodes(tree, (n) => n.type === "select" && n.props.name === "profile")
      .length,
    1,
  );
  await h.submit(h.nodes(tree, (n) => n.type === "form")[0], {
    profile: id(21),
    year: "2026",
    notes: "Original historical fiscal calendar evidence",
  });
  assert.equal(h.calls[0][1].profileId, id(21));
});
