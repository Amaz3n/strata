const fs = require("node:fs"),
  path = require("node:path"),
  { createHash, randomUUID } = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const GOLDEN_SCENARIOS = [
  "MIG-01",
  "GREEN-01",
  "BILL-01",
  "HIST-01",
  "WIP-01",
  "LOSS-01",
  "REV-01",
  "HOME-01",
  "DIM-01",
  "BANK-01",
  "PAY-01",
  "PAY-02",
  "CASH-01",
  "TAX-01",
  "ENTITY-01",
  "INTERCO-01",
  "CONSOL-01",
  "CLOSE-01",
  "YEAR-01",
  "STATUS-01",
  "RACE-01",
  "STORE-01",
  "RESTORE-01",
  "CAP-01",
  "AUTH-01",
  "LOT-01",
  "RACE-02",
  "SEC-01",
  "PROD-01",
  "LAND-01",
  "LEAD-01",
  "SALE-01",
  "SEL-01",
  "PERMIT-01",
  "FLOW-01",
  "CUT-01",
  "RELEASE-01",
  "TRADE-01",
  "BID-01",
  "PO-01",
  "VPO-01",
  "SUPPLY-01",
  "FIELD-01",
  "MONEY-01",
  "WARR-01",
  "CUTOVER-01",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function parseArgs(args) {
  if (args.length === 1 && args[0] === "--list") return { list: true };
  const allowed = new Set([
      "--database-url-env",
      "--scenario",
      "--evidence-dir",
    ]),
    values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !allowed.has(args[i]) ||
      values[args[i]] ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error(
        "Use --database-url-env NAME --scenario ID|all --evidence-dir DIRECTORY",
      );
    values[args[i]] = args[i + 1];
  }
  if (
    allowed.size !== Object.keys(values).length ||
    !/^[A-Z][A-Z0-9_]*$/.test(values["--database-url-env"])
  )
    throw Error("Explicit acceptance configuration is required");
  const scenario = values["--scenario"];
  if (!["all", "SCHEMA-01", ...GOLDEN_SCENARIOS].includes(scenario))
    throw Error("Unknown acceptance scenario");
  return {
    urlEnv: values["--database-url-env"],
    scenario,
    evidenceDir: path.resolve(values["--evidence-dir"]),
  };
}
function target(raw, instance, container) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error("Acceptance database URL is missing or invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !url.username ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw Error(
      "Acceptance requires an explicit loopback PostgreSQL database; hosted, option-bearing and customer targets are refused",
    );
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      instance ?? "",
    )
  )
    throw Error(
      "BOOKS_ACCEPTANCE_INSTANCE_ID must identify the explicitly isolated database marker",
    );
  if (
    container !== undefined &&
    !/^supabase_db_arc-books-acceptance-[a-z0-9-]+$/.test(container)
  )
    throw Error(
      "Only an explicitly isolated acceptance container is supported",
    );
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    instance,
    ...(container
      ? { container, projectId: container.slice("supabase_db_".length) }
      : {}),
  };
}
function manifest(root) {
  const inventory = (dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map((n) => ({
        path: `${dir}/${n}`,
        sha256: sha(fs.readFileSync(path.join(root, dir, n))),
      }));
  const migrations = inventory("supabase/migrations"),
    tests = inventory("supabase/tests");
  const versions = migrations.map((m) => path.basename(m.path).split("_")[0]);
  const duplicateVersions = [...new Set(versions)].filter(
    (version) =>
      versions.filter((candidate) => candidate === version).length > 1,
  );
  if (duplicateVersions.length)
    throw Error(
      "Duplicate migration versions: " +
        migrations
          .filter((file) =>
            duplicateVersions.includes(path.basename(file.path).split("_")[0]),
          )
          .map((file) => file.path)
          .join(", "),
    );
  if (
    !versions.length ||
    versions.some((v) => !/^\d{14}$/.test(v)) ||
    !tests.length
  )
    throw Error("Current migration/test inventory is incomplete or ambiguous");
  return {
    migrations,
    tests,
    versions,
    migrationManifestSha256: sha(JSON.stringify(migrations)),
  };
}
function redact(value, t) {
  let s = String(value).replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[REDACTED DATABASE URL]",
  );
  if (t.password)
    s = s
      .replaceAll(t.password, "[REDACTED]")
      .replaceAll(encodeURIComponent(t.password), "[REDACTED]");
  return s;
}
function psql(t, sql, run = spawnSync) {
  const args = ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"];
  if (t.container) {
    const context = run(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      {
        encoding: "utf8",
        timeout: 8000,
        killSignal: "SIGKILL",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    if (
      context.error ||
      context.status !== 0 ||
      !context.stdout.trim().startsWith("unix:///")
    )
      throw Error(
        "Acceptance container requires the local Unix-socket Docker context",
      );
    const inspect = run(
      "docker",
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.supabase.cli.project"}}|{{.State.Running}}|{{json .NetworkSettings.Ports}}',
        t.container,
      ],
      {
        encoding: "utf8",
        timeout: 8000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    if (inspect.error || inspect.status !== 0)
      throw Error("Isolated database container identity could not be verified");
    const [project, running, ports] = inspect.stdout.trim().split("|");
    let mappings;
    try {
      mappings = JSON.parse(ports);
    } catch {
      throw Error("Isolated database port identity is invalid");
    }
    if (
      project !== t.projectId ||
      running !== "true" ||
      !mappings?.["5432/tcp"]?.some((p) => p.HostPort === t.port)
    )
      throw Error(
        "Container project/state/port differs from the explicit isolated target",
      );
  }
  const result = run(
    t.container ? "docker" : "psql",
    t.container
      ? [
          "exec",
          "-i",
          t.container,
          "psql",
          ...args,
          "-U",
          t.user,
          "-d",
          t.database,
        ]
      : args,
    {
      input: sql,
      encoding: "utf8",
      timeout: 60000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PGHOST: t.host,
        PGPORT: t.port,
        PGDATABASE: t.database,
        PGUSER: t.user,
        PGPASSWORD: t.password,
        PGCONNECT_TIMEOUT: "5",
        PGSSLMODE: "disable",
        PGAPPNAME: "arc-books-isolated-acceptance",
      },
    },
  );
  if (result.error || result.status !== 0)
    throw Error(
      redact(
        result.error?.code === "ENOENT"
          ? "psql runtime is unavailable"
          : result.stderr || result.error?.message || "Acceptance SQL failed",
        t,
      ),
    );
  return result.stdout.trim();
}
function verifyIdentity(identity, t, m) {
  const marker = identity.marker;
  if (
    identity.database !== t.database ||
    identity.inRecovery !== false ||
    !marker ||
    marker.instance_id !== t.instance ||
    !/^arc-books-acceptance-[a-z0-9-]+$/.test(marker.project_id ?? "") ||
    marker.isolated !== true ||
    marker.migration_manifest_sha256 !== m.migrationManifestSha256 ||
    (t.projectId && marker.project_id !== t.projectId)
  )
    throw Error(
      "Database does not prove the explicit isolated current-schema acceptance identity",
    );
  if (
    identity.cronEnabled !== null &&
    !["off", "false"].includes(identity.cronEnabled)
  )
    throw Error(
      "Disable cron.launch_active_jobs in the isolated target before acceptance",
    );
  const versions = identity.migrationVersions;
  if (
    !Array.isArray(versions) ||
    versions.length !== m.versions.length ||
    [...versions].sort().some((v, i) => v !== [...m.versions].sort()[i])
  )
    throw Error(
      "Installed migration train differs from the current source inventory",
    );
}
function verifyTap(output) {
  const lines = output.split(/\r?\n/),
    plans = lines.filter((l) => /^1\.\.\d+/.test(l)),
    results = lines.filter((l) => /^(?:not )?ok \d+/.test(l));
  if (
    plans.length !== 1 ||
    /^1\.\.0(?:\s|$)/.test(plans[0]) ||
    results.length !== Number(plans[0].match(/^1\.\.(\d+)/)[1]) ||
    lines.some((l) =>
      /^not ok\b|^# (?:Looks like|Failed)|#\s*(?:SKIP|TODO)\b/i.test(l),
    )
  )
    throw Error(
      "pgTAP failed, skipped, or did not execute its complete declared plan",
    );
  if (
    results.some(
      (line, index) =>
        Number(line.match(/^(?:not )?ok (\d+)/)[1]) !== index + 1,
    )
  )
    throw Error("pgTAP result identities are missing or duplicated");
  return results.length;
}
async function execute(
  config,
  {
    root = path.resolve(__dirname, "../.."),
    env = process.env,
    query = psql,
  } = {},
) {
  // Unsupported scenarios must fail before any database writes or misleading pass.
  if (config.scenario !== "SCHEMA-01")
    throw Error(
      `Golden scenario ${config.scenario} is registered but not implemented; full release acceptance cannot pass`,
    );
  const t = target(
      env[config.urlEnv],
      env.BOOKS_ACCEPTANCE_INSTANCE_ID,
      env.BOOKS_ACCEPTANCE_CONTAINER,
    ),
    m = manifest(root);
  if (fs.existsSync(config.evidenceDir))
    throw Error(
      "Choose a new evidence directory; prior evidence is never overwritten",
    );
  fs.mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    runId: randomUUID(),
    scenario: config.scenario,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    scope:
      "Current isolated migration identity and complete pgTAP; not golden application/browser/upgrade/recovery acceptance",
    runtime: { node: process.version },
    inventory: m,
    results: [],
    existingArcDatabaseModified: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(config.evidenceDir, "evidence.json"),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    );
  save();
  try {
    const identity = JSON.parse(
      await query(
        t,
        `select json_build_object('database',current_database(),'serverVersion',version(),'inRecovery',pg_is_in_recovery(),'cronEnabled',current_setting('cron.launch_active_jobs',true),'marker',(select json_build_object('instance_id',x.instance_id,'project_id',x.project_id,'isolated',x.isolated,'migration_manifest_sha256',x.migration_manifest_sha256) from books_acceptance.environment x),'migrationVersions',(select json_agg(version order by version) from supabase_migrations.schema_migrations));`,
      ),
    );
    verifyIdentity(identity, t, m);
    record.databaseIdentity = identity;
    save();
    await query(
      t,
      "create extension if not exists pgtap with schema extensions;",
    );
    record.testSetup = "Enabled pgTAP only after verifying the isolated target";
    for (const file of m.tests) {
      const input = fs.readFileSync(path.join(root, file.path), "utf8");
      if (sha(input) !== file.sha256)
        throw Error("Acceptance SQL source changed after inventory");
      const output = await query(
          t,
          "set search_path=public,extensions;\n" + input,
        ),
        assertions = verifyTap(output),
        name = path.basename(file.path) + ".tap";
      fs.writeFileSync(
        path.join(config.evidenceDir, name),
        redact(output, t) + "\n",
        { mode: 0o600 },
      );
      record.results.push({
        test: file.path,
        assertions,
        log: name,
        sha256: sha(redact(output, t) + "\n"),
      });
      save();
    }
    if (JSON.stringify(manifest(root)) !== JSON.stringify(m))
      throw Error("Acceptance source inventory changed during execution");
    record.status = "PASSED";
    record.assertions = record.results.reduce((n, r) => n + r.assertions, 0);
  } catch (e) {
    record.status = "FAILED";
    record.error = redact(e.message, t);
    throw Error(record.error);
  } finally {
    record.finishedAt = new Date().toISOString();
    save();
  }
  return record;
}
module.exports = {
  GOLDEN_SCENARIOS,
  parseArgs,
  target,
  manifest,
  redact,
  psql,
  verifyIdentity,
  verifyTap,
  execute,
};
