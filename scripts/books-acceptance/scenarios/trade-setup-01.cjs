// TRADE-SETUP-01 — provision and role sweep (TR01, TR02-09, TR07-01). An electrical
// contractor is provisioned on the Arc Trade plan with the trade business profile (the
// seed in trade-seed.cjs, through provisionOrganization and Arc's own team, labor-rate,
// directory and trade-job services), and its four roles (owner, office admin, foreman,
// crew member) are swept against every route the workspace can refuse, through the same
// guards and surface functions the pages call.
//
//   provisioned-on-the-trade-plan              profile, subscription, plan entitlements and the
//                                              surface the workspace resolves from them
//   team-holds-the-trade-roles                 roles, scopes, the role picker and labor rates
//   fixtures-jobs-and-customers                two customers, three jobs, their billing terms
//   builder-routes-refuse-every-role           every builder desk, settings page and project tab
//                                              redirects to /?unavailable=<area> with its reason,
//                                              for each of the four roles
//   trade-routes-stay-open                     the trade nav, the templates page and the job tabs
//                                              a trade company works in are allowed
//   module-override-reopens-one-jobs-tab       a project module override reopens a builder-only
//                                              tab for one job; a plan feature cannot be reopened
//   builder-mutations-are-refused-centrally    services refuse builder operations for every role
//                                              with the plan-naming message; a builder org does not
//   menus-and-settings-hold-no-builder-modules effective permissions, nav and settings per role
//   crew-sees-only-assigned-jobs               job visibility follows project assignment
//   trade-vocabulary-is-clean                  no builder nouns in what a trade company reads
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")

const A = (path) => require(`../../../${path}`)
const ROLES = ["owner", "officeAdmin", "foreman", "crew"]

// ---------------------------------------------------------------------------
// Helpers

/** What a page's guard does: nothing (allowed), or Next's redirect, whose digest carries the URL. */
async function guarded(work) {
  try {
    await work()
    return "allowed"
  } catch (error) {
    const digest = String(error?.digest ?? "")
    const match = /^NEXT_REDIRECT;[a-z]+;([^;]+);\d+;?$/.exec(digest)
    if (match) return `redirect ${match[1]}`
    return `error: ${String(error?.message ?? error).slice(0, 200)}`
  }
}

/** A service call's outcome: allowed, or the refusal's message verbatim. */
async function refusal(work) {
  try {
    await work()
    return "allowed"
  } catch (error) {
    return `refused: ${String(error?.message ?? error).slice(0, 200)}`
  }
}

const effectivePermissions = (kit, actor) =>
  kit.as(actor, () => A("lib/services/authorization").getEffectiveOrgPermissions(actor.orgId, actor.userId))

/** The sidebar's own rule (filterGroups/canAccess): administrators see all, others need any one listed key. */
const canAccess = (requiredAny, permissions) =>
  !requiredAny?.length || permissions.includes("*") || permissions.includes("org.admin") || requiredAny.some((key) => permissions.includes(key))

const BUILDER_DOMAINS = ["community", "land", "land_contract", "lot", "plan", "start", "sales", "closing", "lead_intake", "agreement_template", "design_studio", "price_book", "po", "po_completion", "po_exception", "po_receipt", "vpo", "purchasing_settings", "division"]
const domainOf = (key) => key.split(".")[0]

async function surfaceOf(kit, w) {
  return A("lib/services/workspace-surface").loadWorkspaceSurface(w.orgId)
}

