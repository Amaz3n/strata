// Mixed-role load on a scaled production builder (EP13-02). Every virtual user is a
// signed-in member working their own desk: they open it (a real page request to the
// acceptance app, with their own session cookie, so permissions, division scope and
// rendering are all real), now and then open one of their homes, and every few views
// make the change their job makes, through the same service the page's server action
// calls. Reads are timed to the last byte of the page; writes to the service's return.
//
// The acceptance app runs `next dev`: pages are rendered by the development server
// (unminified, no production caching, single process), so page latency here is a
// pessimistic upper bound, not a production measurement. Mobile is out of scope.
//
// The workload is reproducible: each session draws from its own PRNG, seeded from the
// profile's seed and its index, so who does what, when and on which record does not
// depend on how the sessions' requests interleave. Invariants are read from the database before and after: the
// starts queue, agreements, deposits and lots do not move; purchase orders, prospects,
// warranty requests, daily logs and release slots move by exactly the writes the
// workload says it made.
const { randomUUID } = require("node:crypto")
const { prng } = require("./production-scale-seed.cjs")

// Who is online: role -> share of the sessions, the desk they live on, and the write their job makes.
const ROLES = {
  starts: { share: 0.12, desk: "/starts" },
  purchasing: { share: 0.12, desk: "/purchasing" },
  sales: { share: 0.24, desk: "/sales" },
  warranty: { share: 0.12, desk: "/warranty" },
  superintendent: { share: 0.4, desk: "/" },
}
const WRITE_SHARE = 0.2
const HOME_SHARE = 0.25
const PAGE_TIMEOUT_MS = 120000

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null)

/** A session cookie for the app, from the stack's own auth service (the browser's @supabase/ssr encoding). */
async function sessionCookie(kit, email, password) {
  // Signing in is the harness, not the system under test: a dropped connection to the stack's auth service is tried again.
  const signIn = () => fetch(`${kit.apiUrl}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password }) })
  let response
  for (let attempt = 1; !response; attempt += 1) {
    response = await signIn().catch((error) => {
      if (attempt >= 3) throw error
      return new Promise((resolve) => setTimeout(resolve, 2000 * attempt)).then(() => null)
    })
  }
  const session = await response.json()
  if (!session.access_token) throw Error(`Sign-in failed for ${email}: ${JSON.stringify(session).slice(0, 200)}`)
  const name = `sb-${new URL(kit.apiUrl).hostname.split(".")[0]}-auth-token`
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
  const chunks = []
  for (let i = 0; i < value.length; i += 3180) chunks.push(value.slice(i, i + 3180))
  return chunks.length === 1 ? `${name}=${value}` : chunks.map((chunk, i) => `${name}.${i}=${chunk}`).join("; ")
}

/** One page, timed to its last byte. A failure is any non-200, a redirect, or a desk that rendered its error state. */
async function page(appUrl, cookie, path) {
  const startedAt = performance.now()
  try {
    const response = await fetch(`${appUrl}${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) })
    const body = await response.text()
    const ms = performance.now() - startedAt
    if (response.status !== 200) return { ms, error: `HTTP ${response.status}${response.headers.get("location") ? ` -> ${response.headers.get("location")}` : ""}` }
    const failed = /could not be loaded/.exec(body.replace(/<script[\s\S]*?<\/script>/g, ""))
    return failed ? { ms, error: "rendered an error state" } : { ms, bytes: body.length }
  } catch (error) {
    return { ms: performance.now() - startedAt, error: error.name === "TimeoutError" ? `timeout after ${PAGE_TIMEOUT_MS} ms` : error.message }
  }
}

