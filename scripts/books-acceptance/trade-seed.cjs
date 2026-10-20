// An Arc Trade company on the isolated acceptance stack (TR07-01): an electrical
// contractor provisioned the way Platform provisions one (the `trade` plan and the
// `trade` business profile), four people in the roles a trade company staffs, two
// customers and three jobs made through the trade job-creation service. Memoised per
// kit; every TRADE-* scenario builds on it.
//
// What the stack cannot do is set up directly and says so where it happens:
//  - Platform provisioning needs a signed-in platform operator (a cookie session);
//    the platform-access check is answered for one operator the seed creates, and
//    everything after it (org, profile, owner invite, subscription, plan
//    entitlements, cost codes) is provisionOrganization itself.
//  - A person accepts an invite from an emailed link; the seed activates the
//    invited memberships and sets a password through the auth admin API, which is
//    all acceptInviteByToken does to the rows.
//  - Project assignment is a page action, so it is a fixture row, written the way
//    FIELD-01 and LOT-01 write theirs.
const { randomUUID } = require("node:crypto")
const { app } = require("./scenarios/shared.cjs")

const PASSWORD = "Acceptance-Trade-2026!"

const ROLES = {
  officeAdmin: { role: "org_office_admin", name: "Dana Office", costCents: 3800, billCents: 0 },
  foreman: { role: "org_foreman", name: "Frank Foreman", costCents: 5200, billCents: 9500 },
  crew: { role: "org_crew_member", name: "Casey Crew", costCents: 3400, billCents: 7500 },
  crewTwo: { role: "org_crew_member", name: "Chris Crew", costCents: 3200, billCents: 7500 },
}

const WORLDS = new WeakMap()

/** The trade company, built once per kit. */
function tradeCompany(kit, options = {}) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit, options))
  return WORLDS.get(kit)
}

