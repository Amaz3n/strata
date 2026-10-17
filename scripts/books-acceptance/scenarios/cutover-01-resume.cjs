// CUTOVER-01 resumable Open-WIP cutover (EP12-02, EP12-03). A platform operator commits house files whose
// budgets and open POs come from companion files, as LOT-01 does; here the commit is interrupted, retried and raced:
//
//   crash-mid-file-resumes-exactly-once       the committing process is killed partway; once its claim lapses the outbox
//                                              resumes after the last receipt, and the homes, budgets and POs reconcile
//   stale-claim-adopts-homes-built-before-receipts
//                                              a batch stuck in 'committing' from before claims existed, holding a whole
//                                              home with no receipt and a half-built one, is reaped and finished: the
//                                              whole home is adopted, the half-built one replaced, nothing doubled
//   failed-batch-retry-adopts-prior-homes     a batch interrupted too often is failed with its homes kept; it cannot be
//                                              discarded, and the operator's retry adopts those homes
//   concurrent-commits-make-one-home          two sessions committing one batch, and two batches naming one lot, leave
//                                              exactly one home on each lot
//   failed-row-leaves-no-parties              a house that fails inside its write takes its buyer and new vendor with it,
//                                              and the batch's earlier home with its own; the fixed retry creates each once
//   finalize-refuses-unreconciled-counts      a home that lost an approved PO between attempts keeps the batch from
//                                              completing, however often it is committed
//   member-cannot-forge-a-commit              a member with import.manage cannot claim, count or receipt a batch through
//                                              the API, and a resumed batch builds nothing for an operator without platform access
//   used-home-is-kept-not-rolled-back         a failing retry never deletes a home an earlier attempt kept, nor a home of its
//                                              own that someone has already used: the batch fails with every home kept
//   rollback-restores-the-lot-as-it-was       a rolled-back home leaves its lot with the status and delivery date it had
//
// The crash is a real one: the commit runs in its own process (cutover-worker.cjs), a separate session holds one lot so
// the process is caught mid-file, and the process is SIGKILLed. SQL writes only what no service writes here: that hold,
// the lapse of a claim, the state an earlier release of the importer left behind, and a lost approval.
const { spawn } = require("node:child_process")
const path = require("node:path")
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const COMMUNITY = "Cypress Landing"
const HOUSE_HEADERS = ["community", "lot_number", "block", "plan_code", "elevation_code", "stage_task", "stage_date", "budget_total_cents", "sold", "buyer_name", "buyer_email", "sale_price_cents", "sale_date"]
const BUDGET_HEADERS = ["community", "lot_number", "cost_code", "budget_cents"]
const PO_HEADERS = ["community", "lot_number", "po_number", "vendor", "cost_code", "description", "remaining_cents", "original_cents"]
const LAND_LOTS = { first: 11, last: 46 }
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

// requireAuth reads the signed-in user from request cookies, which the harness has no request for. The platform
// path asks it who is calling, so it is answered with the actor the harness acts as; the platform permission check
// that follows is the real one, against platform_memberships (as LOT-01's cutover does).
let platformAuthPatched = false
function actAsSignedInUser() {
  if (platformAuthPatched) return
  const auth = require("../../../lib/auth/context")
  const { requireOrgContext } = require("../../../lib/services/context")
  auth.requireAuth = async () => { const context = await requireOrgContext(); return { user: { id: context.userId, email: null } } }
  platformAuthPatched = true
}
const commitAs = (kit, ops, orgId, batchId) => { actAsSignedInUser(); return kit.as(ops, () => app("imports").commitImportBatch(batchId, { platformOrgId: orgId })) }

const ORGS = new WeakMap()
function cutoverOrg(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    actAsSignedInUser()
    const org = await seed.productionBuilder(kit, { name: "CUTOVER-01 open-WIP cutover", lots: 48 })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    // A started house stands on land bought in Books; lots 47 and 48 stay unbought.
    const bought = org.lots.slice(LAND_LOTS.first - 1, LAND_LOTS.last)
    await kit.as(org.owner, () => app("books/inventory").acquireLandInventory({ date: "2026-06-03", allocations: bought.map((row) => ({ lotId: row.id, amountCents: 7200000 })), cashAccountId: seed.glId(kit, org, "1000"), cashCents: 7200000 * bought.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing cutover lots", evidenceUrl: `${seed.EVIDENCE}/cutover-lots` }))
    const ops = kit.addMember(org, "org_viewer")
    kit.sql(`insert into public.platform_memberships(user_id,role_id,status) select ${kit.q(ops.userId)}, id, 'active' from public.roles where key='platform_admin'`)
    return { org, ops }
  })())
  return ORGS.get(kit)
}

