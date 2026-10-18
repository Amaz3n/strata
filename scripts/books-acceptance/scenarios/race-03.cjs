// RACE-03 — production races and injected failures (EP13-07), beside RACE-02's sixteen.
// Concurrent requests are two API calls started in one tick (two PostgREST sessions);
// failures are injected where production would meet them: a database write that fails
// (a trigger scoped to one home, armed for N attempts by a sequence, which a rollback
// does not undo), a response lost after the work committed (a service client whose
// transport drops one reply), file storage that is not there (the acceptance stack has
// none), and a notification that cannot be written. Every outcome must be
// serial-equivalent or a clean refusal; retried work happens exactly once; a job that
// keeps failing stops at its retry limit and parks; and no case deadlocks.
//
// The cases run on one production builder of their own, built on demand. Expected
// values are in expected/RACE-03.json.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")

const STARTS_JOBS = ["start_release", "start_release_trade_notice", "trade_schedule_change_notice", "start_package_notice"]
const ORGS = new WeakMap()

function orgOf(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "RACE-03 production races" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    org.buyerA = kit.addMember(org, "org_purchasing_manager")
    org.buyerB = kit.addMember(org, "org_purchasing_manager")
    org.buyerC = kit.addMember(org, "org_purchasing_manager")
    // Every release this run makes falls in this week or the next; the slot is raised as the starts desk would.
    for (const offset of [0, 7]) {
      const day = new Date(`${seed.isoDay(offset)}T12:00:00Z`)
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
      await kit.as(org.owner, () => app("even-flow").setReleaseSlot(org.communityId, day.toISOString().slice(0, 10), { targetStarts: 10, notes: "RACE-03 releases" }))
    }
    return org
  })())
  return ORGS.get(kit)
}

// ---------------------------------------------------------------------------
// Harness

const deadlocks = (kit) => Number(kit.sql("select deadlocks from pg_stat_database where datname = 'postgres'"))
/** Outcome of one request: done, or the rule that refused it. Anything unnamed is reported verbatim. */
function outcome(result) {
  if (result.status === "fulfilled") return "done"
  const message = result.reason?.message ?? String(result.reason)
  if (/deadlock detected/i.test(message)) return `deadlock: ${message}`
  if (/changed since you reviewed the cancellation|AGREEMENT_CANCELLATION_CHANGED/i.test(message)) return "refused: the sale changed under the cancellation"
  if (message === "Purchase agreement was voided") return "refused: the agreement was voided"
  if (/^Active purchase agreement not found$/.test(message)) return "refused: the agreement is no longer open"
  if (/^This home already has an open purchase agreement; reconcile it$/.test(message)) return "refused: the reservation already has its agreement"
  if (/^(The order|This variance order|This change order) changed while you were (working on|reviewing) it\. Reload/.test(message)) return "refused: changed while reviewing"
  if (message === "This change order is already approved.") return "refused: already approved"
  if (message === "The start package is not ready to release.") return "refused: the package is not ready"
  if (/^This home's sale was cancelled\. /.test(message)) return "refused: the home's sale was cancelled"
  return `error: ${message.slice(0, 200)}`
}
const clean = (label) => label === "done" || label.startsWith("refused: ")
const settled = (results) => results.map(outcome)

/**
 * A database write that fails for one home: a BEFORE INSERT trigger on `table` for rows
 * of `projectId` (a column, or the payload's for notifications) raises while its sequence
 * is at or below `times` (-1: always). The
 * sequence advances even when the failing transaction rolls back, so each attempt
 * counts. Returns { fired(), disarm() }.
 */
function armFault(kit, { table, projectId, times, label }) {
  const name = `acceptance_fault_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const limit = times < 0 ? "9223372036854775807" : String(times)
  kit.sql(`create or replace function public.acceptance_fault() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nextval(tg_argv[0]::regclass) <= tg_argv[1]::bigint then raise exception 'Injected failure: %', tg_argv[2]; end if;
  return new;
end $$;
create sequence public.${name};
create trigger ${name} before insert on public.${table} for each row when (${table === "notifications" ? "(new.payload->>'project_id')" : "new.project_id::text"} = ${kit.q(projectId)})
  execute function public.acceptance_fault('public.${name}', '${limit}', ${kit.q(label)});`, "supabase_admin")
  // How many times the fault fired; read before the sequence is dropped and kept after.
  let firedWhenDisarmed = null
  const fired = () => {
    if (firedWhenDisarmed !== null) return firedWhenDisarmed
    const [row] = kit.rows(`select last_value, is_called from public.${name}`)
    return row.is_called ? (times < 0 ? Number(row.last_value) : Math.min(Number(row.last_value), times)) : 0
  }
  return {
    fired,
    disarm: () => {
      if (firedWhenDisarmed !== null) return
      firedWhenDisarmed = fired()
      kit.sql(`drop trigger if exists ${name} on public.${table}; drop sequence if exists public.${name};
do $$ begin if not exists (select 1 from pg_trigger where tgname like 'acceptance_fault_%') then drop function if exists public.acceptance_fault(); end if; end $$;`, "supabase_admin")
    },
  }
}

/**
 * Holds one transaction open: a BEFORE INSERT trigger on `table` for rows of `projectId`
 * sleeps `seconds` the first time it fires, while that transaction keeps every lock it
 * has taken. Used to force an interleaving rather than hope for one. Returns { fired(), disarm() }.
 */
function armPause(kit, { table, projectId, seconds }) {
  const name = `acceptance_pause_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  kit.sql(`create or replace function public.acceptance_pause() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nextval(tg_argv[0]::regclass) = 1 then perform pg_sleep(tg_argv[1]::double precision); end if;
  return new;
end $$;
create sequence public.${name};
create trigger ${name} before insert on public.${table} for each row when (new.project_id::text = ${kit.q(projectId)})
  execute function public.acceptance_pause('public.${name}', '${Number(seconds)}');`, "supabase_admin")
  let firedWhenDisarmed = null
  const fired = () => {
    if (firedWhenDisarmed !== null) return firedWhenDisarmed
    const [row] = kit.rows(`select is_called from public.${name}`)
    return row.is_called ? 1 : 0
  }
  return {
    fired,
    disarm: () => {
      if (firedWhenDisarmed !== null) return
      firedWhenDisarmed = fired()
      kit.sql(`drop trigger if exists ${name} on public.${table}; drop sequence if exists public.${name};
do $$ begin if not exists (select 1 from pg_trigger where tgname like 'acceptance_pause_%') then drop function if exists public.acceptance_pause(); end if; end $$;`, "supabase_admin")
    },
  }
}

/**
 * Runs `work` with a service client whose transport loses the reply to the first
 * request matching `pattern`: the request reaches the database and commits, and the
 * caller sees the connection drop.
 */
async function withLostReply(kit, pattern, work) {
  const { createClient } = require("@supabase/supabase-js")
  const { runWithServiceSupabaseClient } = require("../../../lib/supabase/service-client-context")
  let dropped = 0
  const transport = async (input, init) => {
    const response = await fetch(input, init)
    if (dropped === 0 && pattern.test(String(input instanceof Request ? input.url : input))) {
      dropped += 1
      await response.arrayBuffer()
      throw new TypeError("fetch failed: connection reset after the request was sent")
    }
    return response
  }
  const client = createClient(kit.apiUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } })
  const result = await runWithServiceSupabaseClient(client, work).then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }))
  return { result, dropped }
}

