// TRADE-IOS-01 — the iOS contract for a trade company (TR01-04, TR03-01, TR05-02). The
// seeded electrical company's people sign in for real (GoTrue access tokens) and call the
// /api/mobile/v1 route handlers exactly as the app does: bearer token plus the selected
// organization.
//
//   organizations-expose-profile-brand-and-terms   /organizations carries business_profile, brand and
//                                                  the job nouns; a builder organization is unchanged
//   workspace-catalog-drops-builder-modules        the module catalog an organization and a job get,
//                                                  per role, with Time named Crew time
//   catalog-titles-use-trade-vocabulary            the catalog names no builder noun
//   clock-in-and-out-round-trip                    a crew member clocks in and out on an assigned job
//                                                  and the hours land as a submitted time entry
//   clock-refuses-an-unassigned-job                a crew member cannot clock in a job he is not on
//   clock-refuses-clocking-in-another-worker       time.manage is the foreman's, not the crew member's
const { tradeCompany, mobileCall } = require("../trade-seed.cjs")

const FORBIDDEN = /\b(owners?|clients?|projects?|vendors?|trade partners?|pipeline)\b/i
const ids = (response) => (response.body?.data ?? []).map((entry) => entry.id)

async function organizationsExposeProfileBrandAndTerms(kit, spec, check) {
  const w = await tradeCompany(kit)
  const builderPassword = "Acceptance-Builder-2026!"
  const control = kit.organization({ name: "TRADE-IOS-01 control builder", chart: [], password: builderPassword })
  const mine = async (actor, password) => {
    const response = await mobileCall(kit, actor, "organizations", { orgHeader: null, password })
    const row = (response.body.data ?? []).find((org) => org.id === actor.orgId)
    return { status: response.status, organization: row ? { role: row.role, business_profile: row.business_profile, brand: row.brand, terms: row.terms } : null }
  }
  const observed = {
    owner: await mine(w.actors.owner),
    foreman: await mine(w.actors.foreman),
    crew: await mine(w.actors.crew),
    controlBuilderOwner: await mine(control.owner, builderPassword),
  }
  check.equal("each trade member's organization list carries the trade business profile, the Arc Trade brand and Job/Jobs; a builder organization keeps its builder profile, brand and Project/Projects", spec.expected, observed)
  return { orgId: w.orgId, controlOrgId: control.orgId }
}

async function workspaceCatalogDropsBuilderModules(kit, spec, check) {
  const w = await tradeCompany(kit)
  const builderPassword = "Acceptance-Builder-2026!"
  const control = kit.organization({ name: "TRADE-IOS-01 control builder catalog", chart: [], password: builderPassword })
  // The stack's builder fixture has no subscription, which locks an organization out of the mobile API.
  kit.sql(`insert into public.subscriptions(org_id, status, current_period_start, current_period_end) values (${kit.q(control.orgId)}, 'active', now(), now() + interval '30 days');`)
  const catalog = (actor, query = "", password) => mobileCall(kit, actor, "workspace", { query, password })
  const observed = { organization: {}, homeownerJob: {}, timeTitle: {}, controlBuilderOrganization: {} }
  for (const role of ["owner", "foreman", "crew"]) {
    const org = await catalog(w.actors[role])
    const job = await catalog(w.actors[role], `?project_id=${w.jobs.homeowner}`)
    observed.organization[role] = org.status === 200 ? ids(org) : `status ${org.status}`
    observed.homeownerJob[role] = job.status === 200 ? ids(job) : `status ${job.status}`
    observed.timeTitle[role] = (job.body?.data ?? []).find((entry) => entry.id === "time")?.title ?? null
  }
  const builder = await catalog(control.owner, "", builderPassword)
  observed.controlBuilderOrganization = { status: builder.status, hasTheBuilderModules: ["bids", "purchasing", "warranty"].every((id) => ids(builder).includes(id)) }
  const builderJob = await mobileCall(kit, w.actors.owner, "workspace", { query: `?project_id=${w.jobs.gc}` })
  observed.builderModulesAbsentFromEveryTradeCatalog = ["estimates", "bids", "rfis", "submittals", "decisions", "budget", "commitments", "closeout", "warranty", "purchasing", "sales", "communities", "plans", "design-studio", "starts"]
    .filter((id) => [...Object.values(observed.organization), ...Object.values(observed.homeownerJob), ids(builderJob)].some((list) => Array.isArray(list) && list.includes(id)))
  check.equal("the catalog an organization and a job get omits every module the Arc Trade workspace refuses, follows each role's permissions, names Time Crew time, and still serves the builder modules to a builder organization", spec.expected, observed)
  return { orgId: w.orgId, controlOrgId: control.orgId }
}