/** Every label the trade workspace shows one member: org nav, settings, one job's nav. */
async function menusFor(kit, w, role, surface) {
  const actor = w.actors[role]
  const permissions = await effectivePermissions(kit, actor)
  const { buildTradeNavGroups } = A("components/layout/trade-nav-items.ts")
  const { buildProjectNavGroups } = A("components/layout/project-nav-items.ts")
  const { visibleSettingsSections } = A("lib/settings/sections.ts")
  const { surfaceAllowsPath } = A("lib/workspace-surface")
  const projects = await kit.as(actor, () => A("lib/services/projects").listProjects())
  const org = buildTradeNavGroups("/").map((group) => ({
    label: group.label,
    items: group.items.filter((item) => canAccess(item.requiredAny, permissions) && surfaceAllowsPath(surface, item.url)).map((item) => item.title),
  })).filter((group) => group.items.length)
  const settings = visibleSettingsSections(permissions, surface).map((section) => ({ label: section.label, items: section.items.map((item) => item.title) }))
  const job = projects.find((project) => project.id === w.jobs.homeowner)
  // The sidebar's filterGroups: an item needs its permission, and a parent whose sub-items all drop away drops too.
  const visible = (items) => items.flatMap((item) => {
    if (!canAccess(item.requiredAny, permissions)) return []
    if (!item.items) return [item.title]
    const children = visible(item.items)
    return children.length ? children.map((child) => `${item.title}/${child}`) : []
  })
  const jobNav = buildProjectNavGroups({ projectId: job.id, section: "overview", project: job, orgTier: "residential", workspaceSurface: surface }).flatMap((group) => visible(group.items))
  return { actor, permissions, org, settings, jobNav, projects }
}

// ---------------------------------------------------------------------------
// 1. Provisioned on the trade plan

async function provisionedOnTheTradePlan(kit, spec, check) {
  const w = await tradeCompany(kit)
  const { q } = kit
  const surface = await surfaceOf(kit, w)
  const { allBillingFeatureKeys } = A("lib/billing-feature-catalog")
  const { businessBrand } = A("lib/business-profile")
  const [settings] = kit.rows(`select settings->'business_profile' profile from public.org_settings where org_id=${q(w.orgId)}`)
  const [org] = kit.rows(`select product_tier, billing_model, status from public.orgs where id=${q(w.orgId)}`)
  const [subscription] = kit.rows(`select plan_code, status from public.subscriptions where org_id=${q(w.orgId)}`)
  const entitlements = kit.rows(`select feature_key from public.entitlements where org_id=${q(w.orgId)} and source='plan' order by feature_key`).map((row) => row.feature_key)
  const planLimits = kit.rows(`select feature_key from public.plan_feature_limits where plan_code='trade' and limit_type='enabled' and limit_value>0 order by feature_key`).map((row) => row.feature_key)
  const owner = kit.rows(`select r.key, m.status from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${q(w.orgId)} and m.user_id=${q(w.actors.owner.userId)}`)[0]
  const observed = {
    profile: settings.profile,
    organization: org,
    subscription,
    entitlementRows: entitlements,
    entitlementRowsEqualThePlansLimits: JSON.stringify(entitlements) === JSON.stringify(planLimits),
    surface: { kind: surface.profile.kind, specialty: surface.profile.specialty, planName: surface.planName, features: [...surface.features].sort() },
    featuresTheTradePlanWithholds: allBillingFeatureKeys().filter((key) => !surface.features.includes(key)).sort(),
    brand: businessBrand(surface.profile, org.product_tier),
    owner,
  }
  check.equal("the company is on the trade plan with the electrical profile: subscription, entitlement rows (equal to the plan's feature limits), the surface resolved from them, the brand, and an active owner", spec.expected, observed)
  return { orgId: w.orgId, slug: w.slug }
}

// ---------------------------------------------------------------------------
// 2. The four roles