/** Releases and their notices left behind by a case are settled once its checks are read, so the next case's drain starts clean. */
const settleStartsQueue = (kit, org) => kit.sql(`update public.outbox set status = 'completed' where org_id = ${kit.q(org.orgId)} and status in ('pending','processing','failed') and job_type in (${STARTS_JOBS.map(kit.q).join(",")})`)

async function withDeadlockWatch(kit, work) {
  const before = deadlocks(kit)
  const observed = await work()
  return { observed, deadlocksDuringCase: deadlocks(kit) - before }
}

// ---------------------------------------------------------------------------
// Fixtures

/** A reserved buyer on a fresh lot, the agreement quoted and its creation request ready to send. */
async function quotedSale(kit, org, name) {
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents: 1500000, receivedOn: "2026-06-08" })
  const swing = kit.rows(`select swing from public.lots where id=${kit.q(buyer.lot.id)}`)[0].swing
  const config = seed.configuration(org, { lotId: buyer.lot.id, plan: org.plans[0], swing: swing === "left" ? "left" : "right" })
  const quote = await kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft(config))
  const request = { ...config, ...seed.agreementPacketFor(kit, org, buyer.lot.id), reservationId: buyer.reservation.id, expectedQuoteHash: quote.quoteHash }
  return { buyer, request, create: (actor) => kit.as(actor, () => app("community-sales").createPurchaseAgreement(request)) }
}
const contractOf = (kit, reservationId) => kit.rows(`select c.id, c.status from public.contracts c join public.lot_reservations r on r.contract_id = c.id where r.id=${kit.q(reservationId)}`)[0]
const execute = (kit, org, contractId) => kit.service(() => app("community-sales").executePurchaseAgreementFromEnvelopeExecution({ orgId: org.orgId, contractId, envelopeId: randomUUID() }))

