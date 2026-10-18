// LOSS-01 — losses are recognized once, in the right unit (B12): a losing
// contract carries a reserve that, with the loss already in its margin, equals
// the reviewed expected loss as the forecast worsens, recovers and completes; one
// contract's profit never offsets another's loss; a re-closed month posts nothing
// twice; and a home the builder owns that is worth less than it cost is written
// down after independent review, never written back up, and sold at its new cost.
const { app, contractJob, project } = require("./shared.cjs")
const { bill, prepareAndReview, addContract, sovLine, billCode, prepareContract, reviewAll, byContract, close } = require("./wip-01.cjs").helpers
const home = require("./home-01.cjs").helpers

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const EVIDENCE = "https://evidence.acceptance.example.test/loss-01"

// Cumulative position on the job as of a month end: the loss reserve (2360), the
// loss already inside the margin (cost less revenue) and the expected total.
function position(kit, job, period, totalLossCents) {
  const end = job.periods[period].periodEnd
  const row = kit.rows(`select
      coalesce(sum(l.credit_cents-l.debit_cents) filter (where a.code='2360'),0)::bigint reserve,
      coalesce(sum(l.debit_cents-l.credit_cents) filter (where a.code='5000'),0)::bigint cost,
      coalesce(sum(l.credit_cents-l.debit_cents) filter (where a.code='4000'),0)::bigint revenue
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(job.orgId)} and e.status in ('posted','reversed') and e.entry_date<=${kit.q(end)}`)[0]
  const reserve = Number(row.reserve), incurred = Math.max(0, Number(row.cost) - Number(row.revenue))
  return { totalLoss: totalLossCents, reserve, incurredLoss: incurred, reservePlusIncurredIsTotal: reserve + incurred === totalLossCents }
}
const provisions = (kit, job) => Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${kit.q(job.orgId)} and source_type='expected_loss_provision'`)[0].n)

// A loss emerges, worsens, partly recovers and completes. Each month the reserve
// plus the loss already recognized equals the reviewed total; recovery releases
// only what is no longer needed; completion leaves no reserve; re-closing a month
// posts nothing again.
async function contractLossLifecycle(kit, expected, check) {
  const input = expected.inputs
  const months = Object.keys(input.months)
  const job = await contractJob(kit, { name: "LOSS-01 lifecycle", contractCents: input.contractCents, retainagePercent: 0, periods: months })
  const positions = {}
  for (const period of months) {
    const month = input.months[period]
    await bill(kit, job, period, month.costCents, `LOSS-${period}`)
    await project(kit, job)
    await prepareAndReview(kit, job, period, { contractCents: input.contractCents, eacCents: month.eacCents })
    await close(kit, job, period)
    positions[period] = position(kit, job, period, Math.max(0, month.eacCents - input.contractCents))
  }
  const last = months.at(-1)
  const before = { provisions: provisions(kit, job), reserve: position(kit, job, last, 0).reserve }
  await kit.as(job.owner, () => app("books/period-close").reopenAccountingPeriod({ periodId: job.periods[last].periodId, reason: "Re-close to confirm the loss reserve does not post twice" }))
  await project(kit, job)
  await prepareAndReview(kit, job, last, { contractCents: input.contractCents, eacCents: input.months[last].eacCents })
  await close(kit, job, last)
  check.equal("reserve plus recognized loss equals the reviewed total every month, and re-closing posts nothing twice", expected.expected, {
    positions,
    recloseAddsNothing: provisions(kit, job) === before.provisions && position(kit, job, last, 0).reserve === before.reserve,
  })
  return { orgId: job.orgId, projectId: job.projectId }
}

// One job, two contracts: the profitable one never absorbs the losing one's reserve.
async function contractsNotNetted(kit, expected, check) {
  const input = expected.inputs
  const job = await contractJob(kit, { name: "LOSS-01 two contracts", contractCents: input.a.contractCents, retainagePercent: 0, periods: [input.period] })
  sovLine(kit, job, job.contractId, job.costCodeId, "Framing")
  const b = addContract(kit, job, { title: "Site work", type: "fixed", cents: input.b.contractCents, code: "31-000", codeName: "Earthwork" })
  await billCode(kit, job, input.period, input.a.costCents, "TWO-A", job.costCodeId)
  await billCode(kit, job, input.period, input.b.costCents, "TWO-B", b.costCodeId)
  await project(kit, job)
  await prepareContract(kit, job, input.period, job.contractId, input.a.contractCents, input.a.eacCents)
  await prepareContract(kit, job, input.period, b.contractId, input.b.contractCents, input.b.eacCents)
  await reviewAll(kit, job, input.period)
  await close(kit, job, input.period)
  const reserve = byContract(kit, job, "2360")
  check.equal("the losing contract carries its own reserve; the profitable one carries none and offsets nothing", expected.expected, {
    reserveOnProfitable: reserve[job.contractId] ?? 0,
    reserveOnLosing: reserve[b.contractId] ?? 0,
    jobLevelNetForecast: input.a.contractCents + input.b.contractCents - input.a.eacCents - input.b.eacCents,
  })
  return { orgId: job.orgId, projectId: job.projectId }
}

// A completed home is written down to net realizable value after independent
// review; a review prepared on a cost that has since changed is refused; a
// recovered outlook writes nothing back; the month closes with the write-down
// tied; and at the sale the write-down is its own component, so the home's
// total cost of sales plus write-down is exactly what it cost.
async function homeImpairment(kit, expected, check) {
  const input = expected.inputs
  const org = await home.builder(kit, "LOSS-01 home impairment", [{ name: "Lot 3 — Cedar plan", priceCents: input.salePriceCents }])
  const lot = org.homes[0]
  const inventory = app("books/inventory")
  await home.landAndStart(kit, org, lot, { date: "2026-06-02", startDate: "2026-06-03", cents: input.landCents })
  await home.bill(kit, org, lot.projectId, "2026-06-10", input.constructionCents)
  await kit.as(org.owner, () => inventory.completeProjectInventory({ projectId: lot.projectId, date: "2026-07-01", evidenceUrl: `${EVIDENCE}/completion` }))
  const review = (asOf, sellingPriceCents) => kit.as(org.owner, () => inventory.proposeInventoryImpairment({ projectId: lot.projectId, asOf, sellingPriceCents,
    costToCompleteCents: input.costToCompleteCents, costToSellCents: input.costToSellCents, evidenceUrl: `${EVIDENCE}/broker-opinion.pdf`, assumptions: "Two comparable resales in Cedar Ridge closed below list; broker opinion of value attached." }))
  const approve = (impairmentId, who = org.reviewer) => kit.as(who, () => inventory.reviewInventoryImpairment({ impairmentId, approve: true }))

  // A review prepared, then a late cost on the home: the review is stale.
  const { id: stale } = await review("2026-07-20", input.reviewPriceCents)
  await home.bill(kit, org, lot.projectId, "2026-07-15", input.lateCostCents, "Final grade")
  const staleApproval = await refusal(() => approve(stale))
  await kit.as(org.reviewer, () => inventory.reviewInventoryImpairment({ impairmentId: stale, approve: false, note: "Cost changed after the review was prepared." }))
  // The current review: the preparer cannot approve it; a second member does.
  const { id } = await review("2026-07-20", input.reviewPriceCents)
  const selfApproval = await refusal(() => approve(id, org.owner))
  await approve(id)
  const row = kit.rows(`select carrying_cents, net_realizable_cents, write_down_cents from public.books_inventory_impairments where id=${kit.q(id)}`)[0]
  const afterWriteDown = home.balances(kit, org, { projectId: lot.projectId, codes: ["1170", "5070"] })
  // The outlook recovers: nothing to write back.
  const recovery = await refusal(() => review("2026-07-25", input.salePriceCents))
  // The month closes with the write-down tied to its review.
  const { closeAccountingPeriod, runBooksCloseChecklist } = app("books/period-close")
  for (const period of ["2026-06", "2026-07"]) await kit.as(org.owner, () => closeAccountingPeriod(org.periods[period].periodId))
  const tieOut = (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2026-07-31"))).find((r) => r.code === "impairment_control")
  // Sold in August at the recovered price.
  await home.settle(kit, org, lot, "2026-08-10")
  const relief = home.reliefByComponent(kit, org, lot.projectId)
  const recognized = home.balances(kit, org, { projectId: lot.projectId, codes: ["5000", "5070"] })
  const augustBlocking = (await kit.as(org.owner, () => runBooksCloseChecklist(org.periods["2026-08"].periodId))).blockingFailures.map((r) => r.code ?? r.label)
  check.equal("the write-down is reviewed, permanent, tied to the ledger, and sold as its own component", expected.expected, {
    staleApproval: /changed since this review was prepared/.test(staleApproval) ? "refused: cost changed since the review was prepared" : staleApproval,
    selfApproval: /someone other than/.test(selfApproval) ? "refused: approved by someone other than the preparer" : selfApproval,
    review: { carrying: Number(row.carrying_cents), netRealizable: Number(row.net_realizable_cents), writeDown: Number(row.write_down_cents) },
    afterWriteDown,
    recovery: /covers its cost/.test(recovery) ? "refused: value covers cost, nothing is written back" : recovery,
    julyClosed: kit.rows(`select status from public.accounting_periods where id=${kit.q(org.periods["2026-07"].periodId)}`)[0].status,
    impairmentControl: { status: tieOut.status, ledger: tieOut.ledgerCents, reviews: tieOut.subledgerCents },
    reliefByComponent: relief,
    totalCostRecognized: recognized["5000"] + recognized["5070"],
    augustBlockingFailures: augustBlocking.filter((code) => /impairment|inventory|homes/.test(code)),
  })
  return { orgId: org.orgId, impairmentId: id }
}

module.exports = {
  subcases: {
    "contract-loss-lifecycle": contractLossLifecycle,
    "contracts-not-netted": contractsNotNetted,
    "home-impairment": homeImpairment,
  },
}
