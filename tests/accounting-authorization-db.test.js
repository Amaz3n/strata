const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { PGlite } = require("@electric-sql/pglite")
const root = "supabase/migrations/"
const read = (name) => fs.readFileSync(root + name, "utf8")
const migration = read(
  "20261005033613_accounting_application_authorization.sql",
)
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const org = id(1),
  other = id(2),
  connection = id(3),
  foreign = id(4),
  mapping = id(5),
  record = id(6)
async function database(t, legacy) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.role() returns text language sql as $$select current_user::text$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table orgs(id uuid primary key); create table app_users(id uuid primary key);
    create table divisions(id uuid primary key,org_id uuid); create table communities(id uuid primary key,org_id uuid);
    create table projects(id uuid primary key,org_id uuid,division_id uuid,phase text);
    create table lots(id uuid primary key,org_id uuid,project_id uuid,community_id uuid);
    create table invoices(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table project_expenses(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table vendor_bills(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create table payments(id uuid primary key,org_id uuid,project_id uuid,amount_cents bigint);
    create function is_org_member(uuid) returns boolean language sql stable as $$select $1::text=current_setting('test.org_id',true)$$;
    create function tg_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;`)
  const connections = read("20260719011735_accounting_connections.sql")
  await db.exec(
    connections.slice(
      0,
      connections.indexOf("insert into public.accounting_connections"),
    ),
  )
  await db.exec(
    read("20260724010343_accounting_abstraction_hardening.sql").match(
      /alter table public\.accounting_connections\n  alter column[\s\S]*?;/,
    )[0],
  )
  const snapshot = read("20260517092101_remote_schema.sql")
  await db.exec(
    snapshot.match(
      /CREATE TABLE IF NOT EXISTS "public"\."qbo_sync_records" \([\s\S]*?\n\);/,
    )[0],
  )
  await db.exec(`alter table qbo_sync_records add primary key(id); alter table qbo_sync_records add column pushable boolean default true;
    create unique index qbo_sync_records_entity_idx on qbo_sync_records(org_id,entity_type,entity_id);
    alter table qbo_sync_records enable row level security;`)
  await db.exec(
    snapshot.match(/CREATE POLICY "qbo_sync_records_access"[^;]*;/)[0],
  )
  for (const grant of snapshot.matchAll(
    /GRANT ALL ON TABLE "public"\."qbo_sync_records"[^;]*;/g,
  ))
    await db.exec(grant[0])
  const sync = read("20260719011822_accounting_sync_records.sql")
  await db.exec(sync.slice(0, sync.indexOf("create or replace function")))
  await db.exec(
    read("20260724010343_accounting_abstraction_hardening.sql").match(
      /create unique index if not exists accounting_sync_records_connection_entity_idx[\s\S]*?;/,
    )[0],
  )
  await db.exec(
    read("20260908010000_accounting_delivery_leases.sql").match(
      /alter table public\.accounting_sync_records drop constraint[\s\S]*?check\(status[^;]*;/,
    )[0],
  )
  const map = read("20260719011920_accounting_entity_map.sql")
  await db.exec(map.slice(0, map.indexOf("with active_connection")))
  if (legacy) {
    await db.exec(
      snapshot.match(
        /CREATE TABLE IF NOT EXISTS "public"\."qbo_connections" \([\s\S]*?\n\);/,
      )[0],
    )
    await db.exec("alter table qbo_connections enable row level security")
    await db.exec(
      snapshot.match(/CREATE POLICY "qbo_connections_access"[^;]*;/)[0],
    )
    for (const grant of snapshot.matchAll(
      /GRANT ALL ON TABLE "public"\."qbo_connections"[^;]*;/g,
    ))
      await db.exec(grant[0])
    await db.exec(
      "alter table qbo_connections rename to qbo_connections_legacy",
    )
    await db.exec(
      connections.slice(
        connections.indexOf("create view public.qbo_connections"),
        connections.indexOf("create or replace function"),
      ),
    )
  } else {
    // Model the post-D2 shape without executing the destructive cleanup.
    await db.exec(
      "drop view qbo_sync_records; alter table accounting_connections drop column credentials;",
    )
  }
  // Explicit historical column grants must also be removed by the new SQL.
  await db.exec(
    "grant select(access_token),update(label) on accounting_connections to authenticated; grant update(dimensions) on accounting_entity_map to authenticated;",
  )
  await db.exec(
    "grant select(refresh_token) on accounting_connections to public",
  )
  await db.query("insert into orgs values($1),($2)", [org, other])
  for (const [key, tenant] of [
    [connection, org],
    [foreign, other],
  ])
    await db.query(
      `insert into accounting_connections(id,org_id,external_account_id,access_token,refresh_token,token_expires_at) values($1::uuid,$2,$1::uuid::text,'synthetic-access','synthetic-refresh',now()+interval '1 hour')`,
      [key, tenant],
    )
  await db.query(
    "insert into accounting_entity_map(id,org_id,connection_id) values($1,$2,$3)",
    [mapping, org, connection],
  )
  await db.query(
    "insert into accounting_sync_records(id,org_id,connection_id,entity_type,entity_id,external_id) values($1,$2,$3,'invoice',$1,'synthetic-remote')",
    [record, org, connection],
  )
  if (legacy)
    await db.exec(
      "insert into qbo_connections_legacy(id,org_id,realm_id,access_token,refresh_token,token_expires_at) select id,org_id,external_account_id,access_token,refresh_token,token_expires_at from accounting_connections",
    )
  // Execute actual source RPC definitions. Disabling body validation lets this
  // minimal fixture load financial routines whose unrelated tables are absent;
  // denial is checked at EXECUTE privilege before any body can run.
  await db.exec("set check_function_bodies=off")
  const rpcNames = [
    "accounting_count_synced_scope",
    "accounting_claim_sync_create",
    "qbo_claim_sync_create",
    "update_qbo_cdc_cursor",
    "claim_accounting_delivery",
    "release_accounting_delivery",
    "persist_accounting_delivery",
    "accounting_claim_import",
    "accounting_finish_import",
    "accounting_persist_import_row",
    "accounting_persist_import_children",
    "accounting_adopt_import_identity",
    "launch_books_greenfield_atomic",
    "append_accounting_batch_line_atomic",
    "complete_books_cutover",
    "rollback_books_cutover",
    "accounting_d2_schema_fingerprint",
    "accounting_d2_disposition_matches",
    "accounting_d2_parity_snapshot",
    "capture_accounting_d2_acceptance",
    "assert_accounting_d2_ready",
  ]
  const definitions = new Map()
  for (const name of fs
    .readdirSync(root)
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name < "20261005033613_accounting_application_authorization.sql",
    )
    .sort()) {
    const sql = read(name)
    for (const match of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi,
    )) {
      if (!rpcNames.includes(match[1].toLowerCase())) continue
      const tail = sql.slice(match.index),
        delimiter = tail.match(/as\s+(\$[a-z_]*\$)/i)
      assert.ok(delimiter, match[1])
      const end = tail.indexOf(
        delimiter[1],
        delimiter.index + delimiter[0].length,
      )
      definitions.set(
        match[1].toLowerCase(),
        tail.slice(0, end + delimiter[1].length) + ";",
      )
    }
  }
  // The latest delivery body declares this rowtype even with validation off.
  await db.exec(
    read("20260908010000_accounting_delivery_leases.sql").split(
      "create function",
    )[0],
  )
  for (const name of rpcNames.filter(
    (name) => name !== "accounting_count_synced_scope",
  )) {
    assert.ok(definitions.has(name), name)
    await db.exec(definitions.get(name))
  }
  // Replay exact historical ACL statements for these source-defined routines.
  for (const name of fs
    .readdirSync(root)
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name < "20261005033613_accounting_application_authorization.sql",
    )
    .sort()) {
    for (const statement of read(name).matchAll(
      /(?:revoke|grant)\s+[^;]+?\bon\s+function\s+[^;]+;/gi,
    )) {
      const names = [...statement[0].matchAll(/public\.(\w+)\s*\(/g)].map((x) =>
        x[1].toLowerCase(),
      )
      if (names.length && names.every((x) => rpcNames.includes(x)))
        await db.exec(statement[0])
    }
  }
  if (!legacy)
    await db.exec(
      "drop function public.qbo_claim_sync_create(uuid,uuid,text,uuid,interval)",
    )
  // Adversarial inherited/default overload: migration must remove app execute.
  await db.exec(
    `create function accounting_claim_sync_create(text) returns boolean language sql security definer as $$select true$$; grant execute on function accounting_claim_sync_create(text) to authenticated,anon`,
  )
  assert.equal(
    (
      await db.query(
        "select to_regprocedure('public.accounting_count_synced_scope(uuid,uuid,uuid,uuid,uuid)') routine",
      )
    ).rows[0].routine,
    null,
  )
  await db.query("select set_config('test.org_id',$1,false)", [org])
  return {
    db,
    install: () => db.exec(migration),
    async role(role, fn) {
      await db.exec(`set role ${role}`)
      try {
        return await fn()
      } finally {
        await db.exec("reset role")
      }
    },
    rpcNames,
  }
}
for (const legacy of [true, false])
  test(`actual role contracts ${legacy ? "pre" : "post"}-D2`, async (t) => {
    const f = await database(t, legacy),
      { db } = f
    await f.role("authenticated", async () => {
      assert.equal(
        (await db.query("select access_token from accounting_connections")).rows
          .length,
        1,
      )
      await db.exec(
        "update accounting_connections set label='Member changed it'",
      )
    })
    await f.install()
    assert.ok(
      (
        await db.query(
          "select to_regprocedure('public.accounting_count_synced_scope(uuid,uuid,uuid,uuid,uuid)') routine",
        )
      ).rows[0].routine,
    )
    for (const role of ["anon", "authenticated"])
      await f.role(role, async () => {
        for (const sql of [
          "select * from accounting_connections",
          "select access_token from accounting_connections",
          "select refresh_token from accounting_connections",
          "select auth_config from accounting_connections",
          "select row_to_json(c) from accounting_connections c",
          ...(legacy ? ["select credentials from accounting_connections"] : []),
        ])
          await assert.rejects(db.exec(sql), /permission denied/)
        for (const table of [
          "accounting_connections",
          "accounting_entity_map",
          "accounting_sync_records",
          ...(legacy
            ? ["qbo_connections", "qbo_sync_records", "qbo_connections_legacy"]
            : []),
        ]) {
          for (const sql of [
            `insert into ${table}(id) values('${id(99)}')`,
            `update ${table} set id=id`,
            `delete from ${table}`,
          ])
            await assert.rejects(db.exec(sql), /permission denied/)
        }
        await assert.rejects(
          db.exec("update accounting_connections set label='Forged'"),
          /permission denied/,
        )
        await assert.rejects(
          db.exec("update accounting_entity_map set dimensions='{}'"),
          /permission denied/,
        )
        if (legacy)
          for (const table of [
            "qbo_connections",
            "qbo_sync_records",
            "qbo_connections_legacy",
          ])
            await assert.rejects(
              db.exec(`select * from ${table}`),
              /permission denied/,
            )
        for (const name of f.rpcNames) {
          const rows = (
            await db.query(
              `select p.oid::regprocedure::text signature,has_function_privilege(current_user,p.oid,'execute') permitted,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,
              [name],
            )
          ).rows
          assert.ok(
            rows.length > 0 || (!legacy && name === "qbo_claim_sync_create"),
            name,
          )
          for (const row of rows) {
            assert.equal(row.permitted, false, row.signature)
            const types = (
              await db.query(
                `select unnest(proargtypes)::regtype::text type from pg_proc where oid=$1::regprocedure`,
                [row.signature],
              )
            ).rows
            await assert.rejects(
              db.exec(
                `select public.${name}(${types.map((x) => `null::${x.type}`).join(",")})`,
              ),
              /permission denied/,
            )
          }
        }
      })
    await f.role("authenticated", async () => {
      assert.equal(
        (
          await db.query(
            "select id,label,settings,status,refresh_failure_count from accounting_connections",
          )
        ).rows.length,
        1,
      )
      for (const table of ["accounting_entity_map", "accounting_sync_records"])
        assert.equal((await db.query(`select * from ${table}`)).rows.length, 1)
      await db.query("select set_config('test.org_id',$1,false)", [id(88)])
      assert.equal(
        (await db.query("select id from accounting_connections")).rows.length,
        0,
      )
      for (const table of ["accounting_entity_map", "accounting_sync_records"])
        assert.equal((await db.query(`select * from ${table}`)).rows.length, 0)
    })
    await f.role("service_role", async () => {
      await db.query(
        "update accounting_connections set access_token='synthetic-rotated' where id=$1",
        [connection],
      )
      await db.query(
        "update accounting_sync_records set external_id='preserved-remote' where id=$1",
        [record],
      )
      await db.query("select update_qbo_cdc_cursor($1,now())", [connection])
      assert.equal(
        (
          await db.query("select accounting_claim_sync_create($1,$2,$3,$4)", [
            org,
            connection,
            "invoice",
            id(9),
          ])
        ).rows[0].accounting_claim_sync_create,
        true,
      )
    })
    // Replaying the additive SQL changes grants, never rows or remote identities.
    await f.install()
    for (const role of ["anon", "authenticated"])
      await f.role(role, () =>
        assert.rejects(
          db.query("select accounting_count_synced_scope($1,$2)", [
            org,
            connection,
          ]),
          /permission denied/,
        ),
      )
    await f.role("service_role", async () => {
      assert.equal(
        (
          await db.query(
            "select accounting_count_synced_scope($1,$2)::integer n",
            [org, connection],
          )
        ).rows[0].n,
        1,
      )
    })
    assert.equal(
      (await db.query("select count(*)::int n from accounting_connections"))
        .rows[0].n,
      2,
    )
    assert.equal(
      (
        await db.query(
          "select external_id from accounting_sync_records where id=$1",
          [record],
        )
      ).rows[0].external_id,
      "preserved-remote",
    )
    await db.exec(
      "alter table accounting_connections add column future_secret text",
    )
    await f.role("authenticated", () =>
      assert.rejects(
        db.exec("select future_secret from accounting_connections"),
        /permission denied/,
      ),
    )
  })