async function teamHoldsTheTradeRoles(kit, spec, check) {
  const w = await tradeCompany(kit)
  const { q } = kit
  const members = kit.rows(`select u.email, r.key role, m.status, m.project_scope, m.labor_cost_rate_cents cost, m.labor_bill_rate_cents bill
    from public.memberships m join public.roles r on r.id=m.role_id join public.app_users u on u.id=m.user_id where m.org_id=${q(w.orgId)}`)
  const byUser = Object.fromEntries(Object.entries(w.actors).map(([key, actor]) => [actor.email, key]))
  const roster = {}
  for (const row of members) roster[byUser[row.email] ?? row.email] = { role: row.role, status: row.status, projectScope: row.project_scope, costRateCents: Number(row.cost), billRateCents: Number(row.bill) }
  const picker = (await kit.as(w.actors.owner, () => app("team").listAssignableOrgRoles())).map((option) => option.key)
  const resolved = {}
  for (const key of ["foreman", "crew"]) {
    const rate = await kit.as(w.actors.owner, () => app("labor-rates").resolveLaborRate({ supabase: require("../../../lib/supabase/server").createServiceSupabaseClient(), orgId: w.orgId, userId: w.actors[key].userId, onDate: "2026-10-15" }))
    resolved[key] = { costRateCents: rate.costRateCents, burden: rate.burdenMultiplier, billRateCents: rate.billRateCents, effectiveOn: rate.effectiveOn }
  }
  const observed = { roster, rolePickerOffers: picker, ratesInForceOn20261015: resolved }
  check.equal("the owner, office admin, foreman and two crew members hold their roles and project scopes, the role picker offers Foreman and Crew member and no builder-only role, and each worker's rate is the one the owner set", spec.expected, observed)
  return { orgId: w.orgId }
}

// ---------------------------------------------------------------------------
// 3. Fixtures

async function fixturesJobsAndCustomers(kit, spec, check) {
  const w = await tradeCompany(kit)
  const { q } = kit
  const name = (id) => Object.entries(w.jobs).find(([, job]) => job === id)?.[0]
  const jobs = {}
  for (const row of kit.rows(`select p.id, p.property_type, p.retainage_percent, p.status, p.phase, p.client_id, pfs.billing_model, pfs.fixed_price_billing_basis basis, pfs.metadata->'receivables' receivables,
      c.contract_type, c.total_cents from public.projects p left join public.project_financial_settings pfs on pfs.project_id=p.id and pfs.org_id=p.org_id
      left join public.contracts c on c.project_id=p.id and c.org_id=p.org_id where p.org_id=${q(w.orgId)}`)) {
    jobs[name(row.id)] = {
      posture: row.property_type, billingModel: row.billing_model, billingBasis: row.basis, contractType: row.contract_type, retainagePercent: Number(row.retainage_percent),
      contractCents: row.total_cents === null ? null : Number(row.total_cents), status: row.status, phase: row.phase, receivables: row.receivables,
      customer: row.client_id === w.customers.gcContactId ? "gc" : row.client_id === w.customers.homeownerContactId ? "homeowner" : "other",
    }
  }
  const roles = kit.rows(`select case when pr.company_id is not null then 'company' else 'contact' end kind, t.key role, pr.status from public.party_roles pr join public.directory_relationship_types t on t.id=pr.relationship_type_id
    where pr.org_id=${q(w.orgId)} and (pr.company_id=${q(w.customers.gcCompanyId)} or pr.contact_id in (${q(w.customers.homeownerContactId)}, ${q(w.customers.gcContactId)})) order by 1, 2`)
  const link = kit.rows(`select is_primary from public.contact_company_links where org_id=${q(w.orgId)} and contact_id=${q(w.customers.gcContactId)} and company_id=${q(w.customers.gcCompanyId)}`)
  // Rows come back in no set order; the jobs are listed in the order the seed creates them.
  const seededJobs = Object.fromEntries(Object.keys(w.jobs).map((key) => [key, jobs[key]]))
  const observed = { jobs: seededJobs, customerRoles: roles, gcContactIsPrimaryAtTheGcCompany: link[0]?.is_primary === true }
  check.equal("the GC job is a residential fixed-price job billed by progress with 10% retainage, the homeowner job is time and materials, the commercial job is commercial posture; the GC is a client company and the homeowner a homeowner contact", spec.expected, observed)
  return { orgId: w.orgId, jobs: w.jobs }
}

// ---------------------------------------------------------------------------
// 4. Every role x every builder-only route