/** One house's three files' rows: a three-line budget, `pos` open POs, and the house (sold on even lots). */
function houseFiles(house, asOf, { pos, vendors }) {
  const n = Number(house.lot)
  const budget = [["31-000", 20000 + n * 100], ["03-300", 30000], ["06-100", 40000]].map(([code, dollars]) => ({ community: COMMUNITY, lot_number: house.lot, cost_code: code, budget_cents: String(dollars) }))
  const orders = Array.from({ length: pos }, (_, i) => {
    const trade = seed.TRADES[i % seed.TRADES.length]
    const remaining = 1000 + i * 10
    return { community: COMMUNITY, lot_number: house.lot, po_number: `PO-${asOf}-${house.lot}-${i + 1}`, vendor: vendors?.[i] ?? trade.vendor, cost_code: trade.costCode, description: `Remaining scope ${i + 1}`, remaining_cents: String(remaining), original_cents: String(remaining + 250) }
  })
  const sold = house.sold ?? n % 2 === 0
  const row = { community: COMMUNITY, lot_number: house.lot, block: "", plan_code: "MG1650", elevation_code: "A", stage_task: "Framing", stage_date: "2026-08-20",
    budget_total_cents: String(90000 + n * 100), sold: sold ? "yes" : "no", buyer_name: sold ? `Buyer ${asOf} ${house.lot}` : "",
    buyer_email: sold ? (house.email ?? `cutover.${asOf}.lot${house.lot}@acceptance.example.test`) : "", sale_price_cents: sold ? "400000" : "", sale_date: sold ? "2026-08-15" : "" }
  return { budget, orders, row }
}

/** Stages a cutover's companion files and its house files (each a list of houses) for one as-of date. */
async function stageCutover(kit, { org, ops }, asOf, houseFilesList, options = { pos: 2 }) {
  const stage = (headers, rows, kind) => kit.as(ops, () => app("imports").stageImportBatch({ importer: "open_wip", csvText: seed.csv(headers, rows), sourceFilename: `${kind}-${asOf}.csv`, context: { file_kind: kind, as_of_date: asOf } }, { platformOrgId: org.orgId }))
  const all = [...new Map(houseFilesList.flat().map((house) => [house.lot, house])).values()]
  const files = new Map(all.map((house) => [house.lot, houseFiles(house, asOf, { pos: house.pos ?? options.pos, vendors: house.vendors })]))
  await stage(BUDGET_HEADERS, all.flatMap((house) => files.get(house.lot).budget), "budgets")
  await stage(PO_HEADERS, all.flatMap((house) => files.get(house.lot).orders), "purchase_orders")
  const batches = []
  for (const houses of houseFilesList) {
    const batch = await stage(HOUSE_HEADERS, houses.map((house) => files.get(house.lot).row), "houses")
    if (batch.error_count) throw Error(`House file for ${asOf} did not stage clean: ${JSON.stringify(kit.rows(`select row_number, issues from public.import_rows where batch_id=${kit.q(batch.id)} and status='error'`)).slice(0, 600)}`)
    batches.push(batch)
  }
  return batches
}

const lotIds = (org, lots) => lots.map((lot) => org.lots[Number(lot) - 1].id)
const batchState = (kit, batchId) => {
  const row = kit.rows(`select status, committed_count, committed_at is not null stamped, commit_attempts, commit_claim_token is not null claimed, report from public.import_batches where id=${kit.q(batchId)}`)[0]
  return { status: row.status, committedCount: row.committed_count, stamped: row.stamped, attempts: row.commit_attempts, claimed: row.claimed, report: row.report }
}
const receipts = (kit, batchId) => count(kit, `select 1 from public.import_rows where batch_id=${kit.q(batchId)} and status='committed'`)

/** The cutover's homes, read from the lots: one entry per lot, with how many homes the batch owns there. */
function homesOn(kit, org, lots, batchIds) {
  const owned = `metadata->'wip_cutover'->>'batch_id' in (${batchIds.map(kit.q).join(",")})`
  return lots.map((lot) => {
    const row = kit.rows(`select l.status, l.project_id, (select count(*)::int from public.projects p where p.org_id=l.org_id and p.${owned} and p.name like '% — Lot ' || l.lot_number) homes from public.lots l where l.id=${kit.q(org.lots[Number(lot) - 1].id)}`)[0]
    return { lot, homes: row.homes, attached: row.project_id !== null, lotStatus: row.status }
  })
}

