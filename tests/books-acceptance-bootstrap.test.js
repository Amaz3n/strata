const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  stage,
  read,
  execute,
  CLI_VERSION,
  clean,
} = require("../scripts/books-acceptance/bootstrap.cjs");
const { psql, target } = require("../scripts/books-acceptance/runtime.cjs");
const instance = "99400000-0000-4000-8000-000000000001";
test("empty-success Docker readiness stops before CLI/container creation and retains a failed receipt", (t) => {
  const job = stage(directory(t), 55480),
    a = adapters(job);
  const run = (name, args, settings) => {
    if (name === process.execPath && args[0].endsWith("engine-probe.cjs")) {
      a.calls.push({ name, args, settings });
      return {
        status: 1,
        stdout: "",
        stderr: "Docker version endpoint returned empty or invalid JSON",
      };
    }
    return a.run(name, args, settings);
  };
  assert.throws(() => execute(job, { ...a, run }), /engine-readiness failed/);
  assert.equal(job.status, "FAILED");
  assert.equal(job.steps.at(-1).phase, "engine-readiness");
  assert.equal(job.steps.at(-1).status, "FAILED");
  assert.ok(
    !a.calls.some((call) => call.name === "pnpm" || call.args[0] === "info"),
  );
  assert.equal(
    fs.readdirSync(path.join(job.workspace, "supabase/migrations")).length,
    0,
  );
});
function directory(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "books-bootstrap-test-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return path.join(p, "new");
}
function adapters(job, options = {}) {
  const calls = [];
  const run = (name, args, settings) => {
    calls.push({ name, args, settings });
    let stdout = "";
    if (name === process.execPath && args[0].endsWith("engine-probe.cjs"))
      stdout = JSON.stringify({ version: "28.0.1", apiVersion: "1.47" });
    else if (name === "docker" && args[0] === "context")
      stdout = "unix:///test/docker.sock";
    else if (name === "docker" && args[0] === "info")
      stdout = options.emptyEngine ? "" : "28.0.1";
    else if (name === "pnpm" && args.includes("--version"))
      stdout = options.oldCli ? "2.67.1" : CLI_VERSION;
    else if (name === "pnpm" && args.includes("start"))
      assert.equal(
        fs.readdirSync(path.join(job.workspace, "supabase/migrations")).length,
        0,
      );
    else if (name === "docker" && args[0] === "inspect")
      stdout =
        (options.foreignContainer ? "arc-production" : job.projectId) + "|true";
    else if (name === "docker" && args[0] === "exec") {
      if (settings.input.includes("to_regclass")) stdout = "t";
      else if (settings.input.includes("pg_reload_conf")) stdout = "t";
      else if (settings.input.includes("current_setting"))
        stdout = options.cronLive ? "on" : "off";
      else if (settings.input.includes("json_agg(version"))
        stdout = JSON.stringify(job.inventory.versions);
    } else if (name === "pnpm" && args.includes("up")) {
      assert.equal(
        fs.readdirSync(path.join(job.workspace, "supabase/migrations")).length,
        job.inventory.migrations.length,
      );
      assert.ok(
        calls.some((c) =>
          c.settings.input?.includes(
            "alter system set cron.launch_active_jobs",
          ),
        ),
      );
      assert.ok(
        calls.some((c) =>
          c.settings.input?.includes(
            "select current_setting('cron.launch_active_jobs'",
          ),
        ),
      );
    }
    return { status: 0, stdout, stderr: "" };
  };
  const query = (asyncUnused) => {
    assert.equal(asyncUnused.container, job.container);
    return JSON.stringify({
      database: "postgres",
      serverVersion: "PostgreSQL 17.6 explicit fixture",
      inRecovery: false,
      cronEnabled: "off",
      marker: {
        instance_id: job.instanceId,
        project_id: job.projectId,
        isolated: true,
        migration_manifest_sha256: job.inventory.migrationManifestSha256,
      },
      migrationVersions: job.inventory.versions,
    });
  };
  return { calls, run, query };
}
test("bootstrap stages a unique isolated project with no application migrations, no secrets, exact source hashes and no reuse/reset", (t) => {
  const dir = directory(t),
    job = stage(dir, 55480);
  assert.match(job.projectId, /^arc-books-acceptance-[a-f0-9]{12}$/);
  assert.ok(("supabase_edge_runtime_" + job.projectId).length <= 63);
  assert.equal(job.container, "supabase_db_" + job.projectId);
  assert.equal(job.status, "STAGED");
  assert.equal(fs.readdirSync(path.join(dir, "supabase/migrations")).length, 0);
  assert.deepEqual(read(dir), job);
  assert.throws(() => stage(dir, 55480), /never reset/);
  assert.throws(() => stage(directory(t), 543), /port/);
  const modified = { ...job, container: "supabase_db_arc-production" };
  let calls = 0;
  assert.throws(() => execute(modified, { run: () => calls++ }), /differs/);
  assert.equal(calls, 0);
  fs.appendFileSync(path.join(dir, "supabase/config.toml"), "# changed\n");
  assert.throws(() => read(dir), /changed/);
});
test("bootstrap proves empty container and disabled cron before replay, pins CLI and retains native-command evidence without claiming golden/upgrade acceptance", (t) => {
  const job = stage(directory(t), 55480),
    a = adapters(job);
  execute(job, a);
  assert.equal(job.status, "REPLAYED");
  assert.equal(job.route, "fresh");
  assert.equal(job.connection.container, job.container);
  assert.ok(a.calls.every((c) => !c.settings.env.SUPABASE_ACCESS_TOKEN));
  assert.ok(a.calls.every((c) => c.settings.killSignal === "SIGKILL"));
  assert.ok(
    a.calls
      .filter((c) => c.name === "pnpm")
      .every((c) => c.args.includes("supabase@2.117.0")),
  );
  assert.ok(job.steps.every((s) => s.status === "PASSED" && s.sha256 && s.log));
  assert.throws(() => read(job.workspace), /already attempted/);
  assert.equal(
    clean(
      "DB_URL=postgres://postgres:secret@localhost/postgres\nSERVICE_ROLE_KEY=secret",
    ),
    "DB_URL=[REDACTED DATABASE URL]\n[REDACTED CREDENTIAL OUTPUT]",
  );
});
test("empty engine, wrong CLI, foreign container or live cron cannot reach application replay or marker creation", (t) => {
  for (const option of [
    "emptyEngine",
    "oldCli",
    "foreignContainer",
    "cronLive",
  ]) {
    const job = stage(directory(t), 55480),
      a = adapters(job, { [option]: true });
    assert.throws(() => execute(job, a));
    assert.equal(job.status, "FAILED");
    assert.ok(!a.calls.some((c) => c.args.includes("up")));
    assert.ok(
      !a.calls.some((c) =>
        c.settings.input?.includes("create schema books_acceptance"),
      ),
    );
    assert.equal(
      fs.readdirSync(path.join(job.workspace, "supabase/migrations")).length,
      0,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(job.workspace, "bootstrap.json")))
        .status,
      "FAILED",
    );
  }
});
test("container PostgreSQL transport requires local Docker, matching project/running/port and marker identity before using native psql", () => {
  const name = "supabase_db_arc-books-acceptance-unit",
    t = target("postgres://postgres@127.0.0.1:55480/postgres", instance, name);
  let calls = [];
  const run = (command, args, settings) => {
    calls.push({ command, args, settings });
    if (args[0] === "context")
      return { status: 0, stdout: "unix:///test/docker.sock" };
    if (args[0] === "inspect")
      return {
        status: 0,
        stdout:
          'arc-books-acceptance-unit|true|{"5432/tcp":[{"HostPort":"55480"}]}',
      };
    return { status: 0, stdout: "1" };
  };
  assert.equal(psql(t, "select 1", run), "1");
  assert.deepEqual(calls[2].args.slice(0, 4), ["exec", "-i", name, "psql"]);
  assert.equal(calls[2].settings.input, "select 1");
  for (const output of [
    'arc-production|true|{"5432/tcp":[{"HostPort":"55480"}]}',
    'arc-books-acceptance-unit|false|{"5432/tcp":[{"HostPort":"55480"}]}',
    'arc-books-acceptance-unit|true|{"5432/tcp":[{"HostPort":"54322"}]}',
  ]) {
    let writes = 0;
    assert.throws(
      () =>
        psql(t, "select 1", (_c, args) =>
          args[0] === "context"
            ? { status: 0, stdout: "unix:///test/docker.sock" }
            : args[0] === "inspect"
              ? { status: 0, stdout: output }
              : (writes++, { status: 0, stdout: "1" }),
        ),
      /differs/,
    );
    assert.equal(writes, 0);
  }
  assert.throws(
    () =>
      psql(t, "select 1", () => ({
        status: 0,
        stdout: "tcp://remote.example:2375",
      })),
    /local Unix/,
  );
  assert.throws(
    () =>
      target(
        "postgres://postgres@localhost/postgres",
        instance,
        "supabase_db_arc",
      ),
    /isolated acceptance/,
  );
});

