require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-entity-chart-database");
const {
  constructionEntityChart,
  entityChartDefinitionSchema,
} = require("../lib/services/books/entity-chart");
test("entity chart has independently owned canonical account IDs, complete frozen controls and exact receipt retries", async (t) => {
  const f = await setup(t),
    p = await f.prepare();
  assert.equal(p.ledgerActivated, false);
  assert.deepEqual(await f.prepare(), p);
  await f.review();
  assert.equal(
    await f.rpc("books_assert_entity_chart_receipt", [id(30)]),
    true,
  );
  assert.deepEqual(await f.review(), await f.review());
  const original = (await f.db.query("select * from gl_accounts")).rows;
  await f.create(id(11), id(21));
  await f.prepare({ entity: id(11), profile: id(21), id: id(31) });
  await f.review({ entity: id(11), chart: id(31), id: id(41) });
  const a = (
    await f.db.query(
      "select id,legal_entity_id from books_entity_accounts where code='1000' order by legal_entity_id",
    )
  ).rows;
  assert.equal(a.length, 2);
  assert.notEqual(a[0].id, a[1].id);
  assert.deepEqual(
    (await f.db.query("select * from gl_accounts")).rows,
    original,
  );
  await assert.rejects(
    f.prepare({ notes: notes + " changed" }),
    /retry differs/,
  );
  await assert.rejects(
    f.db.exec("update books_entity_accounts set code='CHANGED'"),
    /immutable/,
  );
});
test("invalid classifications, control roles and hierarchy cannot create incomplete entity charts", async (t) => {
  const f = await setup(t);
  for (const change of [
    (d) => (d.accounts[0].normal_balance = "credit"),
    (d) => (d.accounts[0].subtype = "unknown"),
    (d) => delete d.controls.accountsReceivable,
    (d) => (d.controls.accountsReceivable = "1000"),
    (d) => d.accounts.push({ ...d.accounts[0] }),
    (d) => (d.accounts[0].parent_code = "1000"),
  ]) {
    const d = constructionEntityChart();
    change(d);
    assert.equal(entityChartDefinitionSchema.safeParse(d).success, false);
    await assert.rejects(f.prepare({ definition: d }));
  }
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_entity_chart_versions",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from books_entity_accounts"))
      .rows[0].n,
    0,
  );
});
test("reviewed versions preserve canonical identities and old names while stale competing predecessors and self review are rejected", async (t) => {
  const f = await setup(t),
    definition = constructionEntityChart();
  await f.prepare();
  await f.prepare({ id: id(31), effective: "2027-01-01" });
  await assert.rejects(f.review({ actor: maker }), /independent/);
  await f.review();
  await assert.rejects(f.review({ chart: id(31), id: id(41) }), /stale/);
  definition.accounts[0].name = "New approved operating cash label";
  await f.prepare({
    id: id(32),
    effective: "2027-01-01",
    previous: id(30),
    definition,
  });
  await f.review({ chart: id(32), id: id(42) });
  const rows = (
    await f.db.query(
      "select d.chart_id,d.account_id,d.name from books_entity_account_definitions d join books_entity_accounts a on a.id=d.account_id where a.code='1000' order by d.chart_id",
    )
  ).rows;
  assert.equal(new Set(rows.map((r) => r.account_id)).size, 1);
  assert.notEqual(rows[0].name, rows.at(-1).name);
  assert.deepEqual(await f.prepare(), await f.prepare());
});
test("incomplete raw chart commits and altered raw child inserts are refused with private invoker RPCs", async (t) => {
  const f = await setup(t),
    d = constructionEntityChart();
  await assert.rejects(
    f.db.query(
      "insert into books_entity_chart_versions values($1,$2,$3,$4,null,$5,$6,$7,$8,now(),$1,$9)",
      [
        id(30),
        org,
        entity,
        id(20),
        "2026-01-01",
        JSON.stringify(d),
        "0".repeat(64),
        maker,
        notes,
      ],
    ),
    /differ|frozen/,
  );
  await f.prepare();
  await assert.rejects(
    f.db.query(
      "insert into books_entity_accounts(org_id,legal_entity_id,code,first_chart_id) values($1,$2,'INVENTED',$3)",
      [org, entity, id(30)],
    ),
    /frozen/,
  );
  const acl = (
    await f.db.query(
      "select has_function_privilege('authenticated','prepare_books_entity_chart(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text)','execute') rpc,has_table_privilege('authenticated','books_entity_accounts','insert') write",
    )
  ).rows[0];
  assert.deepEqual(acl, { rpc: false, write: false });
});