/** Records per house the batch built: approved budgets, approved POs and their cents, schedule items, agreements. */
function records(kit, batchId) {
  const scope = `project_id in (select id from public.projects where metadata->'wip_cutover'->>'batch_id'=${kit.q(batchId)})`
  return {
    homes: count(kit, `select 1 from public.projects where metadata->'wip_cutover'->>'batch_id'=${kit.q(batchId)}`),
    budgets: count(kit, `select 1 from public.budgets where ${scope} and status='approved'`),
    approvedPurchaseOrders: count(kit, `select 1 from public.commitments where ${scope} and commitment_type='purchase_order' and status='approved'`),
    poCents: Number(kit.rows(`select coalesce(sum(total_cents),0)::bigint n from public.commitments where ${scope} and commitment_type='purchase_order'`)[0].n),
    agreements: count(kit, `select 1 from public.contracts where ${scope} and contract_type='purchase_agreement'`),
    scheduledHomes: count(kit, `select distinct project_id from public.schedule_items where ${scope}`),
  }
}
const reconciliation = (state) => {
  const r = state.report.reconciliation
  return r ? { rows: r.rows, receipts: r.receipts, homes: r.homes, budgets: r.budgets, purchaseOrders: r.purchase_orders, clean: r.clean, mismatches: r.mismatches } : null
}

/**
 * Commits `batchId` in its own process and SIGKILLs it while it waits on `holdLot`, which a separate session holds:
 * every house before that lot has its receipt, none after. The write in flight for the held lot may still land.
 */