test("complete read-only ownership aggregate exceeds both former PostgREST ceilings and fences every scope", async (t) => {
  const f = await database(t, true),
    { db } = f
  await f.install()
  const division = id(10),
    community = id(11),
    foreignDivision = id(12),
    foreignCommunity = id(13),
    lastProject = id(1105 + 100),
    lastInvoice = id(1105 + 5000)
  await db.query("insert into divisions values($1,$2),($3,$4)", [
    division,
    org,
    foreignDivision,
    other,
  ])
  await db.query("insert into communities values($1,$2),($3,$4)", [
    community,
    org,
    foreignCommunity,
    other,
  ])
  for (let n = 1; n <= 1105; n++) {
    await db.query("insert into projects values($1,$2,$3,'delivery')", [
      id(n + 100),
      org,
      division,
    ])
    await db.query("insert into invoices values($1,$2,$3,123)", [
      id(n + 5000),
      org,
      id(n + 100),
    ])
  }
  await db.query("insert into lots values($1,$2,$3,$4)", [
    id(30),
    org,
    lastProject,
    community,
  ])
  await db.query(
    "insert into accounting_sync_records(org_id,connection_id,entity_type,entity_id,external_id) values($1,$2,'invoice',$3,'only-remote-after-both-ceilings')",
    [org, connection, lastInvoice],
  )
  const count = async ({
    tenant = org,
    book = connection,
    project = null,
    divisionId = null,
    communityId = null,
  } = {}) =>
    (
      await db.query(
        "select accounting_count_synced_scope($1,$2,$3,$4,$5)::integer n",
        [tenant, book, project, divisionId, communityId],
      )
    ).rows[0].n
  const financialSnapshot = async () => {
    const rows = []
    for (const table of [
      "invoices",
      "project_expenses",
      "vendor_bills",
      "payments",
    ])
      rows.push(
        (
          await db.query(
            `select count(*)::integer n,coalesce(sum(amount_cents),0)::text amount from ${table}`,
          )
        ).rows[0],
      )
    return rows
  }
  const before = await financialSnapshot()
  await f.role("service_role", async () => {
    assert.equal(await count({ divisionId: division }), 1)
    assert.equal(await count({ communityId: community }), 1)
    assert.equal(await count({ project: lastProject }), 1)
    assert.equal(await count({ project: id(101) }), 0)
    assert.equal(await count(), 2) // Includes the fixture's original remote identity.
    assert.equal(await count({ tenant: other, book: foreign }), 0)
    await assert.rejects(count({ book: foreign }), /belong to the organization/)
    await assert.rejects(
      count({ divisionId: foreignDivision }),
      /belong to the organization/,
    )
    await assert.rejects(
      count({ communityId: foreignCommunity }),
      /belong to the organization/,
    )
    await assert.rejects(
      count({ project: lastProject, divisionId: division }),
      /Choose one/,
    )
  })
  assert.deepEqual(await financialSnapshot(), before)
  // Preserve all four existing financial identity families and exclude tenant
  // mismatches even when a stale row points at a same-org scoped project.
  for (const [n, table, type] of [
    [1, "project_expenses", "project_expense"],
    [2, "vendor_bills", "bill"],
    [3, "payments", "payment"],
  ]) {
    await db.query(`insert into ${table} values($1,$2,$3,321)`, [
      id(8000 + n),
      org,
      lastProject,
    ])
    await db.query(
      "insert into accounting_sync_records(org_id,connection_id,entity_type,entity_id,external_id) values($1,$2,$3,$4,$5)",
      [org, connection, type, id(8000 + n), "synthetic-remote"],
    )
  }
  await db.query("insert into invoices values($1,$2,$3,456)", [
    id(9000),
    other,
    lastProject,
  ])
  await db.query(
    "insert into accounting_sync_records(org_id,connection_id,entity_type,entity_id,external_id) values($1,$2,'invoice',$3,'foreign-row-must-not-match')",
    [org, connection, id(9000)],
  )
  await f.role("service_role", async () =>
    assert.equal(await count({ divisionId: division }), 4),
  )
  await db.query("update projects set phase='planning' where id=$1", [
    lastProject,
  ])
  await f.role("service_role", async () => {
    assert.equal(await count({ divisionId: division }), 0)
    assert.equal(await count({ project: lastProject }), 4)
    assert.equal(await count({ communityId: community }), 4)
  })
})