async function builderRoutesRefuseEveryRole(kit, spec, check) {
  const w = await tradeCompany(kit)
  const surfaceModule = A("lib/services/workspace-surface")
  const { WORKSPACE_DESKS, WORKSPACE_PROJECT_TABS, unavailableNotice } = A("lib/workspace-surface")
  const surface = await surfaceOf(kit, w)
  const observed = { desks: {}, projectTabs: {}, notices: {}, deskAreasKnown: Object.keys(WORKSPACE_DESKS).sort(), projectTabAreasKnown: Object.keys(WORKSPACE_PROJECT_TABS).sort() }
  for (const desk of Object.keys(WORKSPACE_DESKS)) {
    observed.desks[desk] = {}
    for (const role of ROLES) {
      // Payment runs and reconciliation open when vendor payouts are set up; their pages use the payout-rail guard.
      const guard = desk === "payment_runs" || desk === "payment_reconciliation"
        ? () => surfaceModule.guardPayoutRailDesk(desk)
        : () => surfaceModule.guardWorkspaceDesk(desk)
      observed.desks[desk][role] = await kit.as(w.actors[role], () => guarded(guard))
    }
    observed.notices[desk] = unavailableNotice(surface, desk)
  }
  for (const tab of Object.keys(WORKSPACE_PROJECT_TABS)) {
    observed.projectTabs[tab] = {}
    for (const role of ROLES) observed.projectTabs[tab][role] = await kit.as(w.actors[role], () => guarded(() => surfaceModule.guardProjectTab(w.jobs.gc, tab)))
    observed.notices[`tab:${tab}`] = unavailableNotice(surface, tab)
  }
  check.equal("every desk, settings page and project tab the workspace names redirects each of the four roles to /?unavailable=<area> with the reason the home page prints; the one page a trade company keeps (templates) is allowed", spec.expected, observed)
  return { orgId: w.orgId }
}

// ---------------------------------------------------------------------------
// 5. Routes a trade company works in stay open

async function tradeRoutesStayOpen(kit, spec, check) {
  const w = await tradeCompany(kit)
  const surface = await surfaceOf(kit, w)
  const { surfaceAllowsPath } = A("lib/workspace-surface")
  const { buildTradeNavGroups } = A("components/layout/trade-nav-items.ts")
  const surfaceModule = A("lib/services/workspace-surface")
  const navUrls = buildTradeNavGroups("/").flatMap((group) => group.items.map((item) => item.url))
  const jobPaths = ["", "/schedule", "/time", "/daily-logs", "/punch", "/documents", "/photos", "/financials/billing", "/financials/expenses", "/change-orders", "/payables"]
  const observed = {
    navUrlsAllowed: Object.fromEntries(navUrls.map((url) => [url, surfaceAllowsPath(surface, url)])),
    jobPathsAllowed: Object.fromEntries(jobPaths.map((path) => [path || "/", surfaceAllowsPath(surface, `/projects/${w.jobs.gc}${path}`)])),
    templatesPage: {},
  }
  for (const role of ROLES) observed.templatesPage[role] = await kit.as(w.actors[role], () => guarded(() => surfaceModule.guardWorkspaceDesk("settings_templates")))
  check.equal("every link in the trade navigation, the job tabs a trade company uses and the templates page are allowed by the workspace surface", spec.expected, observed)
  return { orgId: w.orgId }
}

// ---------------------------------------------------------------------------
// 6. A project module override reopens one job's tab

