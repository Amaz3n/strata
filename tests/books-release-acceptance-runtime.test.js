const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  GOLDEN_SCENARIOS,
  parseArgs,
  target,
  manifest,
  psql,
  verifyIdentity,
  verifyTap,
  execute,
} = require("../scripts/books-acceptance/runtime.cjs");
const { PRODUCTION } = require("../scripts/books-acceptance/catalog.cjs");
const root = path.resolve(__dirname, ".."),
  instance = "99400000-0000-4000-8000-000000000001";
const config = (dir) =>
  parseArgs([
    "--database-url-env",
    "BOOKS_ACCEPTANCE_DATABASE_URL",
    "--scenario",
    "SCHEMA-01",
    "--evidence-dir",
    dir,
  ]);
const env = {
  BOOKS_ACCEPTANCE_DATABASE_URL:
    "postgresql://postgres:secret@127.0.0.1:55422/postgres",
  BOOKS_ACCEPTANCE_INSTANCE_ID: instance,
};
function identity(m) {
  return {
    database: "postgres",
    serverVersion: "PostgreSQL 17 test adapter",
    inRecovery: false,
    cronEnabled: "off",
    marker: {
      instance_id: instance,
      project_id: "arc-books-acceptance-runtime-test",
      isolated: true,
      migration_manifest_sha256: m.migrationManifestSha256,
    },
    migrationVersions: [...m.versions],
  };
}
test("release catalog preserves every golden scenario and rejects unknown, duplicate or incomplete configuration", () => {
  assert.equal(GOLDEN_SCENARIOS.length, 28);
  assert.equal(new Set(GOLDEN_SCENARIOS).size, 28);
  const plan = fs.readFileSync(
    path.join(root, "advisor-plans/013-arc-books-completion-to-100.md"),
    "utf8",
  );
  const ids = [...plan.matchAll(/^\|\s+`([A-Z]+-\d{2})`\s+\|/gm)].map(
    (m) => m[1],
  );
  // Production scenarios share the runner but belong to the production checklist, not the Books plan.
  assert.deepEqual(GOLDEN_SCENARIOS.filter((id) => !(id in PRODUCTION)), ids);
  assert.throws(() => parseArgs(["--scenario", "all"]), /required/);
  assert.throws(
    () =>
      parseArgs(["--database-url-env", "NAME", "--database-url-env", "NAME"]),
    /Use/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--database-url-env",
        "NAME",
        "--scenario",
        "FAKE-01",
        "--evidence-dir",
        "/tmp/test",
      ]),
    /Unknown/,
  );
});
test("target guard refuses hosted/options/foreign marker identity, live cron and drifted or incomplete installed schema", () => {
  const m = manifest(root),
    t = target(env.BOOKS_ACCEPTANCE_DATABASE_URL, instance);
  verifyIdentity(identity(m), t, m);
  for (const raw of [
    "postgres://postgres:secret@db.example.com/postgres",
    "postgres://postgres@127.0.0.1/postgres?options=-csearch_path=public",
    "https://127.0.0.1/postgres",
    "postgres://127.0.0.1/postgres",
  ])
    assert.throws(() => target(raw, instance), /requires/);
  assert.throws(
    () => target(env.BOOKS_ACCEPTANCE_DATABASE_URL, null),
    /INSTANCE/,
  );
  for (const mutate of [
    (i) => (i.database = "customer"),
    (i) => (i.marker.instance_id = "foreign"),
    (i) => (i.marker.project_id = "arc-production"),
    (i) => (i.marker.isolated = false),
    (i) => (i.marker.migration_manifest_sha256 = "old"),
    (i) => (i.inRecovery = true),
    (i) => (i.cronEnabled = "on"),
    (i) => i.migrationVersions.pop(),
  ]) {
    const i = identity(m);
    mutate(i);
    assert.throws(() => verifyIdentity(i, t, m));
  }
});
test("psql transport passes credentials only in a bounded child environment and redacts failures; TAP cannot pass omissions, duplicates, skipped or failed assertions", () => {
  const t = target(env.BOOKS_ACCEPTANCE_DATABASE_URL, instance);
  let observed;
  assert.equal(
    psql(t, "select 1", (cmd, args, options) => {
      observed = { cmd, args, options };
      return { status: 0, stdout: "1\n" };
    }),
    "1",
  );
  assert.ok(!JSON.stringify(observed.args).includes("secret"));
  assert.equal(observed.options.env.PGPASSWORD, "secret");
  assert.equal(observed.options.env.PGCONNECT_TIMEOUT, "5");
  assert.equal(observed.options.timeout, 60000);
  assert.throws(
    () =>
      psql(t, "select 1", () => ({
        status: 1,
        stderr:
          "failed postgres://postgres:secret@127.0.0.1/postgres password secret",
      })),
    (e) => !e.message.includes("secret") && !e.message.includes("postgres://"),
  );
  assert.equal(verifyTap("BEGIN\n1..2\nok 1 - A\nok 2 - B\nROLLBACK"), 2);
  for (const s of [
    "1..2\nok 1 - A",
    "1..2\nok 1 - A\nok 1 - A",
    "1..1\nnot ok 1 - Failed",
    "1..1\nok 1 # SKIP",
    "1..1\nok 1 # TODO",
    "1..0 # SKIP",
    "ok 1",
    "1..1\nok 1\n1..1",
  ])
    assert.throws(() => verifyTap(s));
});
test("schema runner records each actual SQL input/result, never calls a missing golden scenario, and cannot overwrite evidence or call an unverified target", async (t) => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "books-release-runner-"),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const m = manifest(root),
    calls = [];
  const query = async (_t, sql) => {
    calls.push(sql);
    return calls.length === 1
      ? JSON.stringify(identity(m))
      : "1..1\nok 1 - explicit transport fixture";
  };
  const dir = path.join(parent, "pass");
  const r = await execute(config(dir), { root, env, query });
  assert.equal(r.status, "PASSED");
  assert.equal(r.results.length, m.tests.length);
  assert.equal(calls.length, m.tests.length + 2);
  assert.deepEqual(
    calls.slice(2),
    m.tests.map(
      (x) =>
        "set search_path=public,extensions;\n" +
        fs.readFileSync(path.join(root, x.path), "utf8"),
    ),
  );
  assert.equal(r.assertions, m.tests.length);
  assert.ok(
    !fs
      .readFileSync(path.join(dir, "evidence.json"), "utf8")
      .includes("secret"),
  );
  await assert.rejects(
    execute(config(dir), { root, env, query }),
    /never overwritten/,
  );
  calls.length = 0;
  await assert.rejects(
    execute(
      { ...config(path.join(parent, "all")), scenario: "all" },
      { root, env, query },
    ),
    /not implemented/,
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(parent, "all")), false);
  const failure = path.join(parent, "foreign");
  calls.length = 0;
  await assert.rejects(
    execute(config(failure), {
      root,
      env,
      query: async () =>
        JSON.stringify({ ...identity(m), database: "customer" }),
    }),
    /does not prove/,
  );
  const saved = JSON.parse(
    fs.readFileSync(path.join(failure, "evidence.json")),
  );
  assert.equal(saved.status, "FAILED");
  assert.equal(saved.results.length, 0);
  const bad = path.join(parent, "bad-tap");
  let count = 0;
  await assert.rejects(
    execute(config(bad), {
      root,
      env,
      query: async () =>
        ++count === 1
          ? JSON.stringify(identity(m))
          : "1..1\nnot ok 1 - accounting incorrect",
    }),
    /pgTAP failed/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(bad, "evidence.json"))).status,
    "FAILED",
  );
  assert.equal(count, 3);
});

