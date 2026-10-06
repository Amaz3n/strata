require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const {
  ENTITY_CALENDAR_TABLES,
  entityMonthBoundary,
  verifyEntityCalendarArchive,
} = require("../lib/services/books/entity-calendars");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const {
  LEGAL_ENTITY_ARCHIVE_TABLES,
} = require("../lib/services/books/legal-entity-archive");
const { booksDigest } = require("../lib/services/books/hash");
const id = (n) => "88300000-0000-4000-8000-" + String(n).padStart(12, "0"),
  org = id(1),
  entity = id(10),
  maker = id(2),
  reviewer = id(3),
  notes = "Reviewed fiscal calendar with original entity evidence";
const read = (name) => fs.readFileSync("supabase/migrations/" + name, "utf8");
async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${org}'),('${id(9)}');insert into app_users values('${maker}'),('${reviewer}'),('${id(4)}');insert into memberships values('${org}','${maker}','active'),('${org}','${reviewer}','active'),('${org}','${id(4)}','active');`,
  );
  const foundation = read("20260801143926_books_accounting_foundation.sql"),
    start = foundation.indexOf("create table public.books_exports (");
  await db.exec(foundation.slice(start, foundation.indexOf("\n);", start) + 4));
  await db.exec(read("20261004170526_books_native_legal_entity_registry.sql"));
  await db.exec(read("20261004172415_books_legal_entity_archive_identity.sql"));
  await db.exec(
    `create or replace function capture_books_export_snapshot(p_org_id uuid) returns jsonb language sql stable as $$select jsonb_build_object('orgId',p_org_id,'tables','{}'::jsonb)$$;`,
  );
  await db.exec(read("20261004215338_books_entity_fiscal_calendars.sql"));
  const rpc = async (name, args) =>
    (
      await db.query(
        `select ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`,
        args,
      )
    ).rows[0].r;
  const create = async (e = entity, month = 1, day = 31, profile = id(20)) => {
    await rpc("create_books_legal_entity", [
      org,
      e,
      "ENTITY_" + e.slice(-3),
      maker,
      notes,
    ]);
    await rpc("set_books_legal_entity_member", [
      org,
      e,
      maker,
      reviewer,
      "review",
      notes,
    ]);
    await rpc("prepare_books_legal_entity_profile", [
      org,
      e,
      profile,
      maker,
      null,
      JSON.stringify({
        legal_name: "Builder LLC",
        legal_form: "llc",
        functional_currency: "USD",
        fiscal_start_month: month,
        fiscal_start_day: day,
        effective_on: "2026-01-01",
        identity_evidence: { source: "Retained original legal documents" },
      }),
      notes,
    ]);
    await rpc("review_books_legal_entity_profile", [
      org,
      e,
      profile,
      reviewer,
      notes,
    ]);
  };
  await create();
  const prepare = (over = {}) =>
    rpc("prepare_books_entity_calendar", [
      org,
      over.entity ?? entity,
      over.id ?? id(30),
      over.profile ?? id(20),
      over.actor ?? maker,
      over.year ?? 2026,
      over.notes ?? notes,
    ]);
  const review = (over = {}) =>
    rpc("review_books_entity_calendar", [
      org,
      over.entity ?? entity,
      over.calendar ?? id(30),
      over.id ?? id(40),
      over.actor ?? reviewer,
      over.notes ?? notes,
    ]);
  return { db, rpc, create, prepare, review };
}
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
  for (const table of [
    ...LEGAL_ENTITY_ARCHIVE_TABLES,
    ...ENTITY_CALENDAR_TABLES,
  ])
    tables[table] = (
      await f.db.query(
        `select to_jsonb(r) r from ${table} r where org_id=$1 order by id`,
        [org],
      )
    ).rows.map((x) => x.r);
  return {
    tables,
    manifest: {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((e) => e.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([t, rows]) => [
          t,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: [],
      supportingHistoricalFiles: [],
    },
  };
}
test("anchored entity fiscal calendars have twelve contiguous immutable periods including leap and short months", async (t) => {
  const f = await setup(t),
    p = await f.prepare({ year: 2028 });
  assert.equal(p.ledgerActivated, false);
  assert.equal(p.year.starts_on, "2028-01-31");
  assert.equal(p.periods[0].ends_on, "2028-02-28");
  assert.equal(p.periods[1].starts_on, "2028-02-29");
  assert.equal(p.periods[2].starts_on, "2028-03-31");
  assert.equal(p.year.ends_on, "2029-01-30");
  assert.deepEqual(await f.prepare({ year: 2028 }), p);
  await f.review();
  await assert.rejects(
    f.db.exec("update books_entity_fiscal_periods set ends_on=ends_on+1"),
    /immutable/,
  );
  await assert.rejects(f.prepare({ year: 2027 }), /retry differs/);
  for (const n of [0, 1, 2, 12])
    assert.equal(
      entityMonthBoundary(2028, 1, 31, n),
      (
        await f.db.query(
          "select books_entity_month_boundary(2028,1,31,$1)::text d",
          [n],
        )
      ).rows[0].d,
    );
});
test("independent entity calendars permit matching years while wrong authority, overlap and stale profile are rejected", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await assert.rejects(f.review({ actor: maker }), /independent/);
  await assert.rejects(f.prepare({ actor: id(4), id: id(31) }), /access/);
  await f.review();
  assert.deepEqual(await f.review(), await f.review());
  await f.prepare({ id: id(31) });
  await assert.rejects(
    f.review({ calendar: id(31), id: id(41) }),
    /overlap|unique/,
  );
  await f.create(id(11), 7, 1, id(21));
  const second = await f.prepare({
    entity: id(11),
    profile: id(21),
    id: id(32),
  });
  await f.review({ entity: id(11), calendar: id(32), id: id(42) });
  assert.equal(second.year.starts_on, "2026-07-01");
  const before = await f.rpc("read_books_entity_calendars", [
    org,
    entity,
    reviewer,
    null,
    1,
  ]);
  assert.equal(before.years.length, 1);
  assert.equal(before.periods.length, 12);
  assert.ok(before.nextCursor);
  const after = await f.rpc("read_books_entity_calendars", [
    org,
    entity,
    reviewer,
    before.nextCursor,
    1,
  ]);
  assert.equal(after.years.length, 1);
  assert.notEqual(before.years[0].id, after.years[0].id);
  await assert.rejects(
    f.rpc("read_books_entity_calendars", [id(9), entity, reviewer, null, 50]),
    /access/,
  );
});
test("schema21 export detects incomplete periods, invented review and rewritten original profile evidence", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  const b = await archive(f);
  assert.equal(BOOKS_EXPORT_SCHEMA_VERSION, 32);
  assert.equal(
    verifyBooksExportBundle(b).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(b)),
  );
  for (const corrupt of [
    (b) => b.tables.books_entity_fiscal_periods.pop(),
    (b) => (b.tables.books_entity_fiscal_periods[0].ends_on = "1900-01-01"),
    (b) => (b.tables.books_entity_calendar_reviews[0].reviewed_by = maker),
    (b) => (b.tables.books_entity_calendar_years[0].profile_id = id(99)),
  ]) {
    const bad = structuredClone(b);
    corrupt(bad);
    for (const [t, rows] of Object.entries(bad.tables))
      bad.manifest.tables[t] = {
        rows: rows.length,
        checksum: booksDigest(rows),
      };
    assert.equal(verifyBooksExportBundle(bad).valid, false);
  }
  const s = await f.rpc("capture_books_export_snapshot", [org]);
  for (const table of ENTITY_CALENDAR_TABLES)
    assert.deepEqual(s.tables[table], b.tables[table]);
  assert.ok(verifyEntityCalendarArchive(b.tables, org, 20).length);
});
test("raw incomplete calendars cannot commit and browser roles cannot mutate or invoke calendar setup", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.db.query(
      "insert into books_entity_calendar_years values($1,$2,$3,$4,2026,current_date,current_date,$5,now(),$1,$6)",
      [id(50), org, entity, id(20), maker, notes],
    ),
    /twelve/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_entity_calendar_years",
      )
    ).rows[0].n,
    0,
  );
  const acl = (
    await f.db.query(
      "select has_function_privilege('authenticated','prepare_books_entity_calendar(uuid,uuid,uuid,uuid,uuid,integer,text)','execute') rpc,has_table_privilege('authenticated','books_entity_fiscal_periods','insert') write",
    )
  ).rows[0];
  assert.deepEqual(acl, { rpc: false, write: false });
});