async function moduleOverrideReopensOneJobsTab(kit, spec, check) {
  const w = await tradeCompany(kit)
  const surfaceModule = A("lib/services/workspace-surface")
  const modules = app("project-modules")
  const tab = (job, name, role = "owner") => kit.as(w.actors[role], () => guarded(() => surfaceModule.guardProjectTab(job, name)))
  const set = (moduleKey, enabled) => kit.as(w.actors.owner, () => modules.setProjectModuleOverride({ projectId: w.jobs.gc, moduleKey, enabled }))
  const observed = { before: await tab(w.jobs.gc, "bids") }
  await set("bids", true)
  observed.afterOnTheGcJob = await tab(w.jobs.gc, "bids")
  observed.theForemanOnTheGcJob = await tab(w.jobs.gc, "bids", "foreman")
  observed.afterOnAnotherJob = await tab(w.jobs.commercial, "bids")
  // Warranty is carried by a plan feature the Arc Trade plan does not include: no per-job override reopens it.
  await set("warranty", true)
  observed.planFeatureStaysRefusedDespiteOverride = await tab(w.jobs.gc, "warranty")
  // Leave the fixture as it was found.
  await set("bids", false)
  await set("warranty", false)
  observed.afterSwitchedBackOff = await tab(w.jobs.gc, "bids")
  check.equal("an override reopens Bids on the one job it is set for, for the owner and the foreman on that job; it does not reopen Warranty, which the plan withholds (no Closeout & Warranty feature); switching it off closes the tab again", spec.expected, observed)
  return { orgId: w.orgId, projectId: w.jobs.gc }
}

// ---------------------------------------------------------------------------
// 7. Enforcement is central

async function builderMutationsAreRefusedCentrally(kit, spec, check) {
  const w = await tradeCompany(kit)
  const control = kit.organization({ name: "TRADE-SETUP-01 control builder", chart: [] })
  const mutations = {
    "divisions: create a division": () => app("divisions").createDivision({ name: "Gulf Coast", code: "GC" }),
    "communities: create a community": () => app("communities").createCommunity({ name: "Cypress Landing", status: "planning", plannedLotCount: 10, targetAbsorptionPerMonth: 1 }),
    "house plans: create a plan": () => app("house-plans").createHousePlan({ code: "MG1650", name: "The Mangrove", status: "draft" }),
  }
  const observed = { tradeCompany: {}, controlBuilderOrg: {} }
  for (const [name, mutate] of Object.entries(mutations)) {
    observed.tradeCompany[name] = {}
    for (const role of ROLES) observed.tradeCompany[name][role] = await kit.as(w.actors[role], () => refusal(mutate))
    observed.controlBuilderOrg[name] = await kit.as(control.owner, () => refusal(mutate))
  }
  const written = kit.rows(`select (select count(*)::int from public.divisions where org_id=${kit.q(w.orgId)}) divisions,
    (select count(*)::int from public.communities where org_id=${kit.q(w.orgId)}) communities, (select count(*)::int from public.house_plans where org_id=${kit.q(w.orgId)}) house_plans`)[0]
  observed.rowsTheTradeCompanyWrote = written
  check.equal("each builder operation is refused for every trade role (with the sentence that names the plan wherever the role holds the key), nothing is written, and the identical call succeeds in a builder organization", spec.expected, observed)
  return { orgId: w.orgId, controlOrgId: control.orgId }
}

// ---------------------------------------------------------------------------
// 8. Menus and settings

async function menusAndSettingsHoldNoBuilderModules(kit, spec, check) {
  const w = await tradeCompany(kit)
  const surface = await surfaceOf(kit, w)
  const { q } = kit
  const observed = {}
  for (const role of ROLES) {
    const menus = await menusFor(kit, w, role, surface)
    const catalog = kit.rows(`select rp.permission_key key from public.role_permissions rp join public.roles r on r.id=rp.role_id where r.key=${q(w.actors[role].role)}`).map((row) => row.key)
    const heldInCatalog = new Set(catalog.map(domainOf).filter((domain) => BUILDER_DOMAINS.includes(domain)))
    const effective = new Set(menus.permissions.map(domainOf).filter((domain) => BUILDER_DOMAINS.includes(domain)))
    observed[role] = {
      builderDomainsTheRoleCatalogGrants: [...heldInCatalog].length > 0,
      builderDomainsEffective: [...effective].sort(),
      holdsTimeApproval: menus.permissions.includes("time.approve"),
      nav: menus.org,
      settings: menus.settings,
      jobNav: menus.jobNav,
    }
  }
  check.equal("each role's effective permissions carry no builder domain (even where its catalog role grants one), and its navigation, settings and job tabs list no builder module", spec.expected, observed)
  return { orgId: w.orgId }
}

