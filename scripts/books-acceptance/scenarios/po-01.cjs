// PO-01 — purchase-order generation as purchasing sees it (EP08-06 preview, EP08-07 transactional
// issuance). One production builder with its own price book and homes, so changing agreements here cannot
// move how any LOT-01 home was priced. Every subcase acts through `kit.as`, so permissions and row security
// are the real ones; SQL is used for fixture rows, for the member's direct data-API attempts the database
// must refuse, and for reads that check outcomes.
//
//   po-generation-tables-refuse-data-api-writes   a member cannot forge runs or exception resolutions; the buyer's path still works
//   po-preview-lists-expiring-agreements          the preview names every agreement ending in the window (vendor, date, days)
//   po-regeneration-preserves-progressed-orders   approved orders stay, differences are reported, drafts re-price, nothing is ordered twice
//   po-dismissed-exceptions-stay-dismissed        a dismissed exception is not raised again; one open exception per line
//   po-resolutions-keep-one-budget                three resolutions leave one generated budget equal to the commitments
//   po-zero-price-needs-a-reason                  a $0 manual price is refused without a reason and accepted with one
//   race-po-competing-commits                     two sessions commit one preview: one run, one set of orders
//   race-po-duplicate-resolution                  two sessions resolve one exception: one order, one refusal, no failed run
//   race-po-approval-against-regeneration         an approval and a regeneration at once never orphan an approved order
//   race-po-release-against-resolution            the starts release and a buyer's resolution at once order each line once
//
// Expected values are in expected/PO-01.json.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race, asMember } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const named = (message, table) => {
  if (message === "allowed") return "allowed"
  for (const [label, pattern] of Object.entries(table)) if (pattern.test(message)) return label
  return message
}
const REFUSALS = {
  "already resolved": /already been resolved or dismissed/,
  "preview again": /preview again|changed since the preview/,
  "needs a reason": /zero price needs a note/i,
  "missing permission": /Missing permission/,
  "raw index error": /commitments_generated_po_number_uidx|duplicate key/,
}

// Agreements are organisation-wide: lapsing or voiding one changes how every home is priced, and a home's
// start gates need a clean price check. Each subcase therefore builds its own organisation and home.
async function home(kit) {
  const org = await seed.productionBuilder(kit, { name: `PO-01 purchasing ${randomUUID().slice(0, 8)}` })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  seed.pinSpecPlan(kit, { lot: org.lots[0], plan: org.plans[1] })
  const gates = await seed.clearStartGates(kit, org, { lotId: org.lots[0].id, spec: true, superintendent: false })
  return { kit, org, projectId: gates.projectId, buyer: org.team.purchasing, plan: org.plans[1] }
}

const generation = () => app("po-generation")
const preview = (h, extra = {}) => kit_as(h, () => generation().generatePurchaseOrders({ projectId: h.projectId, mode: "dry_run", ...extra }))
const commit = (h, fingerprint) => kit_as(h, () => generation().generatePurchaseOrders({ projectId: h.projectId, mode: "commit", expectedFingerprint: fingerprint }))
const kit_as = (h, work, actor = h.buyer) => h.kit.as(actor, work)

async function issue(kit, h) {
  const seen = await preview(h)
  return commit(h, seen.inputFingerprint)
}

const agreementOf = (kit, h, vendor) => kit.rows(`select id from public.vendor_price_agreements where org_id=${kit.q(h.org.orgId)} and company_id=${kit.q(h.org.vendorIds[vendor])} and status='active' and source='import' limit 1`)[0].id
const orders = (kit, h) => kit.rows(`select c.id, co.name vendor, c.status, c.total_cents, c.contract_number from public.commitments c join public.companies co on co.id=c.company_id where c.project_id=${kit.q(h.projectId)} and c.commitment_type='purchase_order' and c.metadata->>'source'='po_generation' order by c.contract_number`)