/** What the invariants read: the queues and money the workload must not move, and the records it adds to. */
function snapshot(kit, orgId) {
  const { q } = kit
  const rows = (sql) => kit.rows(sql)
  return {
    startPackages: Object.fromEntries(rows(`select status, count(*)::int n from public.start_packages where org_id=${q(orgId)} group by 1 order by 1`).map((r) => [r.status, r.n])),
    lots: Object.fromEntries(rows(`select status, count(*)::int n from public.lots where org_id=${q(orgId)} group by 1 order by 1`).map((r) => [r.status, r.n])),
    agreements: rows(`select count(*)::int n, coalesce(sum(total_cents),0)::text cents from public.contracts where org_id=${q(orgId)} and contract_type='purchase_agreement' and status='active'`)[0],
    deposits: rows(`select count(*)::int n, coalesce(sum(amount_cents),0)::text cents from public.payments where org_id=${q(orgId)} and status='succeeded'`)[0],
    purchaseOrders: Object.fromEntries(rows(`select status, count(*)::int n, sum(total_cents)::text cents from public.commitments where org_id=${q(orgId)} and commitment_type='purchase_order' group by 1 order by 1`).map((r) => [r.status, { n: r.n, cents: r.cents }])),
    prospects: rows(`select count(*)::int n from public.prospects where org_id=${q(orgId)}`)[0].n,
    warrantyRequests: rows(`select count(*)::int n from public.warranty_requests where org_id=${q(orgId)}`)[0].n,
    dailyLogs: rows(`select count(*)::int n from public.daily_logs where org_id=${q(orgId)}`)[0].n,
    releaseSlots: rows(`select count(*)::int n from public.community_release_slots where org_id=${q(orgId)}`)[0].n,
  }
}

/** Statement totals from pg_stat_statements, to say where database time went during the run. */
function statementTotals(kit) {
  return kit.rows(`select queryid::text id, left(regexp_replace(query, '\\s+', ' ', 'g'), 220) query, calls::bigint calls, total_exec_time::float8 ms, max_exec_time::float8 max_ms
    from extensions.pg_stat_statements where dbid = (select oid from pg_database where datname = 'postgres') and calls > 0`)
}
function statementDiff(before, after, limit = 12) {
  const prior = new Map(before.map((row) => [row.id, row]))
  return after.map((row) => { const was = prior.get(row.id); return { query: row.query, calls: row.calls - (was?.calls ?? 0), ms: row.ms - (was?.ms ?? 0) } })
    .filter((row) => row.calls > 0).sort((a, b) => b.ms - a.ms).slice(0, limit)
    .map((row) => ({ ...row, ms: Math.round(row.ms), meanMs: Math.round((row.ms / row.calls) * 10) / 10 }))
}

/**
 * Runs the workload. `seeded` is what seedAtProfile returned (its org, team and password).
 * Returns per-surface latency and error figures, throughput, the before/after snapshots,
 * what the workload wrote, and the database statements that took the most time.
 */