test("a later applicable reviewed identity invalidates fresh calendar approval while original preparation remains an exact retry", async (t) => {
  const f = await setup(t),
    original = await f.prepare();
  await f.rpc("prepare_books_legal_entity_profile", [
    org,
    entity,
    id(22),
    maker,
    id(20),
    JSON.stringify({
      legal_name: "Builder LLC",
      legal_form: "llc",
      functional_currency: "USD",
      fiscal_start_month: 2,
      fiscal_start_day: 1,
      effective_on: "2026-01-01",
      identity_evidence: { source: "Reviewed fiscal calendar correction" },
    }),
    notes,
  ]);
  await f.rpc("review_books_legal_entity_profile", [
    org,
    entity,
    id(22),
    reviewer,
    notes,
  ]);
  assert.deepEqual(await f.prepare(), original);
  await assert.rejects(f.review(), /identity changed/);
  await f.prepare({ id: id(31), profile: id(22) });
  await f.review({ calendar: id(31), id: id(41) });
  const b = await archive(f);
  assert.equal(
    verifyBooksExportBundle(b).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(b)),
  );
});

test("populated entity calendar restoration preserves original periods and approvals and supports the next fiscal year with ordinary guards", async (t) => {
  const source = await setup(t);
  const prepared = await source.prepare(),
    reviewed = await source.review(),
    b = await archive(source),
    target = await setup(t);
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const table of [...ENTITY_CALENDAR_TABLES]
    .reverse()
    .concat([...LEGAL_ENTITY_ARCHIVE_TABLES].reverse()))
    await target.db.exec(`delete from ${table}`);
  for (const table of [
    ...LEGAL_ENTITY_ARCHIVE_TABLES,
    ...ENTITY_CALENDAR_TABLES,
  ])
    for (const r of b.tables[table]) {
      const names = Object.keys(r);
      await target.db.query(
        `insert into ${table}(${names.join(",")}) values(${names.map((_, i) => "$" + (i + 1)).join(",")})`,
        Object.values(r).map((v) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.deepEqual((await archive(target)).tables, b.tables);
  assert.deepEqual(await target.prepare(), prepared);
  assert.deepEqual(await target.review(), reviewed);
  const next = await target.prepare({ id: id(31), year: 2027 });
  await target.review({ calendar: id(31), id: id(41) });
  assert.equal(next.year.starts_on, "2027-01-31");
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_entity_fiscal_periods",
      )
    ).rows[0].n,
    24,
  );
  const restored = await archive(target);
  assert.equal(
    verifyBooksExportBundle(restored).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(restored)),
  );
  await assert.rejects(
    target.db.exec("delete from books_entity_calendar_reviews"),
    /immutable/,
  );
});