// ---------------------------------------------------------------------------
// 9. Crew sees assigned jobs only

async function crewSeesOnlyAssignedJobs(kit, spec, check) {
  const w = await tradeCompany(kit)
  const jobName = (id) => Object.entries(w.jobs).find(([, job]) => job === id)?.[0]
  const { hasProjectPermission } = A("lib/services/permissions")
  const observed = { visibleJobs: {}, scheduleReadOnGcJob: {}, scheduleReadOnHomeownerJob: {} }
  for (const role of ROLES) {
    const actor = w.actors[role]
    observed.visibleJobs[role] = (await kit.as(actor, () => A("lib/services/projects").listProjects())).map((project) => jobName(project.id)).sort()
    observed.scheduleReadOnGcJob[role] = await kit.as(actor, () => hasProjectPermission(actor.userId, w.jobs.gc, "schedule.read"))
    observed.scheduleReadOnHomeownerJob[role] = await kit.as(actor, () => hasProjectPermission(actor.userId, w.jobs.homeowner, "schedule.read"))
  }
  observed.crewTwoVisibleJobs = (await kit.as(w.actors.crewTwo, () => A("lib/services/projects").listProjects())).map((project) => jobName(project.id)).sort()
  observed.crewOpensTheGcJobsBilling = await kit.as(w.actors.crew, () => refusal(() => A("lib/services/permissions").requireProjectPermission(w.actors.crew.userId, w.jobs.gc, "invoice.read")))
  check.equal("the owner and office admin see all three jobs, the foreman the two he runs, a crew member only the job he is assigned to, and a crew member cannot read the schedule or billing of a job he is not on", spec.expected, observed)
  return { orgId: w.orgId }
}

// ---------------------------------------------------------------------------
// 10. Vocabulary

const FORBIDDEN = /\b(owners?|clients?|projects?|vendors?|trade partners?|pipeline)\b/i
// A rendered email never calls the sender "Builder" (its customer may be one, so the pay application labels, which name the customer, keep that word).
const RENDERED_FORBIDDEN = /\b(owners?|clients?|projects?|builders?|trade partners?|pipeline)\b/i

/** What a recipient reads in a rendered email or document: markup, styles, entities and zero-width padding removed. */
const visibleText = (html) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").replace(/[\u200b-\u200f]/g, "").replace(/\s+/g, " ").replace(/ ([:.,])/g, "$1")

/** The trade company's customer-facing emails and pay application wording, rendered with the org's own nouns. */
async function renderedCustomerDocuments(surface) {
  const { render } = require("@react-email/components")
  const { profileTerminology } = A("lib/terminology")
  const { resolveReceivablesPolicy } = A("lib/receivables/policy")
  const { payApplicationLabels } = A("lib/financials/pay-application-labels")
  const { payApplicationCertificationCopy } = A("lib/emails/pay-application-email")
  const projectLabel = profileTerminology(surface.profile).project
  const shared = { orgName: "Volt Electric", projectName: "Panel upgrade", projectLabel }
  const emails = {
    "portal invite email": A("lib/emails/project-portal-invite-email").ProjectPortalInviteEmail({ ...shared, portalType: "client", portalLink: "https://arc.test/p/token" }),
    "invoice email": A("lib/emails/invoice-email").InvoiceEmail({ ...shared, invoiceNumber: "INV-7", amount: "$100.00", invoiceLink: "https://arc.test/i/token" }),
    "estimate email": A("lib/emails/estimate-email").EstimateEmail({ ...shared, estimateTitle: "Panel quote", reviewLink: "https://arc.test/e/token" }),
  }
  const rendered = []
  for (const [source, element] of Object.entries(emails)) rendered.push({ source, text: visibleText(await render(element)), noBuilder: true })
  const copy = payApplicationCertificationCopy({ orgName: "Volt Electric", projectName: "Panel upgrade", projectNoun: projectLabel, applicationNumber: 3, revision: 1, includesWaiver: true })
  rendered.push({ source: "pay application certification email", text: Object.values(copy).filter(Boolean).join(" "), noBuilder: true })
  // The G702 and the draw summary read the same labels from the job's receivables policy.
  for (const posture of ["residential", "commercial"]) {
    for (const customer_kind of ["company", "person"]) {
      const policy = resolveReceivablesPolicy({ posture, profile: surface.profile, settingsMetadata: { receivables: { customer_kind, customer_certifies: true } } })
      const labels = payApplicationLabels({ customerLabel: policy.documentCustomerLabel, projectLabel: policy.documentProjectLabel })
      rendered.push({ source: `pay application labels ${posture}/${customer_kind}`, text: Object.values(labels).join(" ") })
    }
  }
  return rendered
}