/** A separate session holds one lot's row, so a commit reaching that lot waits there until it is released. */
async function holdLot(kit, org, lot) {
  const holdName = `cutover-hold-${randomUUID().slice(0, 8)}`
  const holder = spawn("docker", ["exec", "-i", kit.container, "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "ignore", "ignore"] })
  holder.stdin.end(`set application_name='${holdName}'; begin; select id from public.lots where id=${kit.q(lotIds(org, [lot])[0])} for update; select pg_sleep(300); commit;`)
  for (let i = 0; i < 100 && !count(kit, `select 1 from pg_stat_activity where application_name='${holdName}' and query like '%pg_sleep%'`); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  return {
    release: async () => { kit.sql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name='${holdName}'`); if (holder.exitCode === null) await new Promise((resolve) => holder.once("exit", resolve)) },
  }
}
const commitWaitsOnALot = (kit) => count(kit, `select 1 from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type='Lock' and query like '%commit_open_wip_house%'`) > 0

async function killMidFile(kit, { org, ops }, batchId, holdLotNumber) {
  const hold = await holdLot(kit, org, holdLotNumber)
  const worker = spawn(process.execPath, [path.join(__dirname, "..", "cutover-worker.cjs"), "--container", kit.container, "--api-url", kit.apiUrl, "--batch", batchId, "--actor", JSON.stringify(ops)], { stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  worker.stderr.on("data", (chunk) => { stderr += chunk })
  const started = Date.now()
  let blocked = false
  while (!blocked && worker.exitCode === null && Date.now() - started < 240000) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    blocked = commitWaitsOnALot(kit)
  }
  if (!blocked) { await hold.release(); worker.kill("SIGKILL"); throw Error(`The cutover worker never reached lot ${holdLotNumber}: ${stderr.slice(-600)}`) }
  worker.kill("SIGKILL")
  await new Promise((resolve) => (worker.exitCode !== null || worker.signalCode ? resolve() : worker.once("exit", resolve)))
  const atKill = { blocked, status: batchState(kit, batchId).status }
  await hold.release()
  // The write that was waiting on the held lot finishes (or not) on its own; nothing else of the killed attempt runs.
  for (let i = 0; i < 100 && count(kit, `select 1 from pg_stat_activity where pid <> pg_backend_pid() and query like '%commit_open_wip_house%' and state='active'`); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  return { ...atKill, receipts: receipts(kit, batchId) }
}

/** The claim of the killed process lapses (its two-minute lease, without the wait). */
const lapseClaim = (kit, batchId) => kit.sql(`update public.import_batches set commit_lease_expires_at = now() - interval '1 second' where id=${kit.q(batchId)} and status='committing'`)
const reap = (kit) => kit.service(() => app("imports").reapStaleOpenWipCommits())
const resumeJobs = (kit, batchId) => kit.rows(`select status from public.outbox where job_type='import_open_wip_commit' and payload->>'batch_id'=${kit.q(batchId)} order by id`).map((row) => row.status)

async function crashMidFileResumesExactlyOnce(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org } = fixture
  const houses = inputs.lots.map((lot) => ({ lot }))
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [houses], { pos: inputs.posPerHouse })
  const killed = await killMidFile(kit, fixture, batch.id, inputs.holdLot)
  const afterKill = batchState(kit, batch.id)
  lapseClaim(kit, batch.id)
  const reaped = await reap(kit)
  await kit.drainOutbox(org.orgId)
  const after = batchState(kit, batch.id)
  check.equal("a commit killed mid-file holds a prefix of receipts; the outbox resumes it after its claim lapses and builds each remaining home once", expected, {
    atKill: { waitingOnTheHeldLot: killed.blocked, status: killed.status, prefixOnly: killed.receipts >= inputs.lots.indexOf(inputs.holdLot) && killed.receipts < inputs.lots.length, claimed: afterKill.claimed },
    reaper: { resumed: reaped.resumed >= 1 },
    batch: { status: after.status, committedCount: after.committedCount, stamped: after.stamped, attempts: after.attempts, claimed: after.claimed },
    reconciliation: reconciliation(after),
    homes: homesOn(kit, org, inputs.lots, [batch.id]),
    records: records(kit, batch.id),
    buyers: count(kit, `select 1 from public.contacts where org_id=${kit.q(org.orgId)} and email like ${kit.q(`cutover.${inputs.asOf}.%`)}`),
    resumeJobs: resumeJobs(kit, batch.id),
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function staleClaimAdoptsHomesBuiltBeforeReceipts(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org } = fixture
  const [first, second] = inputs.lots
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  // The first house is built and the process dies on the second.
  await killMidFile(kit, fixture, batch.id, second)
  const rows = kit.rows(`select id, parsed->>'lot_number' lot, target_entity_id from public.import_rows where batch_id=${kit.q(batch.id)} order by row_number`)
  const firstHome = rows.find((row) => row.lot === first).target_entity_id
  const secondRow = rows.find((row) => row.lot === second).id
  const orphan = randomUUID()
  // What the importer before receipts-with-homes left on a crash: the first home whole and attached but its row
  // receipt never written, the second home half-built (no lot yet), and the batch 'committing' with no claim.
  kit.sql(`begin;
update public.import_rows set status='valid', target_entity_type=null, target_entity_id=null, action=null where batch_id=${kit.q(batch.id)} and status='committed';
update public.lots set project_id=null, status='developed', house_plan_id=null, house_plan_version_id=null, house_plan_elevation_id=null where id=${kit.q(lotIds(org, [second])[0])} and project_id is not null;
delete from public.projects where metadata->'wip_cutover'->>'batch_id'=${kit.q(batch.id)} and metadata->'wip_cutover'->>'row_id'=${kit.q(secondRow)};
insert into public.projects(id,org_id,name,status,property_type,created_by,metadata) values(${kit.q(orphan)},${kit.q(org.orgId)},${kit.q(`${COMMUNITY} — Lot ${second}`)},'active','production',${kit.q(fixture.ops.userId)},
  jsonb_build_object('imported_open_wip',true,'wip_cutover',jsonb_build_object('as_of_date',${kit.q(inputs.asOf)},'batch_id',${kit.q(batch.id)},'row_id',${kit.q(secondRow)})));
update public.import_batches set status='committing', commit_claim_token=null, commit_lease_expires_at=null, commit_attempts=0 where id=${kit.q(batch.id)};
update public.outbox set status='completed' where job_type='import_open_wip_commit' and payload->>'batch_id'=${kit.q(batch.id)};
commit;`)
  const before = { receipts: receipts(kit, batch.id), homes: records(kit, batch.id).homes, firstAttached: homesOn(kit, org, [first], [batch.id])[0].attached }
  const reaped = await reap(kit)
  await kit.drainOutbox(org.orgId)
  const after = batchState(kit, batch.id)
  const firstAfter = kit.rows(`select project_id from public.lots where id=${kit.q(lotIds(org, [first])[0])}`)[0].project_id
  check.equal("a batch left 'committing' by an earlier release is reaped and finished: the whole home is adopted, the half-built one replaced, the rest built once", expected, {
    before, reaper: { resumed: reaped.resumed >= 1 },
    batch: { status: after.status, committedCount: after.committedCount, attempts: after.attempts },
    reconciliation: reconciliation(after),
    firstHomeAdopted: firstAfter === firstHome,
    halfBuiltHomeRemoved: count(kit, `select 1 from public.projects where id=${kit.q(orphan)}`) === 0,
    homes: homesOn(kit, org, inputs.lots, [batch.id]),
    records: records(kit, batch.id),
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function failedBatchRetryAdoptsPriorHomes(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  await killMidFile(kit, fixture, batch.id, inputs.holdLot)
  // It has been interrupted as often as the reaper allows.
  kit.sql(`update public.import_batches set commit_attempts=${inputs.maxAttempts} where id=${kit.q(batch.id)}`)
  lapseClaim(kit, batch.id)
  const reaped = await reap(kit)
  const failed = batchState(kit, batch.id)
  const kept = { homes: records(kit, batch.id).homes, receipts: receipts(kit, batch.id) }
  const discard = await refusal(() => kit.as(ops, () => app("imports").discardImportBatch(batch.id, { platformOrgId: org.orgId })))
  const retried = await commitAs(kit, ops, org.orgId, batch.id)
  const after = batchState(kit, batch.id)
  check.equal("a batch interrupted too often is failed keeping its homes and receipts, cannot be discarded, and the operator's retry adopts them", expected, {
    reaper: { exhausted: reaped.exhausted >= 1 },
    failed: { status: failed.status, claimed: failed.claimed, keptHomesWithReceipts: kept.receipts > 0 && kept.homes === kept.receipts,
      error: /interrupted 5 times/.test(String(failed.report.commit_error)) ? "interrupted too often" : failed.report.commit_error },
    discard: /commit it again/.test(discard) ? "refused" : discard,
    retry: { status: retried.status, committedCount: retried.committed_count, attempts: after.attempts },
    reconciliation: reconciliation(after),
    homes: homesOn(kit, org, inputs.lots, [batch.id]),
    records: records(kit, batch.id),
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function concurrentCommitsMakeOneHome(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  // One batch, two sessions.
  const [same] = await stageCutover(kit, fixture, inputs.sameBatch.asOf, [inputs.sameBatch.lots.map((lot) => ({ lot }))])
  const both = await Promise.allSettled([commitAs(kit, ops, org.orgId, same.id), commitAs(kit, ops, org.orgId, same.id)])
  // Two batches that both name one lot, committed at once.
  const { contested, xOnly, yOnly } = inputs.sameLot
  const [x, y] = await stageCutover(kit, fixture, inputs.sameLot.asOf, [[{ lot: contested }, { lot: xOnly }], [{ lot: yOnly }, { lot: contested }]])
  const raced = await Promise.allSettled([commitAs(kit, ops, org.orgId, x.id), commitAs(kit, ops, org.orgId, y.id)])
  const states = [batchState(kit, x.id), batchState(kit, y.id)]
  const winner = states[0].status === "committed" ? 0 : 1
  const loser = 1 - winner
  const loserOnly = [xOnly, yOnly][loser]
  const contestedLot = kit.rows(`select project_id from public.lots where id=${kit.q(lotIds(org, [contested])[0])}`)[0].project_id
  check.equal("two sessions committing one batch build each home once; two batches naming one lot leave one home on it and the loser nothing", expected, {
    sameBatch: {
      outcomes: both.map((result) => result.status).sort(),
      refusal: both.filter((result) => result.status === "rejected").map((result) => (/Batch must be staged/.test(result.reason.message) ? "refused" : result.reason.message)),
      homes: homesOn(kit, org, inputs.sameBatch.lots, [same.id]), receipts: receipts(kit, same.id),
    },
    sameLot: {
      outcomes: raced.map((result) => result.status).sort(),
      statuses: states.map((state) => state.status).sort(),
      homesOnContestedLot: count(kit, `select 1 from public.projects where org_id=${kit.q(org.orgId)} and name=${kit.q(`${COMMUNITY} — Lot ${contested}`)}`),
      contestedLotHeldByWinner: contestedLot !== null && kit.rows(`select metadata->'wip_cutover'->>'batch_id' b from public.projects where id=${kit.q(contestedLot)}`)[0].b === [x.id, y.id][winner],
      loser: { homes: records(kit, [x.id, y.id][loser]).homes, receipts: receipts(kit, [x.id, y.id][loser]), committedCount: states[loser].committedCount, exclusiveLotFree: homesOn(kit, org, [loserOnly], [x.id, y.id])[0].attached === false,
        refusal: /already has a project/.test(raced[loser].status === "rejected" ? raced[loser].reason.message : "") ? "lot already has a project" : String(raced[loser].reason?.message) },
      winner: { homes: records(kit, [x.id, y.id][winner]).homes, reconciled: reconciliation(states[winner])?.clean },
    },
  })
  return { orgId: org.orgId, batchIds: [same.id, x.id, y.id] }
}

async function failedRowLeavesNoParties(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const houses = inputs.houses.map((house) => ({ lot: house.lot, sold: true, email: house.buyerEmail, vendors: [house.vendor], pos: 1 }))
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [houses])
  const parties = () => ({
    buyers: inputs.houses.map((house) => count(kit, `select 1 from public.contacts where org_id=${kit.q(org.orgId)} and lower(email)=${kit.q(house.buyerEmail)}`)),
    vendors: inputs.houses.map((house) => count(kit, `select 1 from public.companies where org_id=${kit.q(org.orgId)} and lower(name)=lower(${kit.q(house.vendor)})`)),
  })
  const failure = await refusal(() => commitAs(kit, ops, org.orgId, batch.id))
  const failed = batchState(kit, batch.id)
  const afterFailure = { refusal: /Record the actual land acquisition/.test(failure) ? "land not bought" : failure, status: failed.status, committedCount: failed.committedCount, receipts: receipts(kit, batch.id),
    rolledBack: failed.report.rolled_back, homes: homesOn(kit, org, inputs.houses.map((house) => house.lot), [batch.id]), parties: parties() }
  // The land is bought; the same batch is committed again.
  const unbought = org.lots[Number(inputs.houses[1].lot) - 1]
  await kit.as(org.owner, () => app("books/inventory").acquireLandInventory({ date: "2026-06-03", allocations: [{ lotId: unbought.id, amountCents: 7200000 }], cashAccountId: seed.glId(kit, org, "1000"), cashCents: 7200000, debtInstrumentId: null, debtCents: 0, reference: `Cypress Landing lot ${unbought.lot_number}`, evidenceUrl: `${seed.EVIDENCE}/lot-${unbought.lot_number}` }))
  const retried = await commitAs(kit, ops, org.orgId, batch.id)
  check.equal("a house failing inside its write leaves no buyer, vendor or home behind, nor does the batch's earlier house; the retry creates each party once", expected, {
    afterFailure,
    retry: { status: retried.status, committedCount: retried.committed_count, homes: homesOn(kit, org, inputs.houses.map((house) => house.lot), [batch.id]), parties: parties(), reconciled: reconciliation(batchState(kit, batch.id)).clean },
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function finalizeRefusesUnreconciledCounts(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))], { pos: inputs.posPerHouse })
  await killMidFile(kit, fixture, batch.id, inputs.holdLot)
  // Between attempts one of the first home's purchase orders loses its approval (written past the PO lock, as a lost write would be).
  const firstHome = kit.rows(`select target_entity_id id from public.import_rows where batch_id=${kit.q(batch.id)} and parsed->>'lot_number'=${kit.q(inputs.lots[0])}`)[0].id
  kit.sql(`begin; set local session_replication_role = replica;
update public.commitments set status='draft' where id=(select id from public.commitments where project_id=${kit.q(firstHome)} and commitment_type='purchase_order' order by contract_number limit 1);
commit;`, "supabase_admin")
  lapseClaim(kit, batch.id)
  await reap(kit)
  await kit.drainOutbox(org.orgId)
  const resumed = batchState(kit, batch.id)
  const again = await refusal(() => commitAs(kit, ops, org.orgId, batch.id))
  const after = batchState(kit, batch.id)
  check.equal("a home that no longer matches its source keeps the batch from completing: it is failed with the mismatch named, keeps its homes, and a retry refuses again", expected, {
    resumed: { status: resumed.status, committedCount: resumed.committedCount, stamped: resumed.stamped, receipts: receipts(kit, batch.id) },
    reconciliation: reconciliation(resumed),
    retry: { refusal: /do not reconcile/.test(again) ? "does not reconcile" : again, status: after.status, stamped: after.stamped },
    homes: homesOn(kit, org, inputs.lots, [batch.id]),
  })
  return { orgId: org.orgId, batchId: batch.id }
}

/** Writes as the member's own signed-in API session (row-level security and triggers apply), returning "allowed" or why not. */
async function memberWrite(kit, member, write) {
  const { requireOrgContext } = require("../../../lib/services/context")
  const { error } = await kit.as(member, async () => write((await requireOrgContext()).supabase))
  return error ? (error.code === "42501" ? "refused" : error.message) : "allowed"
}

async function memberCannotForgeACommit(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const member = kit.addMember(org, inputs.memberRole)
  const [committed, staged, resumable] = await stageCutover(kit, fixture, inputs.asOf, [[{ lot: inputs.committedLot }], [{ lot: inputs.stagedLot }], [{ lot: inputs.resumedLot }]])
  await commitAs(kit, ops, org.orgId, committed.id)
  const committedRow = kit.rows(`select id from public.import_rows where batch_id=${kit.q(committed.id)}`)[0].id
  const stagedRow = kit.rows(`select id from public.import_rows where batch_id=${kit.q(staged.id)}`)[0].id
  // The forgery the review proved: the member's batch handed to the reaper as 'committing' under the operator's id.
  const forged = {
    claimForOperator: await memberWrite(kit, member, (db) => db.from("import_batches").update({ status: "committing", commit_lease_expires_at: null, commit_attempts: 0, commit_actor_id: ops.userId }).eq("id", staged.id)),
    insertCommitting: await memberWrite(kit, member, (db) => db.from("import_batches").insert({ org_id: org.orgId, importer: "open_wip", status: "committing", context: { file_kind: "houses", as_of_date: inputs.asOf }, created_by: member.userId, commit_actor_id: ops.userId })),
    clearErrorCount: await memberWrite(kit, member, (db) => db.from("import_batches").update({ error_count: 0, valid_count: 0 }).eq("id", staged.id)),
    stagedRowReceipt: await memberWrite(kit, member, (db) => db.from("import_rows").update({ status: "committed", target_entity_type: "open_wip", target_entity_id: org.orgId }).eq("id", stagedRow)),
    committedRowParsed: await memberWrite(kit, member, (db) => db.from("import_rows").update({ parsed: { lot_number: inputs.resumedLot } }).eq("id", committedRow)),
    committedRowStatus: await memberWrite(kit, member, (db) => db.from("import_rows").update({ status: "valid", target_entity_id: null }).eq("id", committedRow)),
    deleteCommittedBatch: await memberWrite(kit, member, (db) => db.from("import_batches").delete().eq("id", committed.id)),
  }
  // Ordinary staging edits are still the member's.
  const staging = {
    mapping: await memberWrite(kit, member, (db) => db.from("import_batches").update({ update_existing: true }).eq("id", staged.id)),
    stagedRowIssues: await memberWrite(kit, member, (db) => db.from("import_rows").update({ issues: [] }).eq("id", stagedRow)),
  }
  await reap(kit)
  // A batch left 'committing' under an operator who has since lost platform onboarding access is not resumed as them.
  kit.sql(`update public.import_batches set status='committing', commit_claim_token=null, commit_lease_expires_at=null, commit_attempts=1, commit_actor_id=${kit.q(member.userId)} where id=${kit.q(resumable.id)}`)
  await reap(kit)
  await kit.drainOutbox(org.orgId)
  const resumed = batchState(kit, resumable.id)
  check.equal("a member cannot claim, count, receipt or delete an import through the API, staging edits still work, and a resumed batch builds nothing for an operator without platform access", expected, {
    forged,
    staging,
    batches: { staged: batchState(kit, staged.id).status, committed: batchState(kit, committed.id).status, committedRowStillReceipted: receipts(kit, committed.id) === 1, stagedBatchNeverQueued: resumeJobs(kit, staged.id).length === 0 },
    resumedWithoutAccess: { status: resumed.status, error: /no longer holds platform onboarding access/.test(String(resumed.report.commit_error)) ? "operator lost access" : resumed.report.commit_error,
      homes: records(kit, resumable.id).homes, receipts: receipts(kit, resumable.id), resumeJobs: resumeJobs(kit, resumable.id) },
  })
  return { orgId: org.orgId, batchIds: [committed.id, staged.id, resumable.id] }
}

const homeOf = (kit, batchId, lot) => kit.rows(`select target_entity_id id from public.import_rows where batch_id=${kit.q(batchId)} and parsed->>'lot_number'=${kit.q(lot)}`)[0]?.id ?? null
const dailyLogsOn = (kit, projectId) => count(kit, `select 1 from public.daily_logs where project_id=${kit.q(projectId)}`)

async function usedHomeIsKeptNotRolledBack(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const { keptLot: kept, killedAt, usedLot: used, unboughtLot: unbought } = inputs
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  // An earlier attempt built the first homes (the write waiting on the held lot lands once it is released) and was
  // interrupted until the reaper gave up: the batch keeps those homes.
  await killMidFile(kit, fixture, batch.id, killedAt)
  kit.sql(`update public.import_batches set commit_attempts=${inputs.maxAttempts} where id=${kit.q(batch.id)}`)
  lapseClaim(kit, batch.id)
  await reap(kit)
  const keptHome = homeOf(kit, batch.id, kept)
  const log = (projectId) => kit.as(org.owner, () => app("daily-logs").createDailyLog({ input: { project_id: projectId, date: inputs.logDate, summary: "Framing crew on site", weather: "Clear" } }))
  // The site team starts using the kept home.
  await log(keptHome)
  // The operator retries. It builds the next home, and while it waits on the last lot the site team logs on that
  // home too; then the last lot refuses (its land was never bought).
  const hold = await holdLot(kit, org, unbought)
  const retry = refusal(() => commitAs(kit, ops, org.orgId, batch.id))
  const started = Date.now()
  while (!commitWaitsOnALot(kit) && Date.now() - started < 120000) await new Promise((resolve) => setTimeout(resolve, 250))
  const usedHome = homeOf(kit, batch.id, used)
  await log(usedHome)
  await hold.release()
  const failure = await retry
  const after = batchState(kit, batch.id)
  check.equal("a failing retry deletes neither the home an earlier attempt kept nor its own home once someone has used it: the batch fails with every home kept", expected, {
    retry: { refusal: /Record the actual land acquisition/.test(failure) ? "land not bought" : failure, status: after.status, claimed: after.claimed,
      error: /already in use/.test(String(after.report.commit_error)) ? "homes kept: in use" : after.report.commit_error },
    rolledBack: after.report.rolled_back,
    homes: homesOn(kit, org, inputs.lots, [batch.id]),
    receipts: receipts(kit, batch.id),
    dailyLogs: { keptHome: dailyLogsOn(kit, keptHome), usedHome: usedHome ? dailyLogsOn(kit, usedHome) : null },
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function rollbackRestoresTheLotAsItWas(kit, spec, check) {
  const { inputs, expected } = spec
  const fixture = await cutoverOrg(kit)
  const { org, ops } = fixture
  const [first] = inputs.lots
  const [batch] = await stageCutover(kit, fixture, inputs.asOf, [inputs.lots.map((lot) => ({ lot }))])
  const lot = () => kit.rows(`select status, delivered_at, project_id, house_plan_id from public.lots where id=${kit.q(lotIds(org, [first])[0])}`)[0]
  const before = lot()
  const failure = await refusal(() => commitAs(kit, ops, org.orgId, batch.id))
  const after = lot()
  check.equal("a rolled-back home leaves its lot exactly as it was: its status, its delivery date (none), no home and no plan", expected, {
    refusal: /Record the actual land acquisition/.test(failure) ? "land not bought" : failure,
    rolledBack: batchState(kit, batch.id).report.rolled_back,
    before: { status: before.status, delivered: before.delivered_at !== null },
    after: { status: after.status, delivered: after.delivered_at !== null, home: after.project_id !== null, plan: after.house_plan_id !== null },
    unchanged: after.status === before.status && after.delivered_at === before.delivered_at && after.house_plan_id === before.house_plan_id,
  })
  return { orgId: org.orgId, batchId: batch.id }
}

module.exports = {
  subcases: {
    "crash-mid-file-resumes-exactly-once": crashMidFileResumesExactlyOnce,
    "stale-claim-adopts-homes-built-before-receipts": staleClaimAdoptsHomesBuiltBeforeReceipts,
    "failed-batch-retry-adopts-prior-homes": failedBatchRetryAdoptsPriorHomes,
    "concurrent-commits-make-one-home": concurrentCommitsMakeOneHome,
    "failed-row-leaves-no-parties": failedRowLeavesNoParties,
    "finalize-refuses-unreconciled-counts": finalizeRefusesUnreconciledCounts,
    "member-cannot-forge-a-commit": memberCannotForgeACommit,
    "used-home-is-kept-not-rolled-back": usedHomeIsKeptNotRolledBack,
    "rollback-restores-the-lot-as-it-was": rollbackRestoresTheLotAsItWas,
  },
  helpers: { actAsSignedInUser },
}