test("source drift before SQL or during acceptance cannot publish a passing current-schema artifact", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "books-release-drift-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const mini = path.join(parent, "source");
  fs.mkdirSync(path.join(mini, "supabase/migrations"), { recursive: true });
  fs.mkdirSync(path.join(mini, "supabase/tests"), { recursive: true });
  const migration = path.join(
      mini,
      "supabase/migrations/20261004000000_fixture.sql",
    ),
    sql = path.join(mini, "supabase/tests/fixture.test.sql");
  fs.writeFileSync(migration, "-- explicit fixture only\n");
  fs.writeFileSync(sql, "select plan(1);\n");
  for (const phase of ["before-sql", "after-sql"]) {
    const m = manifest(mini),
      dir = path.join(parent, phase);
    let count = 0;
    const query = async () => {
      count++;
      if (count === 1) return JSON.stringify(identity(m));
      if (count === 2 && phase === "before-sql")
        fs.appendFileSync(sql, "-- changed\n");
      if (count === 3 && phase === "after-sql")
        fs.appendFileSync(migration, "-- changed\n");
      return "1..1\nok 1 - transport fixture";
    };
    await assert.rejects(
      execute(config(dir), { root: mini, env, query }),
      /changed/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"))).status,
      "FAILED",
    );
    assert.equal(count, phase === "before-sql" ? 2 : 3);
  }
});

test("duplicate migration versions name every conflicting file and prevent bootstrap before any target operation", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "books-migration-collision-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "supabase/migrations"), { recursive: true });
  fs.mkdirSync(path.join(dir, "supabase/tests"), { recursive: true });
  for (const name of ["20261004000000_first.sql", "20261004000000_second.sql"])
    fs.writeFileSync(
      path.join(dir, "supabase/migrations", name),
      "-- fixture\n",
    );
  fs.writeFileSync(
    path.join(dir, "supabase/tests/fixture.sql"),
    "select plan(1);\n",
  );
  assert.throws(
    () => manifest(dir),
    (error) =>
      /Duplicate migration versions/.test(error.message) &&
      /20261004000000_first.sql/.test(error.message) &&
      /20261004000000_second.sql/.test(error.message),
  );
  const workspace = path.join(dir, "isolated");
  assert.throws(
    () =>
      require("../scripts/books-acceptance/bootstrap.cjs").stage(
        workspace,
        55480,
        dir,
      ),
    /Duplicate migration/,
  );
  assert.equal(fs.existsSync(workspace), false);
});