test("a process that ignores termination is killed at the deadline and cannot leave bootstrap running", (t) => {
  const job = stage(directory(t), 55480);
  const { spawnSync } = require("node:child_process");
  const started = Date.now();
  assert.throws(
    () =>
      execute(job, {
        run: (_command, args, options) => {
          if (args[0] === "context")
            return { status: 0, stdout: "unix:///test/docker.sock" };
          return spawnSync(
            process.execPath,
            ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
            { ...options, timeout: 150 },
          );
        },
      }),
    /ETIMEDOUT/,
  );
  assert.equal(job.status, "FAILED");
  assert.ok(Date.now() - started < 5000);
  assert.equal(job.steps.length, 2);
  assert.equal(job.steps[1].status, "FAILED");
});
test("baseline route stages only the listed migrations and re-derives the same subset on read", (t) => {
  const all = fs
    .readdirSync(path.join(__dirname, "../supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((n) => `supabase/migrations/${n}`);
  const baseline = all.slice(0, 3),
    dir = directory(t),
    job = stage(dir, 55480, undefined, baseline);
  assert.equal(job.route, "baseline");
  assert.deepEqual(
    job.inventory.migrations.map((m) => m.path),
    baseline,
  );
  assert.deepEqual(
    job.inventory.versions,
    baseline.map((p) => path.basename(p).split("_")[0]),
  );
  assert.deepEqual(read(dir), job);
  assert.throws(
    () => stage(directory(t), 55480, undefined, [...baseline, "supabase/migrations/missing.sql"]),
    /unknown, duplicate or no migrations/,
  );
  assert.throws(
    () => stage(directory(t), 55480, undefined, [baseline[0], baseline[0]]),
    /unknown, duplicate or no migrations/,
  );
});