test("actual entity calendar services check Books authorization and reject divergent or foreign receipt rows", async (t) => {
  const f = await setup(t),
    receipt = await f.prepare(),
    page = await f.rpc("read_books_entity_calendars", [
      org,
      entity,
      maker,
      null,
      50,
    ]);
  const Module = require("node:module"),
    load = Module._load,
    file = require.resolve("../lib/services/books/legal-entities");
  let deny = false,
    forged = false,
    calls = 0,
    auth = [];
  const server = {
    rpc: async (name) => {
      calls++;
      return {
        data:
          name === "prepare_books_entity_calendar"
            ? forged
              ? {
                  ...receipt,
                  periods: receipt.periods.map((p) => ({
                    ...p,
                    period_number: 1,
                  })),
                }
              : receipt
            : forged
              ? {
                  ...page,
                  years: page.years.map((y) => ({
                    ...y,
                    legal_entity_id: id(99),
                  })),
                }
              : page,
        error: null,
      };
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
          auth.push(v.permission);
          if (deny) throw Error("Books access denied");
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
    calendarId: id(30),
    profileId: id(20),
    startsInYear: 2026,
    notes,
  };
  assert.equal((await api.prepareBooksEntityCalendar(body)).periods.length, 12);
  assert.equal(
    (await api.listBooksEntityCalendars({ entityId: entity })).years.length,
    1,
  );
  assert.deepEqual(auth, ["books.manage", "books.read"]);
  forged = true;
  await assert.rejects(
    api.prepareBooksEntityCalendar(body),
    /incomplete|divergent/,
  );
  await assert.rejects(api.listBooksEntityCalendars({ entityId: entity }));
  deny = true;
  const before = calls;
  await assert.rejects(api.prepareBooksEntityCalendar(body), /access denied/);
  assert.equal(calls, before);
});

test("reviewed years cannot leave date gaps; intervening years restore complete entity calendar continuity", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  await f.prepare({ id: id(32), year: 2028 });
  await assert.rejects(
    f.review({ calendar: id(32), id: id(42) }),
    /contiguous/,
  );
  await f.prepare({ id: id(31), year: 2027 });
  await f.review({ calendar: id(31), id: id(41) });
  await f.review({ calendar: id(32), id: id(42) });
  const b = await archive(f);
  assert.equal(
    verifyBooksExportBundle(b).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(b)),
  );
  const bad = structuredClone(b);
  bad.tables.books_entity_calendar_reviews =
    bad.tables.books_entity_calendar_reviews.filter(
      (r) => r.calendar_year_id !== id(31),
    );
  assert.ok(verifyEntityCalendarArchive(bad.tables, org, 21).length);
});