test("original chart history survives relational restoration and rejects corrupted provenance", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  const {
    ENTITY_CHART_TABLES,
    verifyEntityChartArchive,
  } = require("../lib/services/books/entity-chart-archive");
  const registry = [
    "books_legal_entities",
    "books_legal_entity_members",
    "books_legal_entity_access_history",
    "books_legal_entity_profiles",
    "books_legal_entity_profile_reviews",
  ];
  const tables = {};
  for (const table of [...ENTITY_CHART_TABLES, ...registry])
    tables[table] = (
      await f.db.query(`select to_jsonb(r) value from ${table} r`)
    ).rows.map((r) => r.value);
  assert.deepEqual(verifyEntityChartArchive(tables, org, 22), []);
  const {
    EXPORT_TABLES,
    BOOKS_EXPORT_SCHEMA_VERSION,
    verifyBooksExportBundle,
  } = require("../lib/services/books/export-contract");
  const { booksDigest } = require("../lib/services/books/hash");
  function bundle(tables) {
    return {
      tables: Object.fromEntries(
        EXPORT_TABLES.map((t) => [t, tables[t] ?? []]),
      ),
      manifest: {
        schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
        orgId: org,
        legalEntityIds: [entity],
        tables: Object.fromEntries(
          EXPORT_TABLES.map((t) => [
            t,
            {
              rows: (tables[t] ?? []).length,
              checksum: booksDigest(tables[t] ?? []),
            },
          ]),
        ),
        supportingFiles: [],
        supportingHistoricalFiles: [],
      },
    };
  }
  assert.equal(
    verifyBooksExportBundle(bundle(tables)).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle(tables))),
  );

  assert.ok(verifyEntityChartArchive(tables, org, 21).length);
  for (const corrupt of [
    (x) => (x.books_entity_account_definitions[0].name = "Changed"),
    (x) => (x.books_entity_control_accounts[0].account_id = id(999)),
    (x) => (x.books_entity_chart_reviews[0].reviewed_by = maker),
    (x) => (x.books_entity_accounts[0].legal_entity_id = id(999)),
    (x) =>
      (x.books_entity_chart_versions[0].prepared_access_event_id = id(999)),
  ]) {
    const x = structuredClone(tables);
    corrupt(x);
    assert.ok(verifyEntityChartArchive(x, org, 22).length);
  }
  const other = await setup(t);
  const order = [...registry, ...ENTITY_CHART_TABLES];
  await other.db.exec("begin; set constraints all deferred");
  for (const table of order)
    await other.db.exec(`alter table ${table} disable trigger user`);
  for (const table of [...order].reverse())
    await other.db.exec(`delete from ${table}`);
  for (const table of order)
    for (const row of tables[table]) {
      const keys = Object.keys(row);
      await other.db.query(
        `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
        keys.map((k) => row[k]),
      );
    }
  for (const table of order)
    await other.db.exec(`alter table ${table} enable trigger user`);
  await other.db.exec("commit");
  const restored = {};
  for (const table of order)
    restored[table] = (
      await other.db.query(
        `select to_jsonb(r) value from ${table} r order by id`,
      )
    ).rows.map((r) => r.value);
  assert.deepEqual(verifyEntityChartArchive(restored, org, 22), []);
  assert.equal(
    verifyBooksExportBundle(bundle(restored)).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle(restored))),
  );

  assert.equal(
    await other.rpc("books_assert_entity_chart_receipt", [id(30)]),
    true,
  );
  const detail = await f.rpc("read_books_entity_chart", [
    org,
    entity,
    id(30),
    reviewer,
  ]);
  assert.equal(detail.chart.id, id(30));
  assert.equal(detail.accounts.length, tables.books_entity_accounts.length);
  const page = await f.rpc("read_books_entity_charts", [
    org,
    entity,
    reviewer,
    null,
    1,
  ]);
  assert.equal(page.charts.length, 1);
  assert.equal(page.charts[0].definition_text, undefined);
  assert.equal(page.nextCursor, null);
  await assert.rejects(
    f.rpc("read_books_entity_chart", [org, id(999), id(30), reviewer]),
    /access/,
  );
  await other.prepare({
    id: id(32),
    previous: id(30),
    effective: "2027-01-01",
  });
  await other.review({ chart: id(32), id: id(42) });
});
test("chart services gate authorization before RPC and verify exact chart bodies, hashes and scoped read receipts", async (t) => {
  const f = await setup(t),
    prepared = await f.prepare(),
    detail = await f.rpc("read_books_entity_chart", [
      org,
      entity,
      id(30),
      maker,
    ]),
    page = await f.rpc("read_books_entity_charts", [
      org,
      entity,
      maker,
      null,
      50,
    ]);
  const editorContext = await f.rpc("read_books_entity_chart_editor_context", [
    org,
    entity,
    maker,
    null,
    50,
  ]);
  const Module = require("node:module"),
    load = Module._load,
    file = require.resolve("../lib/services/books/legal-entities");
  let denied = false,
    corrupt = false,
    calls = 0;
  const permissions = [];
  const server = {
    rpc: async (name) => {
      calls++;
      const data = structuredClone(
        name === "prepare_books_entity_chart"
          ? prepared
          : name === "read_books_entity_chart"
            ? detail
            : name === "read_books_entity_chart_editor_context"
              ? editorContext
              : page,
      );
      if (corrupt) {
        if (data.chart) data.chart.definition_sha256 = "0".repeat(64);
        else if (data.charts) data.charts[0].legal_entity_id = id(999);
        else data.profiles[0].revision = -1;
      }
      return { data, error: null };
    },
  };
  delete require.cache[file];
  Module._load = function (name, ...args) {
    if (name === "@/lib/services/context")
      return {
        requireOrgContext: async () => ({
          orgId: org,
          userId: maker,
          supabase: {},
        }),
      };
    if (name === "@/lib/services/books/access")
      return {
        requireBooksAuthorization: async (v) => {
          permissions.push(v.permission);
          if (denied) throw Error("Books access denied");
        },
      };
    if (name === "@/lib/supabase/server")
      return { createServiceSupabaseClient: () => server };
    return load.call(this, name, ...args);
  };
  let api;
  try {
    api = require(file);
  } finally {
    Module._load = load;
    delete require.cache[file];
  }
  const body = {
    entityId: entity,
    chartId: id(30),
    profileId: id(20),
    previousChartId: null,
    effectiveOn: "2026-01-01",
    definition: constructionEntityChart(),
    notes,
  };
  assert.equal((await api.prepareBooksEntityChart(body)).chart.id, id(30));
  assert.equal(
    (await api.readBooksEntityChart({ entityId: entity, chartId: id(30) }))
      .chart.id,
    id(30),
  );
  assert.equal(
    (await api.listBooksEntityCharts({ entityId: entity })).charts.length,
    1,
  );
  assert.equal(
    (await api.readBooksEntityChartEditorContext({ entityId: entity }))
      .profiles[0].id,
    id(20),
  );
  assert.deepEqual(permissions, [
    "books.manage",
    "books.read",
    "books.read",
    "books.read",
  ]);
  corrupt = true;
  await assert.rejects(api.prepareBooksEntityChart(body));
  await assert.rejects(
    api.readBooksEntityChart({ entityId: entity, chartId: id(30) }),
  );
  await assert.rejects(api.listBooksEntityCharts({ entityId: entity }));
  await assert.rejects(
    api.readBooksEntityChartEditorContext({ entityId: entity }),
  );
  denied = true;
  const before = calls;
  await assert.rejects(api.prepareBooksEntityChart(body), /denied/);
  assert.equal(calls, before);
});
test("chart editor context resolves the reviewed head outside a paged chart list and retains historical profile choices", async (t) => {
  const f = await setup(t);
  await f.prepare();
  let context = await f.rpc("read_books_entity_chart_editor_context", [
    org,
    entity,
    maker,
    null,
    50,
  ]);
  assert.equal(context.latestReviewedChartId, null);
  assert.equal(context.profiles[0].id, id(20));
  await f.review();
  await f.prepare({ id: id(31), previous: id(30), effective: "2027-01-01" });
  context = await f.rpc("read_books_entity_chart_editor_context", [
    org,
    entity,
    maker,
    null,
    1,
  ]);
  assert.equal(context.latestReviewedChartId, id(30));
  assert.equal(context.latestReviewedEffectiveOn, "2026-01-01");
  const first = await f.rpc("read_books_entity_charts", [
    org,
    entity,
    maker,
    id(30),
    1,
  ]);
  assert.equal(first.charts[0].id, id(31));
  assert.equal(first.reviews.length, 0);
  assert.equal(context.latestReviewedChartId, id(30));
  assert.deepEqual(
    (
      await f.rpc("read_books_entity_chart_editor_context", [
        org,
        entity,
        maker,
        1,
        50,
      ])
    ).profiles,
    [],
  );
  await assert.rejects(
    f.rpc("read_books_entity_chart_editor_context", [
      org,
      id(999),
      maker,
      null,
      50,
    ]),
    /access/,
  );
  await assert.rejects(
    f.rpc("read_books_entity_chart_editor_context", [
      org,
      entity,
      maker,
      null,
      51,
    ]),
    /Invalid/,
  );
  assert.equal(
    (
      await f.db.query(
        "select has_function_privilege('authenticated','read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer)','execute') allowed",
      )
    ).rows[0].allowed,
    false,
  );
});
