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
} = require("./fixtures/books-native-adjustment-database");
test("native independent adjustment approval atomically retains a fact and balanced canonical journal legs; exact retries preserve original receipts", async (t) => {
  const f = await setup(t),
    p = await f.prepare();
  assert.equal(p.posted, false);
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review({ actor: maker }), /independent/);
  const r = await f.review();
  assert.equal(r.posted, true);
  assert.equal(r.ledgerActivated, false);
  assert.equal(r.entry.total_cents, 12000);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].project_id, id(70));
  assert.ok(r.lines.every((l) => l.account_id !== id(500)));
  const retry = await f.review();
  assert.equal(retry.created, false);
  const { created, ...rest } = r;
  assert.deepEqual(retry, { ...rest, created: false });
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
  await assert.rejects(
    f.review({ notes: notes + " changed" }),
    /retry differs/,
  );
  for (const table of [
    "books_native_adjustment_facts",
    "books_native_adjustment_reviews",
    "books_native_journal_entries",
    "books_native_journal_lines",
  ])
    await assert.rejects(f.db.exec(`delete from ${table}`), /immutable/);
});

test("failed second leg rolls back approval and header; same exact review can retry after the failure is repaired", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.db.exec(
    "create function fail_native_leg() returns trigger language plpgsql as $$begin if new.position=2 then raise exception 'Injected second-leg failure';end if;return new;end $$;create trigger zz_inject_native_failure before insert on books_native_journal_lines for each row execute function fail_native_leg()",
  );
  await assert.rejects(f.review(), /Injected/);
  for (const table of [
    "books_native_adjustment_reviews",
    "books_native_journal_entries",
    "books_native_journal_lines",
  ])
    assert.equal(
      (await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n,
      0,
    );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_adjustment_facts",
      )
    ).rows[0].n,
    1,
  );
  await f.db.exec(
    "drop trigger zz_inject_native_failure on books_native_journal_lines",
  );
  assert.equal((await f.review()).posted, true);
});
test("raw approval without its journal cannot commit, and raw legs cannot append or change reviewed native money", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await assert.rejects(
    f.db.query(
      "insert into books_native_adjustment_reviews(id,org_id,legal_entity_id,fact_id,decision,entry_id,request_sha256,reviewed_by,reviewed_access_event_id,reviewed_at,notes) values($1,$2,$3,$4,'approve',$5,repeat('0',64),$6,$1,now(),$7)",
      [id(201), org, entity, id(200), id(202), reviewer, notes],
    ),
    /requires its original journal/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_adjustment_reviews",
      )
    ).rows[0].n,
    0,
  );
  const r = await f.review(),
    line = r.lines[0],
    cols = Object.keys(line);
  for (const v of [
    { id: id(210), position: 3 },
    { id: id(211), debit_cents: 11999 },
    { id: id(212), account_id: id(500) },
  ]) {
    const row = { ...line, ...v };
    await assert.rejects(
      f.db.query(
        `insert into books_native_journal_lines(${cols.join(",")}) values(${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((k) =>
          typeof row[k] === "object" && row[k] !== null
            ? JSON.stringify(row[k])
            : row[k],
        ),
      ),
      /outside original|differs/,
    );
  }
});
test("native posting hold blocks new preparation/approval and requires a separate manager to release; original committed retries stay recoverable", async (t) => {
  const f = await setup(t),
    p = await f.prepare(),
    period = p.fact.period_id;
  const hold = (idValue, previous, decision, actor = maker) =>
    f.rpc("set_books_native_period_hold", [
      org,
      entity,
      period,
      actor,
      idValue,
      previous,
      decision,
      notes,
    ]);
  const h = await hold(id(220), null, "hold");
  assert.deepEqual(await hold(id(220), null, "hold"), h);
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review(), /held against posting/);
  await assert.rejects(
    hold(id(221), id(220), "release"),
    /separate entity manager/,
  );
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await hold(id(221), id(220), "release", reviewer);
  const r = await f.review();
  await hold(id(222), id(221), "hold");
  assert.equal((await f.review()).created, false);
  assert.equal(r.posted, true);
});
test("source drift or revoked maker cannot approve money; independent rejection retires stale intent without requiring current economic bytes", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.db.exec(
    "alter table invoices add column mutable_amount_cents bigint;update invoices set mutable_amount_cents=100 where id='" +
      id(100) +
      "'",
  );
  await assert.rejects(f.review(), /snapshot changed/);
  const rejected = await f.review({ decision: "reject", entry: null });
  assert.equal(rejected.posted, false);
  assert.equal(rejected.entry, null);
  assert.deepEqual(rejected.lines, []);
  const d = await setup(t);
  await d.prepare();
  await d.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(d.review(), /maker must retain/);
  assert.equal(
    (await d.review({ decision: "reject", entry: null })).posted,
    false,
  );
});
test("malformed adjustment policy, unbalanced cents and foreign dimensions cannot prepare native money", async (t) => {
  const f = await setup(t);
  for (const change of [
    (r) => (r.draft.entryKind = "operational"),
    (r) => (r.draft.policyVersion = 2),
    (r) => (r.draft.postingKey = "invoice:" + id(100)),
    (r) => r.draft.lines[0].debitCents++,
    (r) => (r.draft.lines[0].projectId = id(71)),
    (r) => (r.draft.lines[0].dimensions = { cost_code_id: id(999) }),
    (r) => (r.draft.lines[0].companyId = id(999)),
    (r) => (r.context.actorId = reviewer),
    (r) => (r.context.chart.definition_sha256 = "f".repeat(64)),
  ]) {
    const request = structuredClone(f.request);
    change(request);
    await assert.rejects(f.prepare({ request }));
  }
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_adjustment_facts",
      )
    ).rows[0].n,
    0,
  );
  await f.prepare();
  await assert.rejects(
    f.prepare({ notes: notes + " changed" }),
    /retry differs/,
  );
  await assert.rejects(f.review({ project: id(71) }), /missing or foreign/);
});

test("native money belongs to distinct entity accounts and calendars and a hold cannot freeze another entity", async (t) => {
  const f = await setup(t),
    other = id(11),
    originalProfile = id(120),
    profile = id(121);
  await f.create(other, originalProfile);
  await f.rpc("prepare_books_legal_entity_profile", [
    org,
    other,
    profile,
    maker,
    originalProfile,
    JSON.stringify({
      legal_name: "Second Builder LLC",
      legal_form: "llc",
      functional_currency: "USD",
      fiscal_start_month: 4,
      fiscal_start_day: 1,
      effective_on: "2026-01-01",
      identity_evidence: { source: "Second original legal entity evidence" },
    }),
    notes,
  ]);
  await f.rpc("review_books_legal_entity_profile", [
    org,
    other,
    profile,
    reviewer,
    notes,
  ]);
  const definition =
    require("../lib/services/books/entity-chart").constructionEntityChart();
  const mapping = { 1100: "ENTITY-B-AR", 4000: "ENTITY-B-REVENUE" };
  for (const a of definition.accounts) {
    a.code = mapping[a.code] ?? a.code;
    if (a.parent_code) a.parent_code = mapping[a.parent_code] ?? a.parent_code;
  }
  for (const role of Object.keys(definition.controls))
    definition.controls[role] =
      mapping[definition.controls[role]] ?? definition.controls[role];
  await f.rpc("prepare_books_entity_chart", [
    org,
    other,
    id(130),
    profile,
    null,
    maker,
    "2026-01-01",
    JSON.stringify(definition),
    notes,
  ]);
  await f.rpc("review_books_entity_chart", [
    org,
    other,
    id(130),
    id(140),
    reviewer,
    notes,
  ]);
  await f.rpc("prepare_books_entity_calendar", [
    org,
    other,
    id(150),
    profile,
    maker,
    2026,
    notes,
  ]);
  await f.rpc("review_books_entity_calendar", [
    org,
    other,
    id(150),
    id(151),
    reviewer,
    notes,
  ]);
  await f.rpc("prepare_books_project_entity", [
    org,
    other,
    id(71),
    id(92),
    profile,
    maker,
    "2026-01-01",
    JSON.stringify({
      single_entity_project_confirmed: true,
      rationale: "Second entity owns the actual project contract",
      document_version_ids: [id(81)],
    }),
    notes,
  ]);
  await f.rpc("review_books_project_entity", [
    org,
    other,
    id(71),
    id(92),
    id(93),
    reviewer,
    notes,
  ]);
  await f.db.exec(
    `insert into invoices values('${id(111)}','${org}','${id(71)}')`,
  );
  await f.prepare();
  const first = await f.review();
  await f.rpc("set_books_native_period_hold", [
    org,
    entity,
    f.request.context.period.id,
    maker,
    id(300),
    null,
    "hold",
    notes,
  ]);
  const c = await f.context({ project: id(71), source: id(111) }),
    request = {
      context: c,
      draft: {
        ...f.request.draft,
        postingKey: "native-adjustment:" + id(310),
        sourceId: id(111),
        lines: f.request.draft.lines.map((l) => ({ ...l, projectId: id(71) })),
      },
    };
  await f.prepare({ entity: other, project: id(71), id: id(310), request });
  const second = await f.review({
    entity: other,
    project: id(71),
    fact: id(310),
    id: id(311),
    entry: id(312),
  });
  assert.equal(second.entry.legal_entity_id, other);
  assert.notEqual(second.entry.period_id, first.entry.period_id);
  assert.equal(c.period.period_number, 1);
  assert.equal(f.request.context.period.period_number, 4);
  const codes = (
    await f.db.query(
      "select a.code from books_native_journal_lines l join books_entity_accounts a on a.id=l.account_id where l.entry_id=$1 order by position",
      [id(312)],
    )
  ).rows.map((r) => r.code);
  assert.deepEqual(codes, ["ENTITY-B-AR", "ENTITY-B-REVENUE"]);
  assert.notEqual(first.lines[0].account_id, second.lines[0].account_id);
});