async function runLoad(kit, seeded, { appUrl = "http://localhost:3210", sessions = 50, durationMs = 300000, thinkMs = [5000, 15000], prngSeed = 20261020, log = () => {} } = {}) {
  const { q } = kit
  const orgId = seeded.org.orgId
  const pickWith = (random) => (list) => list[Math.floor(random() * list.length)]
  const app = (name) => require(`../../lib/services/${name}`)
  const { team } = seeded
  const divisionOf = (actor) => kit.rows(`select md.division_id from public.membership_divisions md join public.memberships m on m.id=md.membership_id where m.user_id=${q(actor.userId)} and m.org_id=${q(orgId)}`)[0]?.division_id
  const people = {
    starts: team.divisions.map((d) => d.starts), purchasing: team.divisions.map((d) => d.purchasing), warranty: team.divisions.map((d) => d.warranty),
    sales: team.sales, superintendent: team.superintendents.flat(),
  }

  // The records each person works on, read once up front (never the template community's staff).
  const work = new Map()
  for (const list of Object.values(people)) for (const actor of list) {
    const division = divisionOf(actor)
    work.set(actor.userId, {
      division,
      communities: kit.rows(`select id from public.communities where org_id=${q(orgId)} and division_id=${q(division)} order by name`).map((r) => r.id),
      activeHomes: kit.rows(`select p.id from public.projects p join public.lots l on l.project_id=p.id where p.org_id=${q(orgId)} and p.superintendent_id=${q(actor.userId)} and l.status in ('started','assigned') order by p.name`).map((r) => r.id),
    })
  }
  const divisionHomes = (division, status) => kit.rows(`select p.id from public.projects p join public.lots l on l.project_id=p.id join public.communities c on c.id=l.community_id
    where p.org_id=${q(orgId)} and c.division_id=${q(division)} and l.status=${q(status)} order by p.name`).map((r) => r.id)
  // Draft purchase orders on spec homes, per division: each is approved at most once.
  const draftOrders = new Map(team.divisions.map((d) => [divisionOf(d.purchasing), kit.rows(`select c.id, c.total_cents::text cents from public.commitments c join public.lots l on l.project_id=c.project_id join public.communities m on m.id=l.community_id
    where c.org_id=${q(orgId)} and c.commitment_type='purchase_order' and c.status='draft' and m.division_id=${q(divisionOf(d.purchasing))} order by c.contract_number`)]))
  const installed = new Map(team.divisions.map((d) => [divisionOf(d.warranty), divisionHomes(divisionOf(d.warranty), "closed")]))
  const weekAhead = (weeks) => { const day = new Date(); day.setUTCDate(day.getUTCDate() + weeks * 7 - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10) }

  const wrote = { purchaseOrdersApproved: 0, purchaseOrderCentsApproved: 0n, prospects: 0, warrantyRequests: 0, dailyLogs: 0, releaseSlotKeys: new Set() }
  const existingSlots = new Set(kit.rows(`select community_id || ':' || week_start key from public.community_release_slots where org_id=${q(orgId)}`).map((r) => r.key))
  const today = new Date().toISOString().slice(0, 10)
  const WRITES = {
    starts: { name: "release slot", run: async (actor, mine, random) => {
      const communityId = pickWith(random)(mine.communities), week = weekAhead(8 + Math.floor(random() * 8))
      await kit.as(actor, () => app("even-flow").setReleaseSlot(communityId, week, { targetStarts: 2 + Math.floor(random() * 3), notes: "Load: even-flow plan" }))
      if (!existingSlots.has(`${communityId}:${week}`)) wrote.releaseSlotKeys.add(`${communityId}:${week}`)
    } },
    purchasing: { name: "purchase order approval", run: async (actor, mine) => {
      const order = draftOrders.get(mine.division).shift()
      if (!order) return "skipped"
      await kit.as(actor, () => app("commitments").updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Load: trade prequalification on file offline." } }))
      wrote.purchaseOrdersApproved += 1
      wrote.purchaseOrderCentsApproved += BigInt(order.cents)
    } },
    sales: { name: "walk-in registration", run: async (actor, mine, random) => {
      const id = randomUUID().slice(0, 8)
      await kit.as(actor, () => app("sales-inquiries").registerProductionInquiry({ buyerName: `Load Walk-in ${id}`, email: `walkin-${id}@acceptance.example.test`, phone: `239-555-${String(Math.floor(random() * 10000)).padStart(4, "0")}`, communityId: pickWith(random)(mine.communities), ownerUserId: actor.userId, channel: "walk_in", loggedDate: today }))
      wrote.prospects += 1
    } },
    warranty: { name: "warranty request", run: async (actor, mine, random) => {
      await kit.as(actor, () => app("warranty-operations").createWarrantyRequest({ input: { project_id: pickWith(random)(installed.get(mine.division)), title: "Load: caulk failing at tub", description: "Homeowner reports caulk separating at the tub surround.", severity: "routine_30" } }))
      wrote.warrantyRequests += 1
    } },
    superintendent: { name: "daily log", run: async (actor, mine, random) => {
      if (!mine.activeHomes.length) return "skipped"
      await kit.as(actor, () => app("daily-logs").createDailyLog({ input: { project_id: pickWith(random)(mine.activeHomes), date: today, summary: "Load: framing crew on site, inspection passed.", weather: { conditions: "Sunny", temperature: "84F" }, entries: [{ entry_type: "work", description: "Framing", hours: 8 }] } }))
      wrote.dailyLogs += 1
    } },
  }

  // Sessions, by role share (largest remainder), each a member signed in once.
  const counts = Object.fromEntries(Object.entries(ROLES).map(([role, spec]) => [role, Math.floor(sessions * spec.share)]))
  let left = sessions - Object.values(counts).reduce((a, b) => a + b, 0)
  for (const role of Object.keys(ROLES)) if (left-- > 0) counts[role] += 1
  const users = []
  for (const [role, count] of Object.entries(counts)) for (let i = 0; i < count; i++) users.push({ role, actor: people[role][i % people[role].length] })
  const cookies = new Map()
  for (const { actor } of users) if (!cookies.has(actor.userId)) cookies.set(actor.userId, await sessionCookie(kit, actor.email, seeded.password))
  const homePath = (mine, random) => (mine.activeHomes.length ? `/projects/${pickWith(random)(mine.activeHomes)}` : null)

  // Warm-up: every route compiled and every session's desk loaded once, untimed.
  log(`warm-up: ${users.length} sessions`)
  const warmUp = prng(prngSeed)
  for (const { role, actor } of users) {
    await page(appUrl, cookies.get(actor.userId), ROLES[role].desk)
    const home = homePath(work.get(actor.userId), warmUp)
    if (home) await page(appUrl, cookies.get(actor.userId), home)
  }

  const before = snapshot(kit, orgId)
  const statementsBefore = statementTotals(kit)
  const samples = {}
  const record = (surface, result) => {
    const sample = (samples[surface] ??= { ms: [], errors: [] })
    sample.ms.push(result.ms)
    if (result.error) sample.errors.push(result.error)
  }
  const startedAt = performance.now(), endsAt = startedAt + durationMs
  log(`measuring for ${Math.round(durationMs / 1000)}s`)
  await Promise.all(users.map(async ({ role, actor }, index) => {
    const mine = work.get(actor.userId), cookie = cookies.get(actor.userId), random = prng(prngSeed + 1 + index)
    // Arrivals are staggered across the first think period.
    await new Promise((resolve) => setTimeout(resolve, Math.floor((index / users.length) * thinkMs[0])))
    while (performance.now() < endsAt) {
      const roll = random()
      if (roll < WRITE_SHARE) {
        const write = WRITES[role], at = performance.now()
        try {
          const outcome = await write.run(actor, mine, random)
          if (outcome !== "skipped") record(`write ${role}: ${write.name}`, { ms: performance.now() - at })
        } catch (error) {
          record(`write ${role}: ${write.name}`, { ms: performance.now() - at, error: error.message.slice(0, 200) })
        }
      } else {
        const home = roll < WRITE_SHARE + HOME_SHARE * (1 - WRITE_SHARE) ? homePath(mine, random) : null
        record(home ? "page home workbench" : `page ${ROLES[role].desk === "/" ? "/ (home desk)" : ROLES[role].desk}`, await page(appUrl, cookie, home ?? ROLES[role].desk))
      }
      await new Promise((resolve) => setTimeout(resolve, thinkMs[0] + Math.floor(random() * (thinkMs[1] - thinkMs[0]))))
    }
  }))
  const elapsedSeconds = (performance.now() - startedAt) / 1000
  await kit.drainOutbox(orgId).catch((error) => log(`outbox after the run: ${error.message.slice(0, 200)}`))
  const after = snapshot(kit, orgId)
  const surfaces = Object.fromEntries(Object.entries(samples).sort().map(([surface, { ms, errors }]) => {
    const sorted = [...ms].sort((a, b) => a - b)
    return [surface, { requests: ms.length, errors: errors.length, errorRate: Math.round((errors.length / ms.length) * 10000) / 10000,
      p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), p99: Math.round(percentile(sorted, 99)), max: Math.round(sorted.at(-1)),
      perMinute: Math.round((ms.length / elapsedSeconds) * 600) / 10, errorSamples: [...new Set(errors)].slice(0, 3) }]
  }))
  const total = Object.values(samples).reduce((sum, s) => sum + s.ms.length, 0), failed = Object.values(samples).reduce((sum, s) => sum + s.errors.length, 0)
  return {
    parameters: { appUrl, appMode: "next dev (pessimistic: development rendering, single process)", sessions, sessionsByRole: counts, distinctMembers: cookies.size,
      writeTiming: "service-call time: the service the page's server action calls, run in-process; no server-action round trip or revalidation render", durationSeconds: Math.round(elapsedSeconds), thinkMs, writeShare: WRITE_SHARE, homeShare: HOME_SHARE, prngSeed, mobile: "out of scope" },
    totals: { requests: total, errors: failed, errorRate: Math.round((failed / total) * 10000) / 10000, perSecond: Math.round((total / elapsedSeconds) * 100) / 100 },
    surfaces,
    wrote: { ...wrote, purchaseOrderCentsApproved: String(wrote.purchaseOrderCentsApproved), releaseSlotKeys: wrote.releaseSlotKeys.size },
    before, after,
    topStatements: statementDiff(statementsBefore, statementTotals(kit)),
  }
}

