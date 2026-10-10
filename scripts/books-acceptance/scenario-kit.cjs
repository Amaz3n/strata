// Golden scenario kit (B00.3). Runs Arc's real services against an isolated
// acceptance stack whose API was started by `api.cjs`. Credentials are the
// local stack's published development defaults, minted here; Arc's .env files
// are never read. Actors act through runWithServiceOrgContext with their own
// `authenticated` token, so row-level security and permission checks are real.
const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module"),
  { createHmac, randomBytes, randomUUID } = require("node:crypto"),
  { spawnSync } = require("node:child_process")

// Published default of every local Supabase stack; never a deployed secret.
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
function localJwt(claims) {
  const head = b64({ alg: "HS256", typ: "JWT" }),
    body = b64({ iss: "supabase-demo", exp: 1983812996, ...claims })
  return `${head}.${body}.${createHmac("sha256", LOCAL_JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`
}

const q = (value) => (value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`)

function createKit(stack) {
  if (!/^supabase_db_arc-books-acceptance-[a-z0-9]+$/.test(stack.container) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(stack.apiUrl))
    throw Error("Scenarios require an isolated acceptance container and a loopback API")
  process.env.NEXT_PUBLIC_SUPABASE_URL = stack.apiUrl
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = localJwt({ role: "anon" })
  process.env.SUPABASE_SERVICE_ROLE_KEY = localJwt({ role: "service_role" })
  process.env.CRON_SECRET = randomUUID()
  // Signing links and portal tokens need server secrets; a run mints its own.
  for (const name of ["DOCUMENT_SIGNING_SECRET", "PORTAL_ACCESS_SECRET", "PROPOSAL_SECRET"]) process.env[name] = randomBytes(32).toString("hex")
  // A shell that carries production storage settings must never send scenario
  // files there. Storage comes only from the file `--storage-env` names, and only
  // for a bucket named as an acceptance bucket; otherwise there is none.
  for (const name of Object.keys(process.env)) if (name.startsWith("R2_")) delete process.env[name]
  let storage = null
  if (stack.storageEnv) {
    const settings = Object.fromEntries(fs.readFileSync(stack.storageEnv, "utf8").split("\n").filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]))
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) if (!settings[name]) throw Error(`${stack.storageEnv} is missing ${name}`)
    if (!/-acceptance$/.test(settings.R2_BUCKET)) throw Error("Scenarios only write to a bucket named *-acceptance")
    for (const [name, value] of Object.entries(settings)) if (name.startsWith("R2_")) process.env[name] = value
    process.env.FILES_STORAGE = "r2"
    storage = { bucket: settings.R2_BUCKET }
  }
  // Plaid likewise: only Plaid's sandbox, only from the file `--plaid-env` names,
  // with a throwaway token-encryption key so no production key is ever involved.
  for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "TOKEN_ENCRYPTION_KEY"]) delete process.env[name]
  let plaid = null
  if (stack.plaidEnv) {
    const settings = Object.fromEntries(fs.readFileSync(stack.plaidEnv, "utf8").split("\n").filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]))
    if (settings.PLAID_ENV !== "sandbox") throw Error("Scenarios only use Plaid's sandbox")
    for (const name of ["PLAID_CLIENT_ID", "PLAID_SECRET"]) if (!settings[name]) throw Error(`${stack.plaidEnv} is missing ${name}`)
    Object.assign(process.env, { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: settings.PLAID_CLIENT_ID, PLAID_SECRET: settings.PLAID_SECRET,
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"), NEXT_PUBLIC_APP_URL: "https://acceptance.example.test" })
    plaid = { env: "sandbox" }
  }
  // TaxBandits likewise: only its sandbox, which never reaches the IRS.
  for (const name of ["TAXBANDITS_ENV", "TAXBANDITS_CLIENT_ID", "TAXBANDITS_CLIENT_SECRET", "TAXBANDITS_USER_TOKEN"]) delete process.env[name]
  let taxbandits = null
  if (stack.taxbanditsEnv) {
    const settings = Object.fromEntries(fs.readFileSync(stack.taxbanditsEnv, "utf8").split("\n").filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]))
    if (settings.TAXBANDITS_ENV !== "sandbox") throw Error("Scenarios only use the TaxBandits sandbox")
    for (const name of ["TAXBANDITS_CLIENT_ID", "TAXBANDITS_CLIENT_SECRET", "TAXBANDITS_USER_TOKEN"]) if (!settings[name]) throw Error(`${stack.taxbanditsEnv} is missing ${name}`)
    for (const name of ["TAXBANDITS_ENV", "TAXBANDITS_CLIENT_ID", "TAXBANDITS_CLIENT_SECRET", "TAXBANDITS_USER_TOKEN"]) process.env[name] = settings[name]
    taxbandits = { env: "sandbox" }
  }
  require("../register-ts-node-test")
  // Route handlers give `after()` a request scope; scenarios await the work instead.
  const deferred = []
  const original = Module._load
  Module._load = function (request, ...args) {
    const real = original.call(this, request, ...args)
    // Cache-lifetime hints only tune Next's cache; outside a Next server they are no-ops.
    if (request === "next/cache") return { ...real, cacheLife: () => {}, cacheTag: () => {} }
    if (request !== "next/server") return real
    // `connection()` only marks a render dynamic; there is no render here.
    return { ...real, connection: async () => {}, after: (task) => deferred.push(Promise.resolve().then(typeof task === "function" ? task : () => task)) }
  }
  const { createClient } = require("@supabase/supabase-js")
  const { runWithServiceOrgContext } = require("../../lib/services/context")

  // `user` is postgres; supabase_admin (the stack superuser) only for harness
  // objects that must open an independent session, such as RACE-01's injector.
  function sql(text, user = "postgres") {
    const r = spawnSync("docker", ["exec", "-i", stack.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], {
      input: text, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    })
    if (r.error || r.status !== 0) throw Error(`SQL failed: ${(r.stderr || r.error?.message || "").trim()}`)
    return r.stdout.trim()
  }
  const rows = (text) => JSON.parse(sql(`select coalesce(json_agg(t),'[]') from (${text}) t;`) || "[]")

  async function as(actor, work) {
    const supabase = createClient(stack.apiUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${localJwt({ sub: actor.userId, role: "authenticated", aud: "authenticated" })}` } },
    })
    const result = await runWithServiceOrgContext({ supabase, orgId: actor.orgId, userId: actor.userId, productTier: actor.productTier }, work)
    await settle()
    return result
  }
  async function settle() {
    while (deferred.length) await Promise.all(deferred.splice(0))
  }
  async function service(work) {
    const result = await work()
    await settle()
    return result
  }

  // Background work runs through processOutboxQueue, the handler production's
  // cron reaches (GET is a debug surface outside production; POST is the queue).
  // An isolated stack has no email provider, so notification delivery is the
  // one job family allowed to fail; it is reported, not hidden.
  const NO_PROVIDER_JOBS = ["deliver_notification"]
  async function drainOutbox(orgId, attempts = 60) {
    const { NextRequest } = require("next/server")
    const { POST } = require("../../app/api/jobs/process-outbox/route")
    // The queue claims oldest-created first, so notifications this stack can never
    // deliver would retry at the head of the queue and starve every org's own jobs.
    // Once a delivery has failed here, it is retired rather than retried; a burst of
    // fresh ones (CAP-01 notifies every company) still takes a pass each per 50.
    sql(`update public.outbox set status = 'failed', last_error = coalesce(last_error, '') || ' (no email provider on the acceptance stack)'
      where status = 'pending' and retry_count > 0 and job_type in (${NO_PROVIDER_JOBS.map(q).join(",")})`)
    const relevant = `org_id=${q(orgId)} and run_at <= now() and job_type not in (${NO_PROVIDER_JOBS.map(q).join(",")})`
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!rows(`select id from public.outbox where ${relevant} and status in ('pending','processing')`).length) break
      const response = await POST(new NextRequest("http://127.0.0.1/api/jobs/process-outbox", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
      await settle()
      if (response.status >= 400) throw Error(`process-outbox returned ${response.status}: ${await response.text()}`)
    }
    const failed = rows(`select job_type, status, retry_count, run_at <= now() due, round(extract(epoch from now() - updated_at)) idle_s, last_error from public.outbox where ${relevant} and status in ('pending','processing','failed')`)
    // The queue is shared by every org on the stack; say what was ahead.
    const ahead = () => rows(`select job_type, status, priority, count(*)::int n from public.outbox where status in ('pending','processing') and run_at <= now() group by 1,2,3 order by 3 desc, 4 desc limit 8`)
    if (failed.length) throw Error(`Outbox did not drain: ${JSON.stringify(failed).slice(0, 500)}; queue: ${JSON.stringify(ahead())}`)
  }

  // A fresh organisation per scenario run: reruns never collide or duplicate money.
  // `password` makes the actors real sign-in users for browser acceptance.
  function organization({ name, productTier = "residential", chart, reviewerRole = "org_books_reviewer", password = null }) {
    const orgId = randomUUID(),
      owner = { userId: randomUUID(), orgId, productTier, role: "org_owner" },
      reviewer = { userId: randomUUID(), orgId, productTier, role: reviewerRole }
    const statements = ["begin;"]
    for (const actor of [owner, reviewer]) {
      const email = `${actor.userId}@acceptance.example.test`
      actor.email = email
      const secret = password ? `extensions.crypt(${q(password)}, extensions.gen_salt('bf'))` : "''"
      statements.push(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token) values(${q(actor.userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(email)},${secret},${password ? "now()" : "null"},now(),now(),'{"provider":"email","providers":["email"]}','{}','','','','','','','','');`)
      if (password) statements.push(`insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at) values(gen_random_uuid(),${q(actor.userId)},${q(actor.userId)},jsonb_build_object('sub',${q(actor.userId)},'email',${q(email)},'email_verified',true),'email',now(),now(),now());`)
      statements.push(`insert into public.app_users(id,email,full_name) values(${q(actor.userId)},${q(email)},${q(actor.role)}) on conflict (id) do nothing;`)
    }
    statements.push(`insert into public.orgs(id,name,slug,created_by,product_tier) values(${q(orgId)},${q(name)},${q(orgId)},${q(owner.userId)},${q(productTier)});`)
    for (const actor of [owner, reviewer])
      statements.push(`insert into public.memberships(org_id,user_id,role_id,status) select ${q(orgId)},${q(actor.userId)},id,'active' from public.roles where key=${q(actor.role)};`)
    statements.push(`insert into public.books_settings(org_id,workspace_enabled,ledger_authority,arc_ledger_mode,external_sync_posture,functional_currency,reporting_basis,active_policy_version,created_by,updated_by) values(${q(orgId)},true,'external','shadow','normal','usd','accrual',1,${q(owner.userId)},${q(owner.userId)});`)
    for (const a of chart)
      statements.push(`insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active,created_by,updated_by) values(${q(orgId)},${q(a.code)},${q(a.name)},${q(a.accountType)},${q(a.subtype)},${q(a.normalBalance)},${q(a.cashFlowCategory ?? null)},${a.system},true,${q(owner.userId)},${q(owner.userId)});`)
    statements.push("commit;")
    sql(statements.join("\n"))
    return { orgId, owner, reviewer }
  }

  // One more signed-in member of an existing organisation under a role (a
  // purchasing manager, a superintendent, a sales consultant ...).
  function addMember(org, role, { password = null } = {}) {
    const actor = { userId: randomUUID(), orgId: org.orgId, productTier: org.owner.productTier, role }
    actor.email = `${actor.userId}@acceptance.example.test`
    const secret = password ? `extensions.crypt(${q(password)}, extensions.gen_salt('bf'))` : "''"
    const statements = ["begin;",
      `insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token) values(${q(actor.userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(actor.email)},${secret},${password ? "now()" : "null"},now(),now(),'{"provider":"email","providers":["email"]}','{}','','','','','','','','');`]
    if (password) statements.push(`insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at) values(gen_random_uuid(),${q(actor.userId)},${q(actor.userId)},jsonb_build_object('sub',${q(actor.userId)},'email',${q(actor.email)},'email_verified',true),'email',now(),now(),now());`)
    statements.push(`insert into public.app_users(id,email,full_name) values(${q(actor.userId)},${q(actor.email)},${q(role)}) on conflict (id) do nothing;`,
      `insert into public.memberships(org_id,user_id,role_id,status) select ${q(org.orgId)},${q(actor.userId)},id,'active' from public.roles where key=${q(role)};`, "commit;")
    sql(statements.join("\n"))
    return actor
  }

  // Posted journals for a source, as account-code → net debit cents.
  function postedNet(orgId, filter) {
    const result = {}
    for (const row of rows(`select a.code, sum(l.debit_cents - l.credit_cents)::bigint net from public.journal_lines l
      join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
      where l.org_id=${q(orgId)} and e.status in ('posted','reversed') ${filter ? `and (${filter})` : ""} group by a.code having sum(l.debit_cents - l.credit_cents)<>0 order by a.code`))
      result[row.code] = Number(row.net)
    return result
  }

  return { container: stack.container, apiUrl: stack.apiUrl, storage, plaid, taxbandits, sql, rows, q, as, service, settle, organization, addMember, postedNet, drainOutbox, localJwt }
}

// Expected-versus-observed recorder. A subcase passes only if every check passes.
function recorder() {
  const checks = []
  return {
    checks,
    equal(label, expected, observed) {
      const pass = JSON.stringify(expected) === JSON.stringify(observed)
      checks.push({ label, pass, expected, observed })
      return pass
    },
  }
}

function loadExpected(id) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "expected", `${id}.json`), "utf8"))
}

module.exports = { createKit, recorder, loadExpected, localJwt }