function saleState(kit, org, sale) {
  const { q } = kit
  const one = (text) => kit.rows(text)[0]
  return {
    agreements: Number(one(`select count(*)::int n from public.contracts where org_id=${q(org.orgId)} and project_id=${q(sale.buyer.projectId)} and contract_type='purchase_agreement' and status in ('draft','active')`).n),
    active: Number(one(`select count(*)::int n from public.contracts where org_id=${q(org.orgId)} and project_id=${q(sale.buyer.projectId)} and contract_type='purchase_agreement' and status='active'`).n),
    voided: Number(one(`select count(*)::int n from public.contracts where org_id=${q(org.orgId)} and project_id=${q(sale.buyer.projectId)} and contract_type='purchase_agreement' and status='void'`).n),
    creationReceipts: Number(one(`select count(*)::int n from public.purchase_agreement_creation_receipts where org_id=${q(org.orgId)} and reservation_id=${q(sale.buyer.reservation.id)}`).n),
    liveClosings: Number(one(`select count(*)::int n from public.closings where project_id=${q(sale.buyer.projectId)} and status<>'cancelled'`).n),
    executedEvents: Number(one(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type='purchase_agreement_executed' and payload->>'project_id'=${q(sale.buyer.projectId)}`).n),
    voidedEvents: Number(one(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type='purchase_agreement_voided' and entity_id in (select id from public.contracts where project_id=${q(sale.buyer.projectId)})`).n),
    cancellations: Number(one(`select count(*)::int n from public.purchase_agreement_cancellations where org_id=${q(org.orgId)} and project_id=${q(sale.buyer.projectId)}`).n),
    reservation: one(`select status from public.lot_reservations where id=${q(sale.buyer.reservation.id)}`).status,
    prospect: one(`select status from public.prospects where id=${q(sale.buyer.prospect.id)}`).status,
  }
}

/** A spec home on tranche lot `index` with its start package ready and its inventory adopted. */
async function readySpecHome(kit, org, index) {
  const lot = org.lots[index]
  seed.pinSpecPlan(kit, { lot, plan: org.plans[0] })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, spec: true })
  await fx.adoptInventory(kit, org, gates.projectId, `${seed.EVIDENCE}/ownership`)
  if (gates.ready.status !== "ready") throw Error(`Package for lot ${lot.lot_number} is ${gates.ready.status}, not ready`)
  return { lot, packageId: gates.packageId, projectId: gates.projectId }
}
/** A sold home on tranche lot `index`: reserved, signed, designed, every start gate cleared, inventory adopted. */
async function readySoldHome(kit, org, index, name) {
  const lot = org.lots[index]
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents: 2000000, receivedOn: "2026-06-12", lot })
  const sale = await fx.agreementFor(kit, org, buyer)
  await seed.chooseDesign(kit, org, { projectId: sale.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: lot.id, projectId: sale.projectId })
  await fx.adoptInventory(kit, org, sale.projectId, `${seed.EVIDENCE}/ownership`)
  if (gates.ready.status !== "ready") throw Error(`Package for lot ${lot.lot_number} is ${gates.ready.status}, not ready`)
  return { buyer, contractId: sale.contractId, packageId: gates.packageId, projectId: sale.projectId }
}
const queueRelease = (kit, org, packageId) => kit.as(org.team.starts, () => app("starts").releaseStart(packageId, { scheduledStartDate: seed.isoDay(0), overTargetReason: "RACE-03: week capacity is not under test" }))
const releaseJob = (kit, org, packageId) => kit.rows(`select id, status, retry_count, last_error from public.outbox where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(packageId)} order by id desc limit 1`)[0]
const packageStatus = (kit, packageId) => kit.rows(`select status from public.start_packages where id=${kit.q(packageId)}`)[0].status
/**
 * One attempt of the home's release job, with its backoff skipped (the harness does not
 * wait minutes between attempts). The queue is shared with every org on the stack, so
 * another worker may hold the job: the pass waits for that attempt to finish instead.
 */