/**
 * Each desk opened by one member at a time, nobody else on the app: what one desk
 * costs to build at this data volume, apart from queueing behind other sessions.
 * Every role's desk and one of a superintendent's homes, `rounds` times each, after
 * one untimed view.
 */
async function deskSweep(kit, seeded, { appUrl = "http://localhost:3210", rounds = 5 } = {}) {
  const { team } = seeded
  const firstOf = { starts: team.divisions[0].starts, purchasing: team.divisions[0].purchasing, sales: team.sales[0], warranty: team.divisions[0].warranty, superintendent: team.superintendents.flat()[0] }
  const home = kit.rows(`select p.id from public.projects p join public.lots l on l.project_id=p.id where p.org_id=${kit.q(seeded.org.orgId)} and p.superintendent_id=${kit.q(firstOf.superintendent.userId)} and l.status='started' order by p.name limit 1`)[0]?.id
  const surfaces = {}
  for (const [role, actor] of Object.entries(firstOf)) {
    const cookie = await sessionCookie(kit, actor.email, seeded.password)
    const paths = [[`page ${ROLES[role].desk === "/" ? "/ (home desk)" : ROLES[role].desk}`, ROLES[role].desk], ...(role === "superintendent" && home ? [["page home workbench", `/projects/${home}`]] : [])]
    for (const [surface, path] of paths) {
      await page(appUrl, cookie, path)
      const ms = [], errors = []
      for (let i = 0; i < rounds; i++) {
        const result = await page(appUrl, cookie, path)
        ms.push(result.ms)
        if (result.error) errors.push(result.error)
      }
      const sorted = ms.sort((a, b) => a - b)
      surfaces[surface] = { requests: rounds, errors: errors.length, p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), max: Math.round(sorted.at(-1)), errorSamples: [...new Set(errors)].slice(0, 3) }
    }
  }
  return { appMode: "next dev (pessimistic: development rendering, single process)", rounds, surfaces }
}

