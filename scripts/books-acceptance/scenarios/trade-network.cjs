// Shared fixtures for the Arc Trade network scenarios (TRADE-QUOTE-01, TRADE-NET-01): a builder
// organization on Arc that invites the seeded trade company, and the trade owner's side of the
// invitation (claim, verify, act as the signed-in member).
//
// What a stack without a browser cannot do is set up here and says so where it happens:
//  - The claim page sets an external-session cookie and the Supabase session comes from a cookie
//    jar; a request scope is faked for `next/headers` (an in-memory jar) and the trade owner's
//    verified Supabase identity is answered for `createServerSupabaseClient().auth.getUser()` while
//    a trade call runs. Everything else is the services themselves.
//  - The verification email never leaves the stack; the token the claim issued is confirmed
//    through the same function the /auth/verify page calls.
const Module = require("node:module")
const { randomBytes, randomUUID } = require("node:crypto")
const { createClient } = require("@supabase/supabase-js")
const { app, greenfieldOrg } = require("./shared.cjs")
const { PASSWORD } = require("../trade-seed.cjs")

const A = (path) => require(`../../../${path}`)

/** A cookie jar behind `cookies()`, installed once per process. */
function installRequestScope() {
  if (process.env.__TRADE_NETWORK_SCOPE) return
  process.env.__TRADE_NETWORK_SCOPE = "1"
  // Bid links are signed with their own secret; a run mints one like the kit does for the others.
  process.env.BID_PORTAL_SECRET ??= randomBytes(32).toString("hex")
  const jar = new Map()
  const store = {
    get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name) => jar.has(name),
    set: (nameOrOptions, value) => {
      if (typeof nameOrOptions === "string") jar.set(nameOrOptions, value)
      else jar.set(nameOrOptions.name, nameOrOptions.value)
    },
    delete: (name) => jar.delete(typeof name === "string" ? name : name.name),
  }
  const original = Module._load
  Module._load = function (request, ...args) {
    const real = original.call(this, request, ...args)
    if (request !== "next/headers") return real
    return { ...real, cookies: async () => store, headers: async () => new Headers({ "x-forwarded-for": "127.0.0.1", "user-agent": "acceptance-trade-owner" }) }
  }
}

/** Acts as a trade member whose Supabase email is confirmed: real RLS through kit.as, the verified identity answered for the session lookup. */
async function asTrade(kit, actor, work) {
  installRequestScope()
  const server = A("lib/supabase/server")
  const real = server.createServerSupabaseClient
  server.createServerSupabaseClient = async () => {
    const client = createClient(kit.apiUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${kit.localJwt({ sub: actor.userId, role: "authenticated", aud: "authenticated" })}` } },
    })
    client.auth.getUser = async () => ({ data: { user: { id: actor.userId, email: actor.email, email_confirmed_at: new Date().toISOString() } }, error: null })
    return client
  }
  try {
    return await kit.as(actor, work)
  } finally {
    server.createServerSupabaseClient = real
  }
}

/**
 * The trade owner opens an invitation link, claims it with the invited email and confirms that email:
 * what the /auth gate and the emailed /auth/verify link do. Returns the external identity's id.
 */
async function claimInvitation(kit, owner, { tokenType, token }) {
  installRequestScope()
  const auth = A("lib/services/external-portal-auth")
  const claimed = await kit.service(() => auth.authenticateExternalPortalAccountWithToken({ token, tokenType, email: owner.email, fullName: "Olivia Owner", password: PASSWORD }))
  // A second invitation to someone already verified has nothing to confirm.
  if (claimed.created) {
    const verification = await kit.service(() => auth.issueExternalIdentityVerification(claimed.identityId))
    const confirmed = verification ? await kit.service(() => auth.confirmExternalIdentityVerification(verification)) : false
    if (!confirmed) throw Error("The claimed identity's email was not confirmed")
  }
  return claimed
}

const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const monthOf = (date) => date.toISOString().slice(0, 7)

/**
 * A builder organization (a residential, custom-home builder on Arc) with one job and the trade
 * company in its directory: the company, the person there who is the trade's owner, and, when asked,
 * an approved subcontract for the job. `books` makes it a Books-official builder so bills can be
 * approved and paid through the ledger.
 */
async function builderOrg(kit, { name, trade, books = false, subcontractCents = null }) {
  const { q } = kit
  const first = { projectId: randomUUID(), costCodeId: randomUUID(), commitmentId: randomUUID() }
  const seedJob = (org) => {
    Object.assign(org, first)
    kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,location,created_by) values(${q(org.projectId)},${q(org.orgId)},'Marina Way residence','residential',${q(JSON.stringify({ address: "500 Marina Way, Stuart, FL 34994" }))}::jsonb,${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(org.projectId)}) on conflict do nothing;
insert into public.cost_codes(id,org_id,code,name) values(${q(org.costCodeId)},${q(org.orgId)},'16-100','Electrical');
commit;`)
  }
  let org
  if (books) {
    const month = monthOf(new Date())
    org = await greenfieldOrg(kit, { name, periods: [month], setup: seedJob })
  } else {
    org = kit.organization({ name, chart: [] })
    seedJob(org)
  }
  const company = await kit.as(org.owner, () => app("companies").createCompany({ input: { name: trade.name, role_key: "subcontractor", trade: "Electrical", email: trade.owner.email } }))
  const contact = await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Olivia Owner", email: trade.owner.email, role: "Owner", role_key: "subcontractor", primary_company_id: company.id } }))
  const built = { ...org, companyId: company.id, contactId: contact.id }
  if (subcontractCents !== null) addSubcontract(kit, built, { projectId: built.projectId, commitmentId: built.commitmentId, cents: subcontractCents })
  return built
}

/** The approved subcontract the trade company bills against on one of the builder's jobs. */
function addSubcontract(kit, org, { projectId, commitmentId, cents }) {
  const { q } = kit
  kit.sql(`insert into public.commitments(id,org_id,project_id,company_id,title,status,total_cents,commitment_type,retainage_percent)
    values(${q(commitmentId)},${q(org.orgId)},${q(projectId)},${q(org.companyId)},'Electrical subcontract','approved',${cents},'subcontract',0);`)
}

/** A second job of the builder, with its own subcontract for the trade company. */
function addBuilderJob(kit, org, { name, address, subcontractCents }) {
  const { q } = kit
  const job = { projectId: randomUUID(), commitmentId: randomUUID(), address }
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,location,created_by) values(${q(job.projectId)},${q(org.orgId)},${q(name)},'residential',${q(JSON.stringify({ address }))}::jsonb,${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(job.projectId)}) on conflict do nothing;
commit;`)
  addSubcontract(kit, org, { projectId: job.projectId, commitmentId: job.commitmentId, cents: subcontractCents })
  return job
}

module.exports = { installRequestScope, asTrade, claimInvitation, builderOrg, addBuilderJob, glId, monthOf }
