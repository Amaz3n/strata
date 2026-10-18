const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
    fixture,
  } = require("./helpers/books-private-payroll-documents-fixture"),
  { id, org } = require("./helpers/books-payroll-register-fixture");
async function setup(t) {
  const f = await fixture(t);
  await f.db.exec(
    "alter table app_users add email text,add full_name text;grant select on app_users to service_role",
  );
  await f.db.exec(
    migrationSql("20261004064206_books_payroll_worker_directory"),
  );
  for (const row of (
    await f.db.query("select distinct user_id from memberships")
  ).rows)
    await f.db.query("update app_users set email=$2,full_name=$3 where id=$1", [
      row.user_id,
      row.user_id + "@example.test",
      row.user_id === id(52) ? "Foreign worker" : "Native worker",
    ]);
  return f;
}
const read = (f, args = [org, null, "", 50]) =>
  f.db.query("select read_books_payroll_workers($1,$2,$3,$4) result", args);
test("directory paginates unique native workers, preserves historical memberships, scopes names and treats search literally", async (t) => {
  const f = await setup(t);
  await f.db.query("insert into memberships values($1,$2,'inactive')", [
    org,
    id(2),
  ]);
  for (let n = 0; n < 55; n++) {
    await f.db.query("insert into app_users values($1,$2,$3)", [
      id(9000 + n),
      "worker" + n + "@example.test",
      n === 0 ? "100%_ crew" : "Worker " + n,
    ]);
    await f.db.query("insert into memberships values($1,$2,'active')", [
      org,
      id(9000 + n),
    ]);
  }
  await f.db.exec("set role service_role");
  const first = (await read(f)).rows[0].result,
    next = (await read(f, [org, first.nextCursor, "", 50])).rows[0].result;
  assert.equal(first.workers.length, 50);
  assert.equal(next.workers.length, 8);
  assert.equal(next.nextCursor, null);
  assert.equal(
    new Set([...first.workers, ...next.workers].map((worker) => worker.id))
      .size,
    58,
  );
  assert.deepEqual(
    first.workers.find((worker) => worker.id === id(2)).statuses,
    ["active", "inactive"],
  );
  assert.ok(
    ![...first.workers, ...next.workers].some((worker) => worker.id === id(52)),
  );
  assert.equal(
    (await read(f, [org, null, "foreign", 50])).rows[0].result.workers.length,
    0,
  );
  assert.deepEqual(
    (await read(f, [org, null, "%_", 50])).rows[0].result.workers.map(
      (worker) => worker.id,
    ),
    [id(9000)],
  );
  for (const worker of first.workers)
    assert.deepEqual(Object.keys(worker).sort(), [
      "email",
      "id",
      "name",
      "statuses",
    ]);
});
test("worker directory is stable invoker/service-only and rejects invalid page/search inputs", async (t) => {
  const f = await setup(t);
  for (const args of [
    [null, null, "", 50],
    [org, null, "", 0],
    [org, null, "", 51],
    [org, null, null, 50],
    [org, null, "x".repeat(201), 50],
  ])
    await assert.rejects(read(f, args), /Invalid/);
  const privileges = (
    await f.db.query(
      "select prosecdef,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='read_books_payroll_workers'",
    )
  ).rows[0];
  assert.deepEqual(privileges, {
    prosecdef: false,
    browser: false,
    anon: false,
    service: true,
  });
  await f.db.exec("set role authenticated");
  await assert.rejects(read(f), /permission denied/);
});