async function tradeVocabularyIsClean(kit, spec, check) {
  const w = await tradeCompany(kit)
  const surface = await surfaceOf(kit, w)
  const { terminology, profileTerminology } = A("lib/terminology")
  const nouns = {}
  for (const posture of ["residential", "commercial"]) nouns[`jobs/${posture}`] = terminology(posture, surface.profile)
  nouns.profile = profileTerminology(surface.profile)
  const terms = Object.entries(nouns).flatMap(([scope, set]) => Object.entries(set).map(([key, value]) => ({ source: `terminology ${scope}.${key}`, text: String(value) })))
  const owner = await menusFor(kit, w, "owner", surface)
  const { WORKSPACE_DESKS, WORKSPACE_PROJECT_TABS, unavailableNotice } = A("lib/workspace-surface")
  const notices = [...Object.keys(WORKSPACE_DESKS), ...Object.keys(WORKSPACE_PROJECT_TABS)].map((area) => unavailableNotice(surface, area)).filter(Boolean).map((text) => ({ source: "refusal notice", text }))
  const labels = [
    ...notices,
    ...owner.org.flatMap((group) => [group.label, ...group.items]).map((text) => ({ source: "nav", text })),
    ...owner.settings.flatMap((section) => [section.label, ...section.items]).map((text) => ({ source: "settings", text })),
    ...owner.jobNav.map((text) => ({ source: "job nav", text })),
  ]
  const documents = await renderedCustomerDocuments(surface)
  const leaks = [
    ...[...terms, ...labels].filter(({ text }) => FORBIDDEN.test(text)).map(({ source, text }) => `${source}: ${text}`),
    ...documents
      .map(({ source, text, noBuilder }) => ({ source, text, rule: noBuilder ? RENDERED_FORBIDDEN : FORBIDDEN }))
      .filter(({ text, rule }) => rule.test(text))
      .map(({ source, text, rule }) => `${source}: ${text.match(rule)[0]}`),
  ]
  check.equal("the nouns resolved for this company's jobs and the labels in its navigation, settings and job tabs, and the text of its rendered portal invite, invoice, estimate and pay application certification emails and G702 / draw summary labels, contain none of Owner, Client, Project, Vendor, Trade partner or Pipeline (and none of Builder in the rendered emails)", spec.expected, { leaks: [...new Set(leaks)].sort() })
  return { orgId: w.orgId }
}

module.exports = {
  id: "TRADE-SETUP-01",
  subcases: {
    "provisioned-on-the-trade-plan": provisionedOnTheTradePlan,
    "team-holds-the-trade-roles": teamHoldsTheTradeRoles,
    "fixtures-jobs-and-customers": fixturesJobsAndCustomers,
    "builder-routes-refuse-every-role": builderRoutesRefuseEveryRole,
    "trade-routes-stay-open": tradeRoutesStayOpen,
    "module-override-reopens-one-jobs-tab": moduleOverrideReopensOneJobsTab,
    "builder-mutations-are-refused-centrally": builderMutationsAreRefusedCentrally,
    "menus-and-settings-hold-no-builder-modules": menusAndSettingsHoldNoBuilderModules,
    "crew-sees-only-assigned-jobs": crewSeesOnlyAssignedJobs,
    "trade-vocabulary-is-clean": tradeVocabularyIsClean,
  },
}