/** The invariants every outcome must satisfy, however sessions interleaved. */
function shape(kit, h) {
  const row = kit.rows(`select
    (select count(*)::int from (select l.metadata->>'source_ref' k from public.commitment_lines l join public.commitments c on c.id=l.commitment_id where c.project_id=${kit.q(h.projectId)} and c.metadata->>'source'='po_generation' and c.status not in ('voided','rejected') group by 1 having count(*)>1) d) duplicate_sources,
    (select count(*)::int from public.commitments c where c.project_id=${kit.q(h.projectId)} and c.metadata->>'source'='po_generation' and not exists (select 1 from public.commitment_lines l where l.commitment_id=c.id)) orders_without_lines,
    (select count(*)::int from public.budgets b where b.project_id=${kit.q(h.projectId)} and b.metadata->>'source'='po_generation') budgets,
    (select coalesce(sum(bl.amount_cents),0)::bigint from public.budget_lines bl join public.budgets b on b.id=bl.budget_id where b.project_id=${kit.q(h.projectId)} and b.metadata->>'source'='po_generation') budget_cents,
    (select coalesce(sum(l.scheduled_value_cents),0)::bigint from public.commitment_lines l join public.commitments c on c.id=l.commitment_id where c.project_id=${kit.q(h.projectId)} and c.metadata->>'source'='po_generation' and c.status not in ('voided','rejected')) committed_cents,
    (select count(*)::int from public.po_generation_runs where project_id=${kit.q(h.projectId)} and status='failed' and error ~ 'already been resolved|duplicate key') failed_for_races`)[0]
  return {
    oneOrderPerSourceLine: Number(row.duplicate_sources) === 0, noOrderWithoutLines: Number(row.orders_without_lines) === 0,
    oneBudget: Number(row.budgets) === 1, budgetEqualsCommitments: Number(row.budget_cents) === Number(row.committed_cents),
    noRunFailedOnARace: Number(row.failed_for_races) === 0,
  }
}

/** A home with two price exceptions: Gulf Concrete's agreement lapsed, Coastal Plumbing's is void. */
async function homeWithExceptions(kit) {
  const h = await home(kit)
  const book = app("price-book")
  await kit_as(h, () => book.setAgreementEnd(agreementOf(kit, h, "Gulf Concrete"), { effective_to: kit.rows("select (current_date - 1)::text d")[0].d, reason: "PO-01 fixture" }))
  await kit_as(h, () => book.voidPriceAgreement(agreementOf(kit, h, "Coastal Plumbing"), { reason: "PO-01 fixture" }))
  const first = await issue(kit, h)
  const open = (await kit_as(h, () => generation().listPoExceptions({ projectId: h.projectId }))).items
  return { ...h, first, open }
}

async function tablesRefuseDataApiWrites(kit, expected, check) {
  const h = await homeWithExceptions(kit), sales = h.org.team.sales
  const exceptionId = h.open[0].id, orgId = h.org.orgId
  const run = (sql) => race(kit, [`${asMember(sales)} ${sql}`]).then((results) => results[0])
  const denied = (result) => (!result.ok && /permission denied|written by the generation service/.test(result.stderr) ? "refused" : result.ok ? "allowed" : result.stderr)
  const before = kit.rows(`select (select count(*)::int from public.po_generation_exceptions where org_id=${kit.q(orgId)}) e, (select count(*)::int from public.po_generation_runs where org_id=${kit.q(orgId)}) r`)[0]
  const forged = {
    resolveException: denied(await run(`update public.po_generation_exceptions set status='resolved_manual', resolution='{"kind":"manual","company_id":"${randomUUID()}","unit_cost_cents":1}' where id='${exceptionId}';`)),
    deleteExceptions: denied(await run(`delete from public.po_generation_exceptions where org_id='${orgId}';`)),
    forgeSucceededRun: denied(await run(`insert into public.po_generation_runs(org_id,project_id,lot_id,house_plan_version_id,mode,status,input_fingerprint) select org_id,project_id,lot_id,house_plan_version_id,'commit','succeeded',repeat('a',64) from public.po_generation_runs where org_id='${orgId}' limit 1;`)),
    rewriteRun: denied(await run(`update public.po_generation_runs set status='failed' where org_id='${orgId}';`)),
  }
  const after = kit.rows(`select (select count(*)::int from public.po_generation_exceptions where org_id=${kit.q(orgId)}) e, (select count(*)::int from public.po_generation_runs where org_id=${kit.q(orgId)}) r, (select status from public.po_generation_exceptions where id=${kit.q(exceptionId)}) s`)[0]
  const memberReads = (await race(kit, [`${asMember(sales)} select count(*) from public.po_generation_exceptions where org_id='${orgId}';`]))[0].ok

  // The legitimate path still works: the purchasing manager resolves the exception through the service.
  const resolved = await kit_as(h, () => generation().resolvePoException(exceptionId, { kind: "manual", company_id: h.org.vendorIds["Gulf Concrete"], unit_cost_cents: 5900000, note: "Spot price while the agreement is renewed." }))
  equal(check, "a member's direct writes to generation runs and exceptions are refused and change nothing, reading still works, and the buyer's resolution still lands", expected.expected, {
    forged, rowsChanged: { exceptions: Number(after.e) - Number(before.e), runs: Number(after.r) - Number(before.r) }, exceptionStillOpen: after.s === "open", memberReads,
    buyerResolved: resolved.status === "resolved_manual",
  })
  return { orgId, projectId: h.projectId }
}