async function catalogTitlesUseTradeVocabulary(kit, spec, check) {
  const w = await tradeCompany(kit)
  const leaks = []
  const scan = (scope, modules) => {
    for (const entry of modules ?? []) {
      for (const text of [entry.title, entry.group, ...[...(entry.create_fields ?? []), ...(entry.edit_fields ?? [])].map((field) => field.label)])
        if (text && FORBIDDEN.test(text)) leaks.push(`${scope} ${entry.id}: ${text}`)
    }
  }
  scan("organization", (await mobileCall(kit, w.actors.owner, "workspace")).body.data)
  scan("job", (await mobileCall(kit, w.actors.owner, "workspace", { query: `?project_id=${w.jobs.homeowner}` })).body.data)
  check.equal("no module title, group or field label the iOS app receives for the trade company contains Owner, Client, Project, Vendor, Trade partner or Pipeline", spec.expected, { leaks: [...new Set(leaks)].sort() })
  return { orgId: w.orgId }
}

async function clockInAndOutRoundTrip(kit, spec, check) {
  const w = await tradeCompany(kit)
  const { q } = kit
  const crew = w.actors.crew
  const call = (route, options) => mobileCall(kit, crew, `time/clock${route}`, options)
  const open = (response) => response.body?.data?.open ?? response.body?.data?.session ?? null
  // The job budgets no codes and approval needs one, so the clock asks from the company's own.
  const costCodeId = kit.rows(`select id from public.cost_codes where org_id=${q(w.orgId)} and is_active order by code limit 1`)[0]?.id ?? null
  const before = await call("")
  const clockedIn = await call("/in", { method: "POST", body: { project_id: w.jobs.homeowner, cost_code_id: costCodeId } })
  const during = await call("")
  const again = await call("/in", { method: "POST", body: { project_id: w.jobs.homeowner, cost_code_id: costCodeId } })
  // The clock has run: two and a half hours ago, as the app's own session would read after a morning's work.
  kit.sql(`update public.time_clock_sessions set started_at = now() - interval '150 minutes' where org_id=${q(w.orgId)} and worker_user_id=${q(crew.userId)} and ended_at is null;`)
  const out = await call("/out", { method: "POST", body: {} })
  const after = await call("")
  const entry = kit.rows(`select hours, status, project_id, is_overtime from public.time_entries where org_id=${q(w.orgId)} and worker_user_id=${q(crew.userId)} order by created_at desc limit 1`)[0] ?? null
  const mine = await mobileCall(kit, crew, "time/mine")
  const observed = {
    jobsOffered: (before.body.data?.jobs ?? []).map((job) => job.name),
    canClockOthers: before.body.data?.can_clock_others,
    openBeforeClockIn: open(before),
    clockInStatus: clockedIn.status,
    clockedInOn: open(clockedIn) && { onTheAssignedJob: open(clockedIn).project_id === w.jobs.homeowner, project_name: open(clockedIn).project_name, source: open(clockedIn).source, workerIsTheCrewMember: open(clockedIn).worker_user_id === crew.userId },
    openWhileClockedIn: open(during) && open(during).project_name,
    secondClockInStatus: again.status,
    clockOut: { status: out.status, clocked_out: out.body.data?.clocked_out },
    openAfterClockOut: open(after),
    timeEntry: entry && { hoursToTheTenth: Math.round(Number(entry.hours) * 10) / 10, status: entry.status, onTheJob: entry.project_id === w.jobs.homeowner, overtime: entry.is_overtime },
    myHoursListsIt: mine.status === 200 && (mine.body.data?.current?.entries ?? []).some((row) => row.project_id === w.jobs.homeowner && Math.round(Number(row.hours) * 10) / 10 === 2.5),
  }
  check.equal("a crew member sees only the job he is on, clocks in from the phone (a second clock-in is refused), clocks out, and 2.5 hours land as one submitted time entry on that job that My hours lists", spec.expected, observed)
  return { orgId: w.orgId }
}