async function workerPass(kit, org, packageId) {
  const before = releaseJob(kit, org, packageId)
  for (let i = 0; i < 150; i += 1) {
    const job = releaseJob(kit, org, packageId)
    if (job.status !== before.status || job.retry_count !== before.retry_count) break
    if (job.status === "pending") {
      kit.sql(`update public.outbox set run_at = now() where id=${job.id} and status='pending'`)
      await kit.service(() => app("starts-pipeline").runStartsPipeline())
    } else await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return { job: releaseJob(kit, org, packageId), package: packageStatus(kit, packageId) }
}
function orders(kit, projectId) {
  const [row] = kit.rows(`select count(*)::int n, count(distinct company_id)::int vendors, coalesce(sum(total_cents),0)::bigint cents from public.commitments
    where project_id=${kit.q(projectId)} and commitment_type='purchase_order' and status<>'void'`)
  return { count: row.n, vendors: row.vendors, cents: Number(row.cents) }
}
function releaseConfirmation(kit, org, packageId, projectId) {
  const { q } = kit
  return {
    releasedEvents: Number(kit.rows(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and entity_id=${q(packageId)} and event_type='start.released'`)[0].n),
    notifiedUsers: Number(kit.rows(`select count(distinct user_id)::int n from public.notifications where org_id=${q(org.orgId)} and payload->>'project_id'=${q(projectId)} and notification_type='start_released'`)[0].n),
    duplicateNotifications: Number(kit.rows(`select coalesce(sum(n - 1), 0)::int n from (select count(*) n from public.notifications where org_id=${q(org.orgId)} and payload->>'project_id'=${q(projectId)} and notification_type='start_released' group by user_id) t`)[0].n),
  }
}

/** A home whose order lines are on the books: a draft (or approved) purchase order of two lines, 600.00 and 400.00. */
function orderHome(kit, org, label, status) {
  const { q } = kit
  const projectId = randomUUID(), orderId = randomUUID(), tag = randomUUID().slice(0, 8)
  const costCodeId = Object.values(org.costCodeIds)[0], vendorId = Object.values(org.vendorIds)[0]
  kit.sql(["begin;",
    `insert into public.projects(id,org_id,name,property_type,status) values(${q(projectId)},${q(org.orgId)},${q(`${label} ${tag}`)},'production','active');`,
    `insert into public.budgets(id,org_id,project_id,total_cents) values(gen_random_uuid(),${q(org.orgId)},${q(projectId)},5000000);`,
    `insert into public.commitments(id,org_id,project_id,company_id,title,commitment_type,status,total_cents) values(${q(orderId)},${q(org.orgId)},${q(projectId)},${q(vendorId)},${q(`Framing ${tag}`)},'purchase_order','draft',100000);`,
    `insert into public.commitment_lines(id,org_id,commitment_id,description,quantity,unit,unit_cost_cents,scheduled_value_cents,cost_code_id,sort_order) values(gen_random_uuid(),${q(org.orgId)},${q(orderId)},'Walls',1,'ls',60000,60000,${q(costCodeId)},0),(gen_random_uuid(),${q(org.orgId)},${q(orderId)},'Roof',1,'ls',40000,40000,${q(costCodeId)},1);`,
    status === "approved" ? `update public.commitments set status='approved' where id=${q(orderId)};` : "",
    "commit;"].join("\n"))
  return { projectId, orderId }
}

// ---------------------------------------------------------------------------
// Races

/** One round: two sellers save one reservation's agreement at once, then two signature deliveries execute it at once, then the service redelivers. */
async function savedAndSignedTwice(kit, org, name) {
  const sale = await quotedSale(kit, org, name)
  const created = await Promise.allSettled([sale.create(org.team.sales), sale.create(org.owner)])
  const agreementIds = new Set(created.filter((r) => r.status === "fulfilled").map((r) => r.value.id))
  const afterCreation = saleState(kit, org, sale)
  const contract = contractOf(kit, sale.buyer.reservation.id)
  const executions = settled(await Promise.allSettled([execute(kit, org, contract.id), execute(kit, org, contract.id)]))
  // The signature service's own retry: a delivery after both finished changes nothing.
  const redelivered = outcome(await execute(kit, org, contract.id).then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason })))
  const state = saleState(kit, org, sale)
  return { created, agreementIds, afterCreation, contract, executions, redelivered, state }
}

async function raceTwoAgreementsAndTwoSignatures(kit, expected, check) {
  const org = await orgOf(kit)
  const { observed, deadlocksDuringCase } = await withDeadlockWatch(kit, async () => {
    const rounds = []
    for (let round = 1; round <= expected.inputs.rounds; round += 1) {
      const r = await savedAndSignedTwice(kit, org, `Twice Signed ${round}`)
      rounds.push({
        creations: settled(r.created), oneAgreementReturned: r.agreementIds.size === 1 && [...r.agreementIds][0] === r.contract.id,
        afterCreation: { agreements: r.afterCreation.agreements, creationReceipts: r.afterCreation.creationReceipts },
        anExecutionCompleted: r.executions.includes("done"), redelivered: r.redelivered,
        after: { active: r.state.active, liveClosings: r.state.liveClosings, executedEvents: r.state.executedEvents, reservation: r.state.reservation, prospect: r.state.prospect },
        executions: r.executions,
      })
    }
    return rounds
  })
  check.equal("two sellers saving one reservation's agreement at once save one agreement and both get it back; two signature deliveries at once leave one signed agreement, one closing and one execution event, and a later redelivery changes nothing",
    expected.expected, { rounds: observed.map(({ executions, ...round }) => round), deadlocksDuringCase })
  return { orgId: org.orgId, executions: observed.map((round) => round.executions) }
}

async function duplicateSignatureDeliveryIsQuiet(kit, expected, check) {
  const org = await orgOf(kit)
  const rounds = []
  for (let round = 1; round <= expected.inputs.rounds; round += 1) rounds.push((await savedAndSignedTwice(kit, org, `Quiet Signer ${round}`)).executions)
  check.equal("two signature deliveries at once both return: the second finds the agreement executing or executed and does nothing, rather than failing on the closing's unique index", expected.expected, { rounds })
  return { orgId: org.orgId }
}

async function raceCancellationAgainstSignature(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  const { observed, deadlocksDuringCase } = await withDeadlockWatch(kit, async () => {
    const rounds = []
    for (let round = 1; round <= expected.inputs.rounds; round += 1) {
      const sale = await quotedSale(kit, org, `Undecided Signer ${round}`)
      await sale.create(org.team.sales)
      const contract = contractOf(kit, sale.buyer.reservation.id)
      const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(contract.id))
      const results = await Promise.allSettled([
        kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: contract.id, reason: "Buyer withdrew before signing", depositDisposition: "refund", expectedPlanHash: plan.hash })),
        execute(kit, org, contract.id),
      ])
      const [cancel, signature] = settled(results)
      const s = saleState(kit, org, sale)
      const voidWon = s.voided === 1 && s.active === 0 && s.liveClosings === 0 && s.reservation === "released" && s.cancellations === 1
      const signatureWon = s.active === 1 && s.voided === 0 && s.liveClosings === 1 && s.reservation === "converted" && s.cancellations === 0 && s.executedEvents === 1
      rounds.push({
        serialEquivalent: (voidWon && cancel === "done" && signature !== "done") || (signatureWon && signature === "done" && cancel !== "done"),
        outcomesAreClean: clean(cancel) && clean(signature),
        winner: voidWon ? "cancellation" : signatureWon ? "signature" : "neither",
        state: s,
      })
    }
    return rounds
  })
  check.equal("a buyer's cancellation and the signature completing on one draft agreement: exactly one wins and the other is refused, never a voided agreement with a closing or a signed one with a released lot",
    expected.expected, { rounds: observed.map(({ serialEquivalent, outcomesAreClean }) => ({ serialEquivalent, outcomesAreClean })), deadlocksDuringCase })
  return { orgId: org.orgId, rounds: observed }
}

async function raceCancellationAgainstStartRelease(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  const { observed, deadlocksDuringCase } = await withDeadlockWatch(kit, async () => {
    const rounds = []
    for (let round = 1; round <= expected.inputs.rounds; round += 1) {
      const home = await readySoldHome(kit, org, expected.inputs.firstLot - 1 + round - 1, `Cold Feet ${round}`)
      const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(home.contractId))
      const results = await Promise.allSettled([
        kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: home.contractId, reason: "Buyer cancelled before start", depositDisposition: "refund", expectedPlanHash: plan.hash })),
        queueRelease(kit, org, home.packageId),
      ])
      const [cancel, release] = settled(results)
      const contract = kit.rows(`select status from public.contracts where id=${kit.q(home.contractId)}`)[0].status
      const pkg = packageStatus(kit, home.packageId)
      const jobs = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${kit.q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${kit.q(home.packageId)} and status in ('pending','processing')`)[0].n)
      const releaseWon = contract === "active" && pkg === "releasing" && jobs === 1
      const cancelWon = contract === "void" && !["releasing", "released"].includes(pkg) && jobs === 0
      rounds.push({
        serialEquivalent: (releaseWon && release === "done" && cancel !== "done") || (cancelWon && cancel === "done" && release !== "done"),
        outcomesAreClean: clean(cancel) && clean(release),
        winner: releaseWon ? "release" : cancelWon ? "cancellation" : "neither", contract, package: pkg, releaseJobs: jobs, outcomes: { cancel, release },
      })
      if (pkg === "releasing") await kit.as(org.team.starts, () => app("starts").cancelRelease(home.packageId)).catch(() => null)
      settleStartsQueue(kit, org)
    }
    return rounds
  })
  check.equal("a buyer's cancellation racing the starts desk's release of the same sold home: one wins, the other is refused, and a cancelled sale never leaves a house releasing",
    expected.expected, { rounds: observed.map(({ serialEquivalent, outcomesAreClean }) => ({ serialEquivalent, outcomesAreClean })), deadlocksDuringCase })
  return { orgId: org.orgId, rounds: observed }
}

