const fs = require("node:fs"),
  path = require("node:path"),
  { randomUUID, createHash } = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const { manifest, verifyIdentity, target, psql } = require("./runtime.cjs");
const root = path.resolve(__dirname, "../.."),
  CLI_VERSION = "2.117.0";
const digest = (x) => createHash("sha256").update(x).digest("hex");
// Docker hostnames are capped at 63 characters and the CLI names containers
// `supabase_<service>_<project>`; the longest service prefix is
// `supabase_edge_runtime_` (22), so a full UUID suffix makes auth/storage fail
// to resolve the database host. Twelve hex digits keep each run unique.
const acceptanceProjectId = (instanceId) =>
  "arc-books-acceptance-" + instanceId.replace(/-/g, "").slice(0, 12);
function configuration(projectId, port) {
  return `project_id = "${projectId}"\n[api]\nenabled=false\nport=${port + 2}\n[db]\nport=${port}\nshadow_port=${port + 1}\nmajor_version=17\n[db.migrations]\nenabled=true\nschema_paths=[]\n[db.seed]\nenabled=false\nsql_paths=[]\n[auth]\nenabled=true\nsite_url="http://127.0.0.1:3000"\nenable_signup=false\n[auth.mfa.totp]\nenroll_enabled=true\nverify_enabled=true\n[storage]\nenabled=true\n[realtime]\nenabled=false\n[studio]\nenabled=false\n[inbucket]\nenabled=false\n[analytics]\nenabled=false\n`;
}
// A baseline route replays only the listed migrations, e.g. the files the
// production ledger records, so an upgrade can start from that schema.
function inventoryFor(sourceRoot, baseline) {
  const current = manifest(sourceRoot);
  if (!baseline) return current;
  const known = new Set(current.migrations.map((m) => m.path));
  const missing = baseline.filter((p) => !known.has(p));
  if (missing.length || !baseline.length || new Set(baseline).size !== baseline.length)
    throw Error("Baseline lists unknown, duplicate or no migrations: " + missing.join(", "));
  const migrations = current.migrations.filter((m) => baseline.includes(m.path));
  return {
    ...current,
    migrations,
    versions: migrations.map((m) => path.basename(m.path).split("_")[0]),
    migrationManifestSha256: digest(JSON.stringify(migrations)),
  };
}
function stage(workspace, port, sourceRoot = root, baseline) {
  workspace = path.resolve(workspace);
  if (!Number.isInteger(port) || port < 1024 || port > 65532)
    throw Error(
      "Use an explicit unoccupied database port between 1024 and 65532",
    );
  if (fs.existsSync(workspace))
    throw Error(
      "Bootstrap requires a new workspace; existing databases/workspaces are never reset",
    );
  const instanceId = randomUUID(),
    projectId = acceptanceProjectId(instanceId);
  const inventory = inventoryFor(sourceRoot, baseline),
    config = configuration(projectId, port);
  fs.mkdirSync(path.join(workspace, "supabase/migrations"), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(workspace, "supabase/tests"), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(path.join(workspace, "supabase/config.toml"), config, {
    mode: 0o600,
  });
  const job = {
    schemaVersion: 1,
    status: "STAGED",
    route: baseline ? "baseline" : "fresh",
    ...(baseline ? { baseline } : {}),
    workspace,
    sourceRoot: path.resolve(sourceRoot),
    instanceId,
    projectId,
    container: "supabase_db_" + projectId,
    port,
    cliVersion: CLI_VERSION,
    inventory,
    configSha256: digest(config),
    steps: [],
    createdAt: new Date().toISOString(),
    existingArcDatabaseModified: false,
  };
  save(job);
  return job;
}
function save(job) {
  fs.writeFileSync(
    path.join(job.workspace, "bootstrap.json"),
    JSON.stringify(job, null, 2) + "\n",
    { mode: 0o600 },
  );
}
function read(workspace, sourceRoot = root) {
  const job = JSON.parse(
    fs.readFileSync(path.join(workspace, "bootstrap.json"), "utf8"),
  );
  if (
    job.status !== "STAGED" ||
    job.workspace !== path.resolve(workspace) ||
    job.sourceRoot !== path.resolve(sourceRoot) ||
    job.cliVersion !== CLI_VERSION ||
    !Number.isInteger(job.port) ||
    job.port < 1024 ||
    job.port > 65532 ||
    configuration(job.projectId, job.port) !==
      fs.readFileSync(path.join(workspace, "supabase/config.toml"), "utf8") ||
    job.container !== "supabase_db_" + job.projectId ||
    job.projectId !== acceptanceProjectId(job.instanceId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      job.instanceId,
    ) ||
    JSON.stringify(job.inventory) !==
      JSON.stringify(inventoryFor(sourceRoot, job.baseline)) ||
    digest(fs.readFileSync(path.join(workspace, "supabase/config.toml"))) !==
      job.configSha256
  )
    throw Error(
      "Bootstrap state/source/config changed or is already attempted; inspect retained evidence before recovery",
    );
  for (const dir of ["migrations", "tests"])
    if (fs.readdirSync(path.join(workspace, "supabase", dir)).length)
      throw Error(
        "Application SQL must remain absent until the isolated cron fence is proven",
      );
  return job;
}
function clean(s) {
  return String(s ?? "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED DATABASE URL]")
    .split(/\r?\n/)
    .map((line) =>
      /\b(?:JWT_SECRET|SERVICE_ROLE_KEY|ANON_KEY|PASSWORD|ACCESS_TOKEN)\s*[:=]/i.test(
        line,
      )
        ? "[REDACTED CREDENTIAL OUTPUT]"
        : line,
    )
    .join("\n");
}
function execute(
  job,
  { run = spawnSync, query = psql, sourceRoot = root } = {},
) {
  if (job.status !== "STAGED" || job.sourceRoot !== path.resolve(sourceRoot))
    throw Error("Only an untouched staged bootstrap can execute");
  if (JSON.stringify(read(job.workspace, sourceRoot)) !== JSON.stringify(job))
    throw Error(
      "Bootstrap execution state differs from its retained staged identity",
    );
  job.status = "RUNNING";
  job.processId = process.pid;
  save(job);
  const processEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  function command(name, args, phase, timeout = 30000, input) {
    const step = {
      phase,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
    };
    job.steps.push(step);
    save(job);
    const r = run(name, args, {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      input,
      env: processEnv,
      cwd: job.workspace,
    });
    const log = clean((r.stdout ?? "") + "\n" + (r.stderr ?? "")),
      file = `${String(job.steps.length).padStart(2, "0")}-${phase}.log`;
    fs.writeFileSync(path.join(job.workspace, file), log, { mode: 0o600 });
    step.log = file;
    step.sha256 = digest(log);
    step.finishedAt = new Date().toISOString();
    step.status = r.error || r.status !== 0 ? "FAILED" : "PASSED";
    save(job);
    if (step.status !== "PASSED")
      throw Error(
        `${phase} failed${r.error?.code ? ": " + r.error.code : ""}; inspect retained ${file}`,
      );
    return (r.stdout ?? "").trim();
  }
  try {
    const host = command(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      "local-engine-context",
      8000,
    );
    if (!host.startsWith("unix:///"))
      throw Error("Bootstrap requires the local Unix-socket Docker context");
    const ready = JSON.parse(
      command(
        process.execPath,
        [path.join(__dirname, "engine-probe.cjs"), host],
        "engine-readiness",
        8000,
      ),
    );
    if (
      !ready ||
      typeof ready.version !== "string" ||
      typeof ready.apiVersion !== "string"
    )
      throw Error("Docker readiness receipt is invalid");
    const engine = command(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      "engine-version",
      8000,
    );
    if (!/^\d+\.\d+/.test(engine))
      throw Error("Docker engine did not return a usable version");
    if (engine !== ready.version)
      throw Error("Docker engine version changed during readiness checks");
    job.engineVersion = engine;
    const cli = command(
      "pnpm",
      ["dlx", `supabase@${CLI_VERSION}`, "--version"],
      "pinned-cli-version",
      60000,
    );
    if (cli !== CLI_VERSION)
      throw Error("Bootstrap CLI version differs from the accepted/CI pin");
    command(
      "pnpm",
      [
        "dlx",
        `supabase@${CLI_VERSION}`,
        "db",
        "start",
        "--workdir",
        job.workspace,
      ],
      "empty-database-start",
      180000,
    );
    const identity = command(
      "docker",
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.supabase.cli.project"}}|{{.State.Running}}',
        job.container,
      ],
      "new-container-identity",
      8000,
    );
    if (identity !== `${job.projectId}|true`)
      throw Error(
        "Created container does not prove the isolated project identity",
      );
    const args = [
      "exec",
      "-i",
      job.container,
      "psql",
      "-X",
      "-A",
      "-t",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ];
    const empty = command(
      "docker",
      args,
      "empty-application-check",
      10000,
      "select to_regclass('public.orgs') is null;\n",
    );
    if (empty !== "t")
      throw Error(
        "Isolated database already contains application data/schema; never reset it",
      );
    // ALTER SYSTEM needs a superuser; on Supabase images that is supabase_admin,
    // not postgres.
    const adminArgs = args.map((arg, i) =>
      args[i - 1] === "-U" ? "supabase_admin" : arg,
    );
    command(
      "docker",
      adminArgs,
      "disable-background-cron",
      10000,
      "alter system set cron.launch_active_jobs='off';select pg_reload_conf();\n",
    );
    const cron = command(
      "docker",
      args,
      "verify-cron-fence",
      10000,
      "select current_setting('cron.launch_active_jobs',true);\n",
    );
    if (!["off", "false"].includes(cron))
      throw Error("Background cron was not disabled before application replay");
    if (JSON.stringify(inventoryFor(sourceRoot, job.baseline)) !==
        JSON.stringify(job.inventory))
      throw Error("Application source changed before replay");
    for (const file of [...job.inventory.migrations, ...job.inventory.tests]) {
      const bytes = fs.readFileSync(path.join(sourceRoot, file.path));
      if (digest(bytes) !== file.sha256)
        throw Error("Replay input hash changed");
      fs.writeFileSync(path.join(job.workspace, file.path), bytes, {
        mode: 0o600,
      });
    }
    command(
      "pnpm",
      [
        "dlx",
        `supabase@${CLI_VERSION}`,
        "migration",
        "up",
        "--local",
        "--include-all",
        "--workdir",
        job.workspace,
      ],
      "current-migration-replay",
      1200000,
    );
    const versions = JSON.parse(
      command(
        "docker",
        args,
        "installed-migration-identity",
        10000,
        "select json_agg(version order by version) from supabase_migrations.schema_migrations;\n",
      ),
    );
    if (
      JSON.stringify([...versions].sort()) !==
        JSON.stringify([...job.inventory.versions].sort()) ||
      JSON.stringify(inventoryFor(sourceRoot, job.baseline)) !==
        JSON.stringify(job.inventory)
    )
      throw Error(
        "Installed migration or source inventory differs from replay inputs",
      );
    const marker = `create schema books_acceptance;create table books_acceptance.environment(singleton boolean primary key default true check(singleton),instance_id uuid not null,project_id text not null,isolated boolean not null check(isolated),migration_manifest_sha256 text not null);insert into books_acceptance.environment(instance_id,project_id,isolated,migration_manifest_sha256) values('${job.instanceId}','${job.projectId}',true,'${job.inventory.migrationManifestSha256}');`;
    command("docker", args, "create-isolated-marker", 10000, marker);
    const t = target(
      `postgresql://postgres@127.0.0.1:${job.port}/postgres`,
      job.instanceId,
      job.container,
    );
    const proof = JSON.parse(
      query(
        t,
        "select json_build_object('database',current_database(),'serverVersion',version(),'inRecovery',pg_is_in_recovery(),'cronEnabled',current_setting('cron.launch_active_jobs',true),'marker',(select row_to_json(x) from books_acceptance.environment x),'migrationVersions',(select json_agg(version order by version) from supabase_migrations.schema_migrations));",
      ),
    );
    verifyIdentity(proof, t, job.inventory);
    job.databaseIdentity = proof;
    job.status = "REPLAYED";
    job.connection = {
      urlEnv: "BOOKS_ACCEPTANCE_DATABASE_URL",
      url: `postgresql://postgres@127.0.0.1:${job.port}/postgres`,
      instanceEnv: "BOOKS_ACCEPTANCE_INSTANCE_ID",
      instanceId: job.instanceId,
      containerEnv: "BOOKS_ACCEPTANCE_CONTAINER",
      container: job.container,
    };
  } catch (e) {
    job.status = "FAILED";
    job.error = clean(e.message);
    throw e;
  } finally {
    job.finishedAt = new Date().toISOString();
    save(job);
  }
  return job;
}
module.exports = { CLI_VERSION, configuration, stage, read, execute, clean };