/** The invariants: what must not move did not, and what the workload added is exactly what it says it wrote. */
function loadInvariants(result) {
  const { before, after, wrote } = result
  const po = (snap, status) => snap.purchaseOrders[status] ?? { n: 0, cents: "0" }
  return {
    startsQueueUnchanged: JSON.stringify(before.startPackages) === JSON.stringify(after.startPackages),
    lotsUnchanged: JSON.stringify(before.lots) === JSON.stringify(after.lots),
    agreementsUnchanged: JSON.stringify(before.agreements) === JSON.stringify(after.agreements),
    depositsUnchanged: JSON.stringify(before.deposits) === JSON.stringify(after.deposits),
    approvedOrdersMovedByTheApprovals: po(after, "approved").n - po(before, "approved").n === wrote.purchaseOrdersApproved
      && BigInt(po(after, "approved").cents) - BigInt(po(before, "approved").cents) === BigInt(wrote.purchaseOrderCentsApproved),
    draftOrdersMovedByTheApprovals: po(before, "draft").n - po(after, "draft").n === wrote.purchaseOrdersApproved
      && BigInt(po(before, "draft").cents) - BigInt(po(after, "draft").cents) === BigInt(wrote.purchaseOrderCentsApproved),
    purchaseOrderTotalUnchanged: Object.values(before.purchaseOrders).reduce((s, x) => s + BigInt(x.cents), 0n) === Object.values(after.purchaseOrders).reduce((s, x) => s + BigInt(x.cents), 0n),
    prospectsAddedExactly: after.prospects - before.prospects === wrote.prospects,
    warrantyRequestsAddedExactly: after.warrantyRequests - before.warrantyRequests === wrote.warrantyRequests,
    dailyLogsAddedExactly: after.dailyLogs - before.dailyLogs === wrote.dailyLogs,
    releaseSlotsAddedExactly: after.releaseSlots - before.releaseSlots === wrote.releaseSlotKeys,
  }
}

module.exports = { ROLES, runLoad, deskSweep, loadInvariants }