async function clockRefusesAnUnassignedJob(kit, spec, check) {
  const w = await tradeCompany(kit)
  const refused = await mobileCall(kit, w.actors.crew, "time/clock/in", { method: "POST", body: { project_id: w.jobs.gc } })
  const sessions = Number(kit.rows(`select count(*)::int n from public.time_clock_sessions where org_id=${kit.q(w.orgId)} and project_id=${kit.q(w.jobs.gc)}`)[0].n)
  check.equal("a crew member is refused a clock-in on a job he is not assigned to, and no session opens", spec.expected, { status: refused.status, code: refused.body?.error?.code ?? null, sessionsOpened: sessions })
  return { orgId: w.orgId }
}

async function clockRefusesClockingInAnotherWorker(kit, spec, check) {
  const w = await tradeCompany(kit)
  const { q } = kit
  const costCodeId = kit.rows(`select id from public.cost_codes where org_id=${q(w.orgId)} and is_active order by code limit 1`)[0]?.id ?? null
  const clockIn = (actor, body) => mobileCall(kit, actor, "time/clock/in", { method: "POST", body: { ...body, cost_code_id: costCodeId } })
  const crewClocksAnother = await clockIn(w.actors.crew, { project_id: w.jobs.homeowner, worker_user_id: w.actors.crewTwo.userId })
  const openedForOther = Number(kit.rows(`select count(*)::int n from public.time_clock_sessions where org_id=${q(w.orgId)} and worker_user_id=${q(w.actors.crewTwo.userId)} and created_by=${q(w.actors.crew.userId)}`)[0].n)
  kit.sql(`delete from public.time_clock_sessions where org_id=${q(w.orgId)} and ended_at is null;`)
  const foremanClocksCrew = await clockIn(w.actors.foreman, { project_id: w.jobs.homeowner, worker_user_id: w.actors.crewTwo.userId })
  kit.sql(`delete from public.time_clock_sessions where org_id=${q(w.orgId)} and ended_at is null;`)
  check.equal("a crew member (no time.manage in his role) is refused clocking in another worker and opens nothing; the foreman clocks a crew member in", spec.expected,
    { crewClocksAnother: { status: crewClocksAnother.status, code: crewClocksAnother.body?.error?.code ?? null }, sessionsTheCrewMemberOpenedForSomeoneElse: openedForOther, foremanClocksACrewMember: foremanClocksCrew.status })
  return { orgId: w.orgId }
}

module.exports = {
  id: "TRADE-IOS-01",
  subcases: {
    "organizations-expose-profile-brand-and-terms": organizationsExposeProfileBrandAndTerms,
    "workspace-catalog-drops-builder-modules": workspaceCatalogDropsBuilderModules,
    "catalog-titles-use-trade-vocabulary": catalogTitlesUseTradeVocabulary,
    "clock-in-and-out-round-trip": clockInAndOutRoundTrip,
    "clock-refuses-an-unassigned-job": clockRefusesAnUnassignedJob,
    "clock-refuses-clocking-in-another-worker": clockRefusesClockingInAnotherWorker,
  },
}