async function previewListsExpiringAgreements(kit, expected, check) {
  const h = await home(kit)
  const book = app("price-book")
  const days = (n) => kit.rows(`select (current_date + ${n})::text d`)[0].d
  await kit_as(h, () => book.setAgreementEnd(agreementOf(kit, h, "Cypress Sitework"), { effective_to: days(10), reason: "PO-01 fixture" }))
  await kit_as(h, () => book.setAgreementEnd(agreementOf(kit, h, "Palmetto Framing"), { effective_to: days(25), reason: "PO-01 fixture" }))
  const seen = await preview(h)
  equal(check, "the preview names each agreement ending inside the lead window with its vendor, end date and days left, soonest first", expected.expected, {
    expiring: seen.expiringAgreements.map((row) => ({ vendor: row.companyName, endsInDays: row.daysRemaining, endDateIsTheAgreementEnd: row.effectiveTo === (row.daysRemaining === 10 ? days(10) : days(25)) })),
    previewWroteNoOrders: orders(kit, h).length === 0,
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function regenerationPreservesProgressedOrders(kit, expected, check) {
  const h = await home(kit)
  const first = await issue(kit, h)
  const before = orders(kit, h)
  const framing = before.find((row) => row.vendor === "Palmetto Framing")
  const other = before.find((row) => row.id !== framing.id)
  // Framing is approved; another vendor's order is complete (no bill yet); the rest stay drafts.
  kit.sql(`update public.commitments set status='approved' where id=${kit.q(framing.id)}; update public.commitments set status='complete' where id=${kit.q(other.id)}`)
  const unitCents = Number(kit.rows(`select unit_cost_cents u from public.vendor_price_agreements where id=${kit.q(agreementOf(kit, h, "Palmetto Framing"))}`)[0].u)
  await kit_as(h, () => app("price-book").repriceAgreement(agreementOf(kit, h, "Palmetto Framing"), { effective_from: kit.rows("select current_date::text d")[0].d, unit_cost_cents: unitCents + 100, reason: "PO-01 price moved" }))
  const seen = await preview(h)
  const second = await commit(h, seen.inputFingerprint)
  const after = orders(kit, h)
  const framingAfter = after.find((row) => row.id === framing.id), otherAfter = after.find((row) => row.id === other.id)
  const reported = (result) => result.preservedChanged.map((change) => change.commitmentId === framing.id)
  equal(check, "the preview and the commit both report the approved order that would now price differently; the approved and the completed order keep their lines and totals, nothing is ordered twice", expected.expected, {
    previewReportsApprovedOrder: reported(seen).length > 0 && reported(seen).every(Boolean),
    commitReportsApprovedOrder: reported(second).length > 0 && reported(second).every(Boolean),
    approvedOrderUntouched: framingAfter.status === "approved" && framingAfter.total_cents === framing.total_cents,
    completedOrderUntouched: otherAfter.status === "complete" && otherAfter.total_cents === other.total_cents,
    orderCountUnchanged: after.length === before.length,
    firstRunWasWhole: first.status === "succeeded",
    ...shape(kit, h),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function dismissedExceptionsStayDismissed(kit, expected, check) {
  const h = await homeWithExceptions(kit)
  const target = h.open[0], others = h.open.slice(1)
  await kit_as(h, () => generation().dismissPoException(target.id, "Builder supplies this item"))
  const seen = await preview(h)
  await commit(h, seen.inputFingerprint)
  const count = (status) => kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(h.projectId)} and status=${kit.q(status)}`)[0].n
  const openFor = (id) => kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(h.projectId)} and status='open' and source_ref=(select source_ref from public.po_generation_exceptions where id=${kit.q(id)})`)[0].n
  equal(check, "a dismissed exception is not raised again by a later preview or commit, and no line has more than one open exception", expected.expected, {
    dismissed: count("dismissed"), reopenedForTheDismissedLine: openFor(target.id), othersStillOpen: others.every((item) => openFor(item.id) === 1),
    maxOpenPerLine: Number(kit.rows(`select coalesce(max(n),0) n from (select count(*) n from public.po_generation_exceptions where project_id=${kit.q(h.projectId)} and status='open' group by source_kind, source_ref) t`)[0].n),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function resolutionsKeepOneBudget(kit, expected, check) {
  const h = await homeWithExceptions(kit)
  const gulf = h.org.vendorIds["Gulf Concrete"]
  for (const item of h.open) {
    await kit_as(h, () => generation().resolvePoException(item.id, { kind: "manual", company_id: gulf, unit_cost_cents: 1000, note: "Manual price from the buyer" }))
  }
  equal(check, "every resolution lands on the same generated budget, whose lines equal the commitments, and leaves no exception open", expected.expected, {
    ...shape(kit, h), openExceptions: kit.rows(`select count(*)::int n from public.po_generation_exceptions where project_id=${kit.q(h.projectId)} and status='open'`)[0].n,
    resolutions: h.open.length,
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function zeroPriceNeedsAReason(kit, expected, check) {
  const h = await homeWithExceptions(kit)
  const gulf = h.org.vendorIds["Gulf Concrete"], target = h.open[0].id
  const resolve = (resolution) => attempt(() => kit_as(h, () => generation().resolvePoException(target, resolution)))
  const noNote = named(await resolve({ kind: "manual", company_id: gulf, unit_cost_cents: 0 }), REFUSALS)
  const shortNote = named(await resolve({ kind: "manual", company_id: gulf, unit_cost_cents: 0, note: "free" }), REFUSALS)
  const stillOpen = kit.rows(`select status from public.po_generation_exceptions where id=${kit.q(target)}`)[0].status
  const withNote = await resolve({ kind: "manual", company_id: gulf, unit_cost_cents: 0, note: "Owner-supplied concrete, no charge" })
  equal(check, "a zero manual price needs a reason of at least ten characters; with one it is accepted and the audit trail carries the note", expected.expected, {
    noNote, shortNote, stillOpenAfterRefusals: stillOpen === "open", withNote,
    noteStored: kit.rows(`select resolution->>'note' n from public.po_generation_exceptions where id=${kit.q(target)}`)[0].n,
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function raceCompetingCommits(kit, expected, check) {
  const h = await home(kit)
  const seen = await preview(h)
  const settled = await Promise.allSettled([commit(h, seen.inputFingerprint), commit(h, seen.inputFingerprint)])
  const runs = new Set(settled.filter((result) => result.status === "fulfilled").map((result) => result.value.runId))
  equal(check, "two sessions committing one preview produce one run and one set of orders; a loser is told the winner's run, never a raw error", expected.expected, {
    fulfilled: settled.filter((result) => result.status === "fulfilled").length, distinctRuns: runs.size,
    refusals: settled.filter((result) => result.status === "rejected").map((result) => named(result.reason.message, REFUSALS)),
    succeededCommitRuns: kit.rows(`select count(*)::int n from public.po_generation_runs where project_id=${kit.q(h.projectId)} and mode='commit' and status in ('succeeded','succeeded_with_exceptions')`)[0].n,
    ...shape(kit, h),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function raceDuplicateResolution(kit, expected, check) {
  const h = await homeWithExceptions(kit)
  const target = h.open[0].id, gulf = h.org.vendorIds["Gulf Concrete"], coastal = h.org.vendorIds["Coastal Plumbing"]
  const resolve = (company) => kit_as(h, () => generation().resolvePoException(target, { kind: "manual", company_id: company, unit_cost_cents: 7000, note: "Competing manual prices" }))
  const settled = await Promise.allSettled([resolve(gulf), resolve(coastal)])
  const key = kit.rows(`select source_ref from public.po_generation_exceptions where id=${kit.q(target)}`)[0].source_ref
  const sourceId = key.takeoff_line_id ?? key.project_selection_id
  equal(check, "two sessions resolving one exception: exactly one wins and orders the line once; the other is told it was already resolved; no run is left failed", expected.expected, {
    winners: settled.filter((result) => result.status === "fulfilled").length,
    losers: settled.filter((result) => result.status === "rejected").map((result) => named(result.reason.message, REFUSALS)),
    linesForTheSource: kit.rows(`select count(*)::int n from public.commitment_lines l join public.commitments c on c.id=l.commitment_id where c.project_id=${kit.q(h.projectId)} and l.metadata->>'source_ref'=${kit.q(sourceId)}`)[0].n,
    exceptionStatus: kit.rows(`select status from public.po_generation_exceptions where id=${kit.q(target)}`)[0].status,
    failedRuns: kit.rows(`select count(*)::int n from public.po_generation_runs where project_id=${kit.q(h.projectId)} and status='failed'`)[0].n,
    ...shape(kit, h),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function raceApprovalAgainstRegeneration(kit, expected, check) {
  const h = await home(kit)
  await issue(kit, h)
  const target = orders(kit, h)[0]
  await kit_as(h, () => app("price-book").repriceAgreement(agreementOf(kit, h, "Palmetto Framing"), { effective_from: kit.rows("select current_date::text d")[0].d, unit_cost_cents: 5100, reason: "PO-01 price moved" }))
  const seen = await preview(h)
  const [regeneration, approval] = await Promise.all([
    commit(h, seen.inputFingerprint).then(() => "regenerated", (error) => named(error.message, REFUSALS)),
    race(kit, [`update public.commitments set status='approved' where id='${target.id}' and status='draft';`]).then((results) => results[0].ok),
  ])
  const approvedOrders = orders(kit, h).filter((row) => row.status === "approved")
  equal(check, "an approval racing a regeneration is serial-equivalent: the approved order, if any, keeps its lines and its price, and no order is orphaned or ordered twice", expected.expected, {
    regeneration, approvalStatementRan: approval,
    everyApprovedOrderHasLines: approvedOrders.every((row) => kit.rows(`select count(*)::int n from public.commitment_lines where commitment_id=${kit.q(row.id)}`)[0].n > 0),
    ...shape(kit, h),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function raceReleaseAgainstResolution(kit, expected, check) {
  const h = await homeWithExceptions(kit)
  const target = h.open[0].id, gulf = h.org.vendorIds["Gulf Concrete"]
  const release = () => generation().generatePurchaseOrdersForStartsRelease({ projectId: h.projectId, orgId: h.org.orgId })
  const settled = await Promise.allSettled([
    kit_as(h, release, h.org.owner),
    kit_as(h, () => generation().resolvePoException(target, { kind: "manual", company_id: gulf, unit_cost_cents: 6200, note: "Manual price during release" })),
  ])
  equal(check, "the starts release and a buyer's resolution racing on one home order every source line once, and neither fails with an index error", expected.expected, {
    outcomes: settled.map((result) => (result.status === "fulfilled" ? "done" : named(result.reason.message, REFUSALS))),
    ...shape(kit, h),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

const subcases = {
  "po-generation-tables-refuse-data-api-writes": tablesRefuseDataApiWrites,
  "po-preview-lists-expiring-agreements": previewListsExpiringAgreements,
  "po-regeneration-preserves-progressed-orders": regenerationPreservesProgressedOrders,
  "po-dismissed-exceptions-stay-dismissed": dismissedExceptionsStayDismissed,
  "po-resolutions-keep-one-budget": resolutionsKeepOneBudget,
  "po-zero-price-needs-a-reason": zeroPriceNeedsAReason,
  "race-po-competing-commits": raceCompetingCommits,
  "race-po-duplicate-resolution": raceDuplicateResolution,
  "race-po-approval-against-regeneration": raceApprovalAgainstRegeneration,
  "race-po-release-against-resolution": raceReleaseAgainstResolution,
}

module.exports = { id: "PO-01", subcases }
