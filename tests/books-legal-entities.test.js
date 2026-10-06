require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const migration = fs.readFileSync(
  path.join(
    __dirname,
    "../supabase/migrations/20261004170526_books_native_legal_entity_registry.sql",
  ),
  "utf8",
);
const id = (n) => "99500000-0000-4000-8000-" + String(n).padStart(12, "0"),
  org = id(1),
  actor = id(2),
  reviewer = id(3),
  reader = id(4),
  entity = id(10),
  profile = id(20),
  notes = "Reviewed legal identity and supporting documents";
const details = {
  legal_name: "Arc Builders LLC",
  legal_form: "llc",
  functional_currency: "USD",
  fiscal_start_month: 7,
  fiscal_start_day: 1,
  effective_on: "2026-07-01",
  identity_evidence: {
    formation_file_id: id(90),
    source: "Reviewed incorporation documents",
  },
};
async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table memberships(org_id uuid references orgs(id),user_id uuid references app_users(id),status text,primary key(org_id,user_id));create table journal_entries(id uuid primary key,org_id uuid,amount bigint);insert into orgs values('${org}'),('${id(100)}');insert into app_users values('${actor}'),('${reviewer}'),('${reader}');insert into memberships values('${org}','${actor}','active'),('${org}','${reviewer}','active'),('${org}','${reader}','active'),('${id(100)}','${actor}','active');insert into journal_entries values('${id(200)}','${org}',10000);`,
  );
  await db.exec(migration);
  const rpc = async (name, params) =>
    (
      await db.query(
        `select ${name}(${params.map((_, i) => "$" + (i + 1)).join(",")}) result`,
        params,
      )
    ).rows[0].result;
  const create = (eid = entity, code = "BUILDER", by = actor, o = org) =>
    rpc("create_books_legal_entity", [o, eid, code, by, notes]);
  const member = (user, level = "review", by = actor, eid = entity) =>
    rpc("set_books_legal_entity_member", [org, eid, by, user, level, notes]);
  const prepare = (
    pid = profile,
    previous = null,
    fields = details,
    by = actor,
    eid = entity,
  ) =>
    rpc("prepare_books_legal_entity_profile", [
      org,
      eid,
      pid,
      by,
      previous,
      JSON.stringify(fields),
      notes,
    ]);
  const review = (pid = profile, by = reviewer, eid = entity) =>
    rpc("review_books_legal_entity_profile", [org, eid, pid, by, notes]);
  const read = (by = actor, eid = entity, before = null, limit = 50) =>
    rpc("read_books_legal_entity_setup", [org, by, eid, before, limit]);
  return { db, rpc, create, member, prepare, review, read };
}
test("native registry creates only setup identity, exact retry, scoped membership and unchanged legacy ledger", async (t) => {
  const f = await setup(t),
    e = await f.create();
  assert.equal(e.ledger_state, "setup");
  assert.equal(e.org_id, org);
  assert.deepEqual(await f.create(), e);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_legal_entity_access_history",
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(f.create(entity, "CHANGED"), /retry differs/);
  await assert.rejects(f.create(id(11), "BUILDER"), /unique/);
  await assert.rejects(
    f.create(id(11), "OTHER", reader, id(100)),
    /membership/,
  );
  await f.create(id(11), "BUILDER", actor, id(100));
  assert.deepEqual((await f.db.query("select * from journal_entries")).rows, [
    { id: id(200), org_id: org, amount: 10000 },
  ]);
  await assert.rejects(
    f.db.query("update books_legal_entities set ledger_state='active'"),
    /immutable/,
  );
  await assert.rejects(
    f.db.query(
      "insert into books_legal_entities(id,org_id,code,ledger_state,created_by,creation_notes) values($1,$2,'FAKE','active',$3,$4)",
      [id(12), org, actor, notes],
    ),
    /check constraint/,
  );
});
test("entity identity requires separate current entity reviewer and retains exact frozen calendar evidence", async (t) => {
  const f = await setup(t);
  await f.create();
  const p = await f.prepare();
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review(profile, actor), /separate/);
  await assert.rejects(f.review(), /review access/);
  await f.member(reviewer);
  const r = await f.review();
  assert.deepEqual(await f.review(), r);
  const workspace = await f.read();
  assert.equal(workspace.entities[0].reviewed_profile.id, profile);
  assert.equal(workspace.entities[0].reviewed_profile.fiscal_start_month, 7);
  assert.deepEqual(
    workspace.profiles[0].identity_evidence,
    details.identity_evidence,
  );
  await assert.rejects(
    f.prepare(profile, null, { ...details, legal_name: "Other name" }),
    /retry differs/,
  );
  await assert.rejects(
    f.prepare(id(21), profile, { ...details, functional_currency: "CAD" }),
    /check constraint/,
  );
  await assert.rejects(
    f.prepare(id(21), profile, {
      ...details,
      fiscal_start_month: 2,
      fiscal_start_day: 30,
    }),
    /date field/,
  );
  await assert.rejects(
    f.prepare(id(21), profile, {
      ...details,
      external_provider_entity: "unknown",
    }),
    /Invalid entity profile/,
  );
});
test("same organization Books rights never imply access to another entity; inactive and revoked members lose access", async (t) => {
  const f = await setup(t);
  await f.create();
  await f.create(id(11), "OTHER");
  await f.prepare();
  await f.member(reader, "read");
  assert.equal((await f.read(reader, null)).entities.length, 1);
  assert.equal((await f.read(reader)).members.length, 0);
  assert.equal((await f.read(reader)).accessHistory.length, 0);
  await assert.rejects(f.read(reader, id(11)), /read access/);
  await assert.rejects(
    f.prepare(id(21), null, details, reader),
    /preparation access/,
  );
  await f.member(reader, "revoked");
  assert.equal((await f.read(reader, null)).entities.length, 0);
  await assert.rejects(f.read(reader), /read access/);
  await f.member(reviewer, "review");
  await f.db.query(
    "update memberships set status='suspended' where org_id=$1 and user_id=$2",
    [org, reviewer],
  );
  await assert.rejects(f.review(), /review access/);
  await assert.rejects(f.member(reviewer, "manage"), /active in organization/);
  await assert.rejects(
    f.rpc("read_books_legal_entity_setup", [id(100), reader, null, null, 50]),
    /membership/,
  );
  await assert.rejects(
    f.db.query(
      "insert into books_legal_entity_profiles(id,org_id,legal_entity_id,revision,legal_name,legal_form,functional_currency,fiscal_start_month,fiscal_start_day,effective_on,identity_evidence,prepared_by,preparation_notes) values($1,$2,$3,1,$4,'llc','USD',1,1,'2026-01-01','{\"source\":\"reviewed\"}',$5,$6)",
      [id(23), id(100), entity, "Cross org", actor, notes],
    ),
    /preparation access/,
  );
});
test("access changes are audited, cannot erase history or remove the last active manager, and exact retry does not add events", async (t) => {
  const f = await setup(t);
  await f.create();
  const access = await f.member(reader, "read");
  assert.deepEqual(await f.member(reader, "read"), access);
  assert.equal((await f.read()).accessHistory.length, 2);
  await assert.rejects(
    f.member(actor, "revoked"),
    /last active entity manager/,
  );
  await assert.rejects(f.member(reviewer, "manage", reader), /manager access/);
  await f.member(reviewer, "manage");
  await f.member(actor, "read", reviewer);
  const p = await f.read(reviewer);
  assert.equal(p.accessHistory.length, 4);
  assert.equal(p.accessHistory[0].prior_level, "manage");
  assert.equal(p.accessHistory[0].access_level, "read");
  await assert.rejects(
    f.db.query("delete from books_legal_entity_members where user_id=$1", [
      actor,
    ]),
    /Revoke/,
  );
  await assert.rejects(
    f.db.query("update books_legal_entity_access_history set change_notes=$1", [
      notes,
    ]),
    /immutable/,
  );
  await assert.rejects(
    f.db.query(
      "update books_legal_entity_members set legal_entity_id=$1 where user_id=$2",
      [id(11), actor],
    ),
    /unavailable|immutable/,
  );
});
test("stale preparation branches cannot overwrite reviewed identity; frozen retries survive later revisions", async (t) => {
  const f = await setup(t);
  await f.create();
  await f.member(reviewer);
  const p = await f.prepare();
  await f.prepare(id(21));
  const r = await f.review();
  await assert.rejects(f.review(id(21)), /predecessor changed/);
  const next = await f.prepare(id(22), profile, {
    ...details,
    legal_name: "Arc Builders Revised LLC",
  });
  await f.review(id(22));
  assert.deepEqual(await f.prepare(), p);
  assert.deepEqual(await f.review(), r);
  assert.equal((await f.read()).entities[0].reviewed_profile.id, next.id);
  for (const table of [
    "books_legal_entities",
    "books_legal_entity_profiles",
    "books_legal_entity_profile_reviews",
    "books_legal_entity_access_history",
  ])
    for (const action of ["update", "delete"])
      await assert.rejects(
        f.db.exec(
          action === "update"
            ? `update ${table} set org_id=org_id`
            : `delete from ${table}`,
        ),
        /immutable/,
      );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_legal_entity_profiles",
      )
    ).rows[0].n,
    3,
  );
});
test("private entity records and functions have no browser grants, even with active membership", async (t) => {
  const f = await setup(t);
  await f.create();
  const tables = [
    "books_legal_entities",
    "books_legal_entity_members",
    "books_legal_entity_access_history",
    "books_legal_entity_profiles",
    "books_legal_entity_profile_reviews",
  ];
  for (const role of ["anon", "authenticated"]) {
    for (const table of tables)
      for (const op of ["select", "insert", "update", "delete"])
        assert.equal(
          (
            await f.db.query("select has_table_privilege($1,$2,$3) permitted", [
              role,
              table,
              op,
            ])
          ).rows[0].permitted,
          false,
        );
    const functions = (
      await f.db.query(
        "select oid::regprocedure::text signature,prosecdef from pg_proc where proname like '%books_legal_entity%' or proname like 'books_entity_%'",
      )
    ).rows;
    for (const fn of functions) {
      assert.equal(fn.prosecdef, false);
      assert.equal(
        (
          await f.db.query(
            "select has_function_privilege($1,$2,'execute') permitted",
            [role, fn.signature],
          )
        ).rows[0].permitted,
        false,
      );
    }
    await f.db.exec(`set role ${role}`);
    await assert.rejects(
      f.db.query("select * from books_legal_entities"),
      /permission denied/,
    );
    await assert.rejects(f.read(), /permission denied/);
    await f.db.exec("reset role");
  }
  await f.db.exec(
    "grant select on orgs,app_users,memberships to service_role;set role service_role",
  );
  assert.equal((await f.read()).entities[0].id, entity);
  await f.db.exec("reset role");
});
test("entity listing is bounded, deterministic and has a tied UUID cursor rather than leaking inaccessible identities", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 53; i++) await f.create(id(300 + i), "ENTITY_" + i);
  const page = await f.read(actor, null);
  assert.equal(page.entities.length, 50);
  assert.equal(page.nextCursor, page.entities.at(-1).id);
  const next = await f.read(actor, null, page.nextCursor);
  assert.equal(next.entities.length, 3);
  assert.equal(next.nextCursor, null);
  assert.equal(
    new Set([...page.entities, ...next.entities].map((e) => e.id)).size,
    53,
  );
  await assert.rejects(f.read(actor, null, null, 51), /pagination/);
  await assert.rejects(f.read(actor, id(300), id(301)), /pagination/);
  assert.equal((await f.read(reader, null)).entities.length, 0);
});

test("entity services authorize before private RPC and bind every returned receipt to actor, tenant and frozen request", async () => {
  const Module = require("node:module"),
    original = Module._load,
    modulePath = require.resolve("../lib/services/books/legal-entities");
  delete require.cache[modulePath];
  let denied = false,
    corrupt = false,
    calls = [],
    response;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: org,
            userId: actor,
            supabase: {},
          }),
        };
      if (name === "@/lib/services/books/access")
        return {
          requireBooksAuthorization: async (request) => {
            calls.push(["authorize", request.permission, request.resourceId]);
            if (denied) throw Error("Denied Books permission");
          },
        };
      if (name === "@/lib/supabase/server")
        return {
          createServiceSupabaseClient: () => ({
            rpc: async (name, args) => {
              calls.push(["rpc", name, args]);
              return {
                data: corrupt ? { ...response, org_id: id(100) } : response,
              };
            },
          }),
        };
      return original.call(this, name, ...args);
    };
    api = require("../lib/services/books/legal-entities");
  } finally {
    Module._load = original;
  }
  const input = { id: entity, code: " builder ", notes };
  denied = true;
  await assert.rejects(api.createBooksLegalEntity(input), /Denied/);
  assert.deepEqual(calls, [["authorize", "books.manage", org]]);
  denied = false;
  calls = [];
  response = {
    id: entity,
    org_id: org,
    code: "BUILDER",
    ledger_state: "setup",
    created_by: actor,
    creation_notes: notes,
    created_at: "2026-10-04T00:00:00Z",
  };
  assert.equal((await api.createBooksLegalEntity(input)).id, entity);
  assert.equal(calls[1][2].p_org, org);
  assert.equal(calls[1][2].p_actor, actor);
  assert.equal(calls[1][2].p_code, "BUILDER");
  corrupt = true;
  await assert.rejects(api.createBooksLegalEntity(input), /receipt differs/);
  corrupt = false;
  const prepare = {
    entityId: entity,
    id: profile,
    previousProfileId: null,
    profile: details,
    notes,
  };
  response = {
    id: profile,
    org_id: org,
    legal_entity_id: entity,
    prepared_by: actor,
    previous_profile_id: null,
    preparation_notes: notes,
    revision: 1,
    ...details,
  };
  assert.equal(
    (await api.prepareBooksLegalEntityProfile(prepare)).legal_name,
    details.legal_name,
  );
  response = { ...response, fiscal_start_month: 1 };
  await assert.rejects(
    api.prepareBooksLegalEntityProfile(prepare),
    /receipt differs/,
  );
  for (const patch of [
    { functional_currency: "CAD" },
    { fiscal_start_month: 2, fiscal_start_day: 29 },
    { effective_on: "2026-02-30" },
    { identity_evidence: {} },
    { identity_evidence: { original: "x".repeat(65536) } },
    { external_connection_id: id(80) },
  ])
    assert.equal(
      api.legalEntityProfileSchema.safeParse({ ...details, ...patch }).success,
      false,
    );
  calls = [];
  await assert.rejects(
    api.prepareBooksLegalEntityProfile({
      ...prepare,
      profile: { ...details, external_connection_id: id(80) },
    }),
  );
  assert.equal(calls.length, 0);
  response = {
    orgId: org,
    entityId: entity,
    entities: [
      {
        id: entity,
        org_id: org,
        code: "BUILDER",
        ledger_state: "setup",
        reviewed_profile: null,
      },
    ],
    nextCursor: null,
    profiles: [],
    moreProfiles: false,
    members: [],
    moreMembers: false,
    accessHistory: [],
    moreAccessHistory: false,
  };
  assert.equal(
    (await api.listBooksLegalEntitySetup({ entityId: entity })).entities.length,
    1,
  );
  response = {
    ...response,
    profiles: [{ org_id: id(100), legal_entity_id: entity }],
  };
  await assert.rejects(
    api.listBooksLegalEntitySetup({ entityId: entity }),
    /authorized scope/,
  );
  delete require.cache[modulePath];
});