/**
 * The interleaving the unlocked execution lost to, forced: the cancellation is held open
 * (paused at its receipt, after the agreement is void and while it holds the contract
 * lock) and the signature's execution is delivered inside that window. The execution
 * must wait on the lock, find the agreement void and refuse; the void stands.
 */
async function voidBetweenReadAndWriteStands(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  const { pauseSeconds, deliverAfterMs } = expected.inputs
  const sale = await quotedSale(kit, org, "Held Cancellation")
  await sale.create(org.team.sales)
  const contract = contractOf(kit, sale.buyer.reservation.id)
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(contract.id))
  const pause = armPause(kit, { table: "purchase_agreement_cancellations", projectId: sale.buyer.projectId, seconds: pauseSeconds })
  let observed
  try {
    const cancelling = kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: contract.id, reason: "Buyer withdrew as the signature landed", depositDisposition: "refund", expectedPlanHash: plan.hash }))
      .then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason }))
    await new Promise((resolve) => setTimeout(resolve, deliverAfterMs))
    // The cancellation is inside its transaction now: the agreement is void but not committed.
    const heldOpen = Number(kit.rows(`select count(*)::int n from pg_stat_activity where query ilike '%void_purchase_agreement_atomic%' and state = 'active' and pid <> pg_backend_pid()`)[0].n) > 0
    const executing = execute(kit, org, contract.id).then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const executionWaitedOnTheLock = Number(kit.rows(`select count(*)::int n from pg_stat_activity where query ilike '%execute_purchase_agreement_atomic%' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)[0].n) > 0
    const [cancel, signature] = [outcome(await cancelling), outcome(await executing)]
    const s = saleState(kit, org, sale)
    observed = {
      forced: { cancellationHeldOpen: heldOpen, executionWaitedOnTheLock, pauseFired: pause.fired() },
      outcomes: { cancel, signature },
      after: { active: s.active, voided: s.voided, liveClosings: s.liveClosings, executedEvents: s.executedEvents, cancellations: s.cancellations, reservation: s.reservation },
    }
  } finally { pause.disarm() }
  check.equal("a signature delivered while the cancellation holds the agreement waits for it, finds the agreement void and is refused; the void stands with no closing and no execution", expected.expected, observed)
  return { orgId: org.orgId, projectId: sale.buyer.projectId }
}

/**
 * The same cancellation, serially: the sale is cancelled, then the starts desk releases.
 * What the sale proved is withdrawn with it, the refresh cannot re-prove it from "no
 * agreement in force", and the queue refuses even a package someone left marked ready.
 */
async function cancelledSaleDoesNotStart(kit, expected, check) {
  const org = await orgOf(kit)
  const sales = app("community-sales")
  const { q } = kit
  const home = await readySoldHome(kit, org, expected.inputs.lot - 1, "Second Thoughts")
  const gates = () => Object.fromEntries(kit.rows(`select d.key, g.status from public.start_package_gates g join public.start_gate_definitions d on d.id = g.gate_definition_id
    where g.start_package_id=${q(home.packageId)} and d.auto_source in ('agreement_milestones_clear','selections_locked') order by d.key`).map((row) => [row.key, row.status]))
  const groups = () => Object.fromEntries(kit.rows(`select status, count(*)::int n from public.project_selection_groups where project_id=${q(home.projectId)} group by status`).map((row) => [row.status, row.n]))
  const before = { gates: gates(), lockedGroups: (groups().locked ?? 0) > 0, openGroups: groups().open ?? 0 }
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(home.contractId))
  await kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: home.contractId, reason: "Buyer cancelled before start", depositDisposition: "refund", expectedPlanHash: plan.hash }))
  const afterCancellation = {
    package: packageStatus(kit, home.packageId), gates: gates(), lockedGroups: groups().locked ?? 0,
    audited: Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${q(org.orgId)} and entity_id=${q(home.packageId)} and source='starts.sale_cancelled'`)[0].n),
  }
  const release = outcome(await queueRelease(kit, org, home.packageId).then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason })))
  const afterRelease = { package: packageStatus(kit, home.packageId), gates: gates() }
  // A package left marked ready by anything stale still meets the queue's own check under its lock.
  kit.sql(`update public.start_packages set status='ready' where id=${q(home.packageId)}`)
  const monday = new Date(`${seed.isoDay(0)}T12:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const queued = await kit.service(() => require("../../../lib/supabase/server").createServiceSupabaseClient().rpc("queue_start_release", {
    p_org_id: org.orgId, p_package_id: home.packageId, p_actor_id: org.team.starts.userId, p_scheduled_start_date: seed.isoDay(0),
    p_target_week: monday.toISOString().slice(0, 10), p_slot_target: 10, p_confirm_over_slot: true, p_over_reason: "RACE-03: week capacity is not under test",
  }))
  kit.sql(`update public.start_packages set status='open' where id=${q(home.packageId)}`)
  const releaseJobs = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${q(org.orgId)} and job_type='start_release' and payload->>'start_package_id'=${q(home.packageId)}`)[0].n)
  check.equal("a cancelled sale withdraws what it proved: its financing and selections gates reopen, its selection groups reopen and the package says why; the release is refused, and the queue refuses the home even when its package is marked ready",
    expected.expected, {
      before, afterCancellation, release, afterRelease,
      queueOnAStaleReadyPackage: queued.error ? outcome({ status: "rejected", reason: new Error(queued.error.message) }) : "queued", releaseJobs,
    })
  return { orgId: org.orgId, projectId: home.projectId }
}