async function build(kit, { name = "Voltline Electric (acceptance)" } = {}) {
  const { q } = kit
  const stamp = randomUUID().slice(0, 8)
  const slug = `voltline-${stamp}`

  // Platform provisioning, as the platform operator.
  const operatorId = randomUUID()
  kit.sql(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
    values(${q(operatorId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(`operator-${stamp}@acceptance.example.test`)},'',now(),now(),now(),'{"provider":"email","providers":["email"]}','{}','','','','','','','','');
    insert into public.app_users(id,email,full_name) values(${q(operatorId)},${q(`operator-${stamp}@acceptance.example.test`)},'Platform operator') on conflict (id) do nothing;`)
  const platformAccess = require("../../lib/services/platform-access")
  const realAuthority = platformAccess.requireAnyPlatformPermission
  platformAccess.requireAnyPlatformPermission = async () => ({ id: operatorId })
  // The operator is not a member of the company they are creating, and the cost-code
  // seed reads the org context by id; production answers it through platform support
  // access. Here it is the service client acting for the operator, for this call only.
  const contextModule = require("../../lib/services/context")
  const realOrgContext = contextModule.requireOrgContext
  contextModule.requireOrgContext = async (id) => ({ supabase: require("../../lib/supabase/server").createServiceSupabaseClient(), orgId: id, userId: operatorId, productTier: "residential" })
  const ownerEmail = `owner-${stamp}@acceptance.example.test`
  let org
  try {
    const { defaultPlanCode } = require("../../lib/workspace-surface")
    const businessProfile = { kind: "trade", specialty: "Electrical" }
    org = await kit.service(() => app("provisioning").provisionOrganization({
      name, slug, billingModel: "subscription", planCode: defaultPlanCode(businessProfile),
      primaryEmail: ownerEmail, primaryName: "Olivia Owner", trialDays: 14, createdBy: operatorId,
      sendInviteEmail: false, productTier: "residential", businessProfile,
    }))
  } finally {
    platformAccess.requireAnyPlatformPermission = realAuthority
    contextModule.requireOrgContext = realOrgContext
  }
  const orgId = org.id

  // Invite acceptance: the owner's membership goes active, with a password so the
  // person can sign in for the mobile contract.
  const supabaseAdmin = require("../../lib/supabase/server").createServiceSupabaseClient()
  const activate = async (userId) => {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: PASSWORD })
    if (error) throw Error(`Setting the seeded password failed: ${error.message}`)
    kit.sql(`update public.memberships set status='active', invite_token_hash=null, invite_token_expires_at=null where org_id=${q(orgId)} and user_id=${q(userId)};`)
  }
  const [ownerRow] = kit.rows(`select u.id from public.app_users u where lower(u.email)=${q(ownerEmail)}`)
  await activate(ownerRow.id)
  const actor = (userId, role, email) => ({ userId, orgId, productTier: "residential", role, email })
  const owner = actor(ownerRow.id, "org_owner", ownerEmail)

  // The rest of the team joins through the team service as the owner, so the role
  // picker's rules (a trade company is offered Foreman and Crew member) apply.
  const team = {}
  for (const [key, spec] of Object.entries(ROLES)) {
    const email = `${key.toLowerCase()}-${stamp}@acceptance.example.test`
    await kit.as(owner, () => app("team").inviteTeamMember({ input: {
      email, role: spec.role, projectScope: spec.role === "org_foreman" || spec.role === "org_crew_member" ? "assigned" : "all",
      divisionScope: "all", divisionIds: [], permissionOverrides: [],
    } }))
    const [row] = kit.rows(`select id from public.app_users where lower(email)=${q(email)}`)
    kit.sql(`update public.app_users set full_name=${q(spec.name)} where id=${q(row.id)}`)
    await activate(row.id)
    team[key] = { ...actor(row.id, spec.role, email), name: spec.name }
    team[key].membershipId = kit.rows(`select id from public.memberships where org_id=${q(orgId)} and user_id=${q(row.id)}`)[0].id
  }
  owner.membershipId = kit.rows(`select id from public.memberships where org_id=${q(orgId)} and user_id=${q(owner.userId)}`)[0].id

  // Labor rates: the owner sets each worker's effective-dated rate.
  const rateDate = "2026-01-01"
  for (const [key, spec] of Object.entries(ROLES)) {
    await kit.as(owner, () => app("labor-rates").saveLaborRate(team[key].membershipId, {
      effective_on: rateDate, labor_cost_rate_cents: spec.costCents, labor_bill_rate_cents: spec.billCents,
      labor_burden_multiplier: 1.25, labor_is_billable_default: spec.billCents > 0,
    }))
    team[key].costRateCents = spec.costCents
    team[key].billRateCents = spec.billCents
  }

  // Two customers: a GC (a directory company with the client role, and the person
  // there the job is billed through) and a homeowner (a contact).
  const gcCompany = await kit.as(owner, () => app("companies").createCompany({ input: { name: "Harbor General Contractors", role_key: "client", email: "ap@harbor-gc.example.test", phone: "555-0100" } }))
  const gcContact = await kit.as(owner, () => app("contacts").createContact({ input: { full_name: "Gina Harbor", email: "gina@harbor-gc.example.test", role: "Project manager", role_key: "client", primary_company_id: gcCompany.id } }))
  const homeowner = await kit.as(owner, () => app("contacts").createContact({ input: { full_name: "Henry Homeowner", email: "henry@example.test", phone: "555-0101", role_key: "homeowner", address: "14 Palm Court, Stuart, FL 34994" } }))

  // Three jobs through the trade job-creation service.
  const createJob = (input) => kit.as(owner, () => app("trade-workspace").createTradeJob(input)).then((job) => job.id)
  const jobs = {
    gc: await createJob({
      name: "Harbor Tower - tenant electrical", client_id: gcContact.id, address: "200 Harbor Blvd, Stuart, FL",
      property_type: "residential", customer_kind: "company", billing_basis: "progress", retainage_percent: 10,
      payment_terms_days: 30, customer_certifies: true, total_contract_value_cents: 18_000_000,
      start_date: "2026-10-01", end_date: "2027-01-31",
    }),
    homeowner: await createJob({
      name: "Palm Court - service calls", client_id: homeowner.id, address: "14 Palm Court, Stuart, FL",
      property_type: "residential", customer_kind: "homeowner", billing_basis: "time_and_materials", retainage_percent: 0,
      payment_terms_days: 15, start_date: "2026-10-05",
    }),
    commercial: await createJob({
      name: "Sunrise Plaza - lighting retrofit", client_id: gcContact.id, address: "9 Sunrise Plaza, Port St. Lucie, FL",
      property_type: "commercial", customer_kind: "company", billing_basis: "invoices", retainage_percent: 5,
      payment_terms_days: 30, total_contract_value_cents: 7_500_000, start_date: "2026-11-02", end_date: "2026-12-18",
    }),
  }

  // Assignment: the foreman runs the GC and homeowner jobs; crew work the homeowner job.
  const assign = (user, projectId, roleKey) => kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status)
    select ${q(orgId)},${q(projectId)},${q(user.userId)},id,'active' from public.roles where key=${q(roleKey)} and scope='project'
    on conflict (project_id,user_id) do nothing;`)
  for (const projectId of [jobs.gc, jobs.homeowner]) assign(team.foreman, projectId, "foreman")
  for (const user of [team.crew, team.crewTwo]) assign(user, jobs.homeowner, "crew")

  const actors = { owner, ...team }
  return {
    orgId, slug, name, operatorId, org,
    actors,
    customers: { gcCompanyId: gcCompany.id, gcContactId: gcContact.id, homeownerContactId: homeowner.id },
    jobs,
    assignments: { foreman: [jobs.gc, jobs.homeowner], crew: [jobs.homeowner], crewTwo: [jobs.homeowner] },
    password: PASSWORD,
  }
}

/** A real GoTrue access token for a seeded person: what the iOS app sends. */
async function signIn(kit, actor, password = PASSWORD) {
  const { createClient } = require("@supabase/supabase-js")
  const client = createClient(kit.apiUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({ email: actor.email, password })
  if (error || !data.session) throw Error(`Sign-in failed for ${actor.role}: ${error?.message}`)
  return data.session.access_token
}

/**
 * One request to a mobile route handler, as the iOS app sends it: a bearer token from a real
 * sign-in and the selected organization. `route` is the path under app/api/mobile/v1 whose
 * handler runs (for example "time/clock/in"); `method` picks its exported handler.
 */
async function mobileCall(kit, actor, route, { method = "GET", query = "", body, token = null, password = PASSWORD, orgHeader = actor.orgId } = {}) {
  const handler = require(`../../app/api/mobile/v1/${route}/route`)[method]
  const bearer = token ?? await signIn(kit, actor, password)
  const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(orgHeader ? { "x-arc-organization-id": orgHeader } : {}) }
  const response = await handler(new Request(`http://127.0.0.1/api/mobile/v1/${route}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  await kit.settle()
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: response.status, body: json }
}

module.exports = { tradeCompany, signIn, mobileCall, PASSWORD }
