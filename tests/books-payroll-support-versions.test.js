const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const {
    fixture,
  } = require("./helpers/books-private-payroll-documents-fixture"),
  { id, org } = require("./helpers/books-payroll-register-fixture");
const sql = migrationSql("20261004080920_books_payroll_support_versions");
const read = async (f, args = [org, null, "", 50]) =>
  (
    await f.db.query(
      "select read_books_payroll_support_versions($1,$2,$3,$4) result",
      args,
    )
  ).rows[0].result;
test("supporting versions read retains private history, scopes organization, excludes general files and paginates exactly with literal filename search", async (t) => {
  const f = await fixture(t);
  await f.db.exec(sql);
  for (let n = 9000; n < 9055; n++)
    await f.db.query(
      "insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,'text/csv',3,$6)",
      [
        id(n),
        org,
        id(8),
        org + "/history/" + n + ".csv",
        n === 9000 ? "100%_statement.csv" : "Retained statement " + n + ".csv",
        "a".repeat(64),
      ],
    );
  await f.db.query(
    "insert into files(id,org_id,storage_path,file_name) values($1,$2,$3,'Public statement.csv')",
    [id(9100), org, org + "/general.csv"],
  );
  await f.db.query(
    "insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,'Public statement.csv','text/csv',3,$5)",
    [id(9101), org, id(9100), org + "/general.csv", "a".repeat(64)],
  );
  await f.db.exec("set role service_role");
  const first = await read(f),
    next = await read(f, [org, first.nextCursor, "", 50]);
  assert.equal(first.versions.length, 50);
  assert.equal(next.nextCursor, null);
  const rows = [...first.versions, ...next.versions];
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.ok(rows.some((row) => row.id === id(9000)));
  assert.ok(!rows.some((row) => row.id === id(9101)));
  assert.ok(rows.every((row) => row.org_id === org));
  assert.deepEqual(
    (await read(f, [org, null, "%_", 50])).versions.map((row) => row.id),
    [id(9000)],
  );
  assert.equal((await read(f, [id(99), null, "", 50])).versions.length, 0);
  assert.ok(rows.every((row) => !("storage_path" in row)));
});
test("support picker RPC uses service-only invoker privileges and rejects invalid page/search input", async (t) => {
  const f = await fixture(t);
  await f.db.exec(sql);
  assert.deepEqual(
    (
      await f.db.query(
        "select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='read_books_payroll_support_versions'",
      )
    ).rows[0],
    { prosecdef: false, anon: false, browser: false, service: true },
  );
  for (const args of [
    [null, null, "", 50],
    [org, null, "", 51],
    [org, null, null, 50],
    [org, null, "x".repeat(201), 50],
  ])
    await assert.rejects(read(f, args), /Invalid/);
  await f.db.exec("set role authenticated");
  await assert.rejects(read(f), /permission denied/);
});
test("project support-version service checks draft scope before private metadata and verifies org and version identity", async () => {
  let calls = [],
    denied = false,
    foreign = false;
  const original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "./payroll-draft-workspace")
        return {
          getProjectPayrollDraftDetail: async (input) => {
            calls.push(["scope", input]);
            if (denied) throw Error("Denied project payroll");
          },
        };
      if (name === "@/lib/services/context")
        return { requireOrgContext: async () => ({ orgId: org }) };
      if (name === "@/lib/supabase/server")
        return {
          createServiceSupabaseClient: () => ({
            rpc: async (name, args) => {
              calls.push(["rpc", name, args]);
              return {
                data: {
                  orgId: org,
                  versions: [
                    {
                      id: id(7),
                      org_id: foreign ? id(99) : org,
                      file_id: id(8),
                      file_name: "Private original.csv",
                      mime_type: "text/csv",
                      size_bytes: 3,
                      checksum: "a".repeat(64),
                    },
                  ],
                  nextCursor: null,
                },
                error: null,
              };
            },
          }),
        };
      return original.call(this, name, ...args);
    };
    api = require("../lib/services/books/payroll-support-versions");
  } finally {
    Module._load = original;
  }
  const input = { projectId: id(4), importId: id(6), search: "%_" };
  denied = true;
  await assert.rejects(api.readProjectPayrollSupportVersions(input), /Denied/);
  assert.equal(calls.length, 1);
  denied = false;
  calls = [];
  const page = await api.readProjectPayrollSupportVersions(input);
  assert.equal(page.versions.length, 1);
  assert.equal(calls[0][0], "scope");
  assert.equal(calls[1][2].p_search, "%_");
  foreign = true;
  await assert.rejects(api.readProjectPayrollSupportVersions(input));
});