async function racePurchaseOrderApprovals(kit, expected, check) {
  const org = await orgOf(kit)
  const commitments = app("commitments")
  const { observed, deadlocksDuringCase } = await withDeadlockWatch(kit, async () => {
    const rounds = []
    for (let round = 1; round <= expected.inputs.rounds; round += 1) {
      const h = orderHome(kit, org, `PO approval ${round}`, "draft")
      const approve = (actor) => kit.as(actor, () => commitments.updateCommitment({ commitmentId: h.orderId, input: { status: "approved", prequal_override_note: "RACE-03: trade prequalification on file offline." } }))
      const results = settled(await Promise.allSettled([approve(org.buyerB), approve(org.buyerC)]))
      const [row] = kit.rows(`select status, total_cents::bigint cents from public.commitments where id=${kit.q(h.orderId)}`)
      rounds.push({
        approvals: results.filter((r) => r === "done").length >= 1, outcomesAreClean: results.every(clean),
        status: row.status, cents: Number(row.cents),
        approvalAudits: Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(h.orderId)} and after_data->>'status'='approved'`)[0].n),
      })
    }
    return rounds
  })
  check.equal("two purchasing managers approving one draft purchase order at once: it is approved once at its own total; the other gets the same approval or a clean refusal", expected.expected, { rounds: observed, deadlocksDuringCase })
  return { orgId: org.orgId }
}

async function raceVarianceOrderApprovals(kit, expected, check) {
  const org = await orgOf(kit)
  const orders = app("commitment-change-orders"), settings = app("purchasing-settings")
  const reasonCodeId = (await kit.as(org.buyerA, () => settings.listVarianceReasonCodes())).find((row) => row.code === expected.inputs.reasonCode).id
  const { observed, deadlocksDuringCase } = await withDeadlockWatch(kit, async () => {
    const rounds = []
    for (let round = 1; round <= expected.inputs.rounds; round += 1) {
      const h = orderHome(kit, org, `VPO approval ${round}`, "approved")
      const vpo = await kit.as(org.buyerA, () => orders.createCommitmentChangeOrder({ input: { commitment_id: h.orderId, reason_code_id: reasonCodeId, title: `Missed blocking ${round}`, lines: [{ description: "Missed blocking", quantity: 1, unit_cost_cents: expected.inputs.vpoCents }] } }))
      const approve = (actor) => kit.as(actor, () => orders.approveCommitmentChangeOrder({ commitmentChangeOrderId: vpo.id }))
      const results = settled(await Promise.allSettled([approve(org.buyerB), approve(org.buyerC)]))
      const [row] = kit.rows(`select status, total_cents::bigint cents from public.commitment_change_orders where id=${kit.q(vpo.id)}`)
      rounds.push({
        approvedOnce: results.filter((r) => r === "done").length === 1, otherRefused: results.filter((r) => r === "refused: changed while reviewing" || r === "refused: already approved").length === 1,
        status: row.status, cents: Number(row.cents),
        approvedVarianceCents: Number(kit.rows(`select coalesce(sum(total_cents),0)::bigint n from public.commitment_change_orders where commitment_id=${kit.q(h.orderId)} and status='approved'`)[0].n),
        approvalEvents: Number(kit.rows(`select count(*)::int n from public.events where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(vpo.id)} and event_type='vpo.approved'`)[0].n),
      })
    }
    return rounds
  })
  check.equal("two approvers deciding one variance order at once: one approval, the order moves by the variance once, one approval event, and the second approver is told the order changed or is already approved", expected.expected, { rounds: observed, deadlocksDuringCase })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// Injected failures

async function injectedFailuresStartToPurchaseOrders(kit, expected, check) {
  const org = await orgOf(kit)
  const home = await readySpecHome(kit, org, expected.inputs.lot - 1)
  const fault = armFault(kit, { table: "commitments", projectId: home.projectId, times: 1, label: "purchase order write" })
  const attempts = []
  try {
    await queueRelease(kit, org, home.packageId)
    // Attempt 1: the plan set is copied into the house's drawings, and with no file storage the plan version has no plan-set PDF.
    attempts.push(await workerPass(kit, org, home.packageId))
    // Storage is back (the harness settles the copy step as releaseHome does); attempt 2 meets the failed purchase-order write.
    kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), error=null, detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)
    attempts.push(await workerPass(kit, org, home.packageId))
    // Attempt 3 runs clean.
    attempts.push(await workerPass(kit, org, home.packageId))
  } finally { fault.disarm() }
  const steps = Object.fromEntries(kit.rows(`select step_key, status from public.start_release_steps where start_package_id=${kit.q(home.packageId)} order by step_key`).map((row) => [row.step_key, row.status]))
  const observed = {
    attempts: attempts.map(({ job, package: pkg }) => ({ job: job.status, retries: job.retry_count, package: pkg })),
    failures: { firstAttemptMetTheMissingPlanSet: /plan-set PDF/i.test(attempts[0].job.last_error ?? ""), purchaseOrderWriteFired: fault.fired() },
    steps,
    purchaseOrders: orders(kit, home.projectId),
    confirmation: releaseConfirmation(kit, org, home.packageId, home.projectId),
  }
  settleStartsQueue(kit, org)
  check.equal("a release that meets missing file storage and then a failed purchase-order write retries to one release with every order written once", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId, lastErrors: attempts.map(({ job }) => job.last_error) }
}

async function retryLimitParksAndRecovers(kit, expected, check) {
  const org = await orgOf(kit)
  const home = await readySpecHome(kit, org, expected.inputs.lot - 1)
  const attempts = []
  const always = armFault(kit, { table: "commitments", projectId: home.projectId, times: -1, label: "purchase order write" })
  try {
    await queueRelease(kit, org, home.packageId)
    kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)
    for (let i = 0; i < expected.inputs.workerPasses; i += 1) attempts.push(await workerPass(kit, org, home.packageId))
  } finally { always.disarm() }
  const parked = {
    attempts: attempts.map(({ job, package: pkg }) => ({ job: job.status, retries: job.retry_count, package: pkg })),
    purchaseOrders: orders(kit, home.projectId),
    failureNotices: Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${kit.q(org.orgId)} and job_type='start_package_notice' and payload->>'start_package_id'=${kit.q(home.packageId)} and payload->>'kind'='release_failed'`)[0].n),
  }
  // The coordinator retries the parked release; the confirmation's notification write fails once on the way.
  const notice = armFault(kit, { table: "notifications", projectId: home.projectId, times: 1, label: "release notification" })
  const recovery = []
  try {
    await kit.as(org.team.starts, () => app("starts").retryRelease(home.packageId))
    kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), error=null, detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${kit.q(home.packageId)} and step_key='drawings'`)
    for (let i = 0; i < expected.inputs.workerPasses && recovery.at(-1)?.job.status !== "completed"; i += 1) recovery.push(await workerPass(kit, org, home.packageId))
  } finally { notice.disarm() }
  const observed = {
    parked,
    recovered: {
      attempts: recovery.map(({ job, package: pkg }) => ({ job: job.status, package: pkg })),
      notificationWriteFired: notice.fired(),
      purchaseOrders: orders(kit, home.projectId),
      confirmation: releaseConfirmation(kit, org, home.packageId, home.projectId),
    },
  }
  settleStartsQueue(kit, org)
  check.equal("a release whose purchase-order write keeps failing stops at three attempts and parks for attention with one failure notice; retried after the fault clears, it releases once with each order written once, and a failed notification write is retried without a second notice", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}

async function injectedFailuresSaleToAgreement(kit, expected, check) {
  const org = await orgOf(kit)
  const sale = await quotedSale(kit, org, "Interrupted Buyer")
  // The agreement commits but its reply is lost; the seller retries.
  const lost = await withLostReply(kit, /\/rpc\/create_purchase_agreement_atomic/, () => sale.create(org.team.sales))
  const retried = await sale.create(org.team.sales)
  const afterCreation = saleState(kit, org, sale)
  const contract = contractOf(kit, sale.buyer.reservation.id)
  // Execution meets a failed closing write after the contract and reservation moved; the signature service redelivers.
  const fault = armFault(kit, { table: "closings", projectId: sale.buyer.projectId, times: 1, label: "closing write" })
  const executions = []
  try {
    for (let i = 0; i < 2; i += 1) executions.push(outcome(await execute(kit, org, contract.id).then(() => ({ status: "fulfilled" }), (reason) => ({ status: "rejected", reason }))))
  } finally { fault.disarm() }
  const after = saleState(kit, org, sale)
  check.equal("a sale whose saved agreement lost its reply, whose signing has no file storage, and whose execution failed once at the closing write ends with one agreement, one receipt, one closing and one execution event",
    expected.expected, {
      creation: {
        firstAttempt: lost.result.status === "fulfilled" ? "done" : "lost reply", repliesDropped: lost.dropped,
        retry: { sameAgreement: retried.id === contract.id, signingWithoutStorage: retried.signing?.documentId === null && Boolean(retried.signing?.reason) },
        agreements: afterCreation.agreements, creationReceipts: afterCreation.creationReceipts,
      },
      execution: { attempts: executions.map((label) => (label.startsWith("error: Purchase agreement execution failed") && /Injected failure/.test(label) ? "failed: injected closing write" : label)), closingWriteFired: fault.fired() },
      after: { active: after.active, agreements: after.agreements, liveClosings: after.liveClosings, executedEvents: after.executedEvents, reservation: after.reservation, prospect: after.prospect, creationReceipts: after.creationReceipts },
    })
  return { orgId: org.orgId, projectId: sale.buyer.projectId }
}

module.exports = {
  id: "RACE-03",
  subcases: {
    "race-two-agreements-and-two-signatures": raceTwoAgreementsAndTwoSignatures,
    "duplicate-signature-delivery-is-quiet": duplicateSignatureDeliveryIsQuiet,
    "race-cancellation-against-signature": raceCancellationAgainstSignature,
    "void-between-read-and-write-stands": voidBetweenReadAndWriteStands,
    "race-cancellation-against-start-release": raceCancellationAgainstStartRelease,
    "cancelled-sale-does-not-start": cancelledSaleDoesNotStart,
    "race-purchase-order-approvals": racePurchaseOrderApprovals,
    "race-variance-order-approvals": raceVarianceOrderApprovals,
    "injected-failures-start-to-purchase-orders": injectedFailuresStartToPurchaseOrders,
    "retry-limit-parks-and-recovers": retryLimitParksAndRecovers,
    "injected-failures-sale-to-agreement": injectedFailuresSaleToAgreement,
  },
  // The fault, lost-reply and outcome harness, reused by CANCEL-01's interrupted cancellations.
  helpers: { armFault, withLostReply, outcome, clean },
}
