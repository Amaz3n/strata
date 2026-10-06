const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const id = (n) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
test("model revision migration preserves publication and scopes historical snapshots", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function public.has_org_permission(org uuid,permission text) returns boolean language sql as $$select org=nullif(current_setting('test.org',true),'')::uuid$$;
 create table orgs(id uuid primary key);create table app_users(id uuid primary key);
 create table floorplan_models(id uuid primary key,org_id uuid references orgs(id),status text,model jsonb);
 grant usage on schema public,auth to authenticated;`);
  await db.query("insert into orgs values($1),($2)", [id(1), id(2)]);
  await db.query("insert into app_users values($1)", [id(3)]);
  await db.query(
    "select set_config('test.actor',$1,false),set_config('test.org',$2,false)",
    [id(3), id(1)],
  );
  await db.query(
    "insert into floorplan_models values($1,$2,'published',$3),($4,$5,'draft',$6)",
    [
      id(4),
      id(1),
      { version: 1, revision: "published" },
      id(5),
      id(2),
      { version: 1, revision: "foreign" },
    ],
  );
  await db.exec(
    fs.readFileSync(
      path.join(
        __dirname,
        "../supabase/migrations/20261002011734_architectural_model_revisions.sql",
      ),
      "utf8",
    ),
  );
  await db.query(
    "update floorplan_models set model=$1,status='draft' where id=$2",
    [{ version: 1, revision: "working" }, id(4)],
  );
  const current = (
    await db.query("select * from floorplan_models where id=$1", [id(4)])
  ).rows[0];
  assert.equal(current.published_model.revision, "published");
  let history = (await db.query("select * from floorplan_model_revisions"))
    .rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].model.revision, "published");
  assert.equal(history[0].created_by, id(3));
  await db.query("update floorplan_models set model=model where id=$1", [
    id(4),
  ]);
  assert.equal(
    (await db.query("select * from floorplan_model_revisions")).rows.length,
    1,
  );
  await db.query("update floorplan_models set model=$1 where id=$2", [
    { revision: "foreign update" },
    id(5),
  ]);
  await db.exec("set role authenticated");
  history = (await db.query("select * from floorplan_model_revisions")).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].org_id, id(1));
  await assert.rejects(
    () => db.query("delete from floorplan_model_revisions"),
    /permission denied/,
  );
  await db.exec("reset role");
  await db.query(
    "update floorplan_models set published_model=null where id=$1",
    [id(4)],
  );
  assert.equal(
    (
      await db.query(
        "select published_model from floorplan_models where id=$1",
        [id(4)],
      )
    ).rows[0].published_model,
    null,
  );
});
