// BID-01 — the bid and price-book fences, rebid and rescission as a buyer lives them (EP08-03, EP08-05).
// Each subcase acts through real member sessions (kit.as for the services, a `set role authenticated` psql
// session for the data API), so permissions and row-level security are the product's. Expected values are in
// expected/BID-01.json, derived from the inputs below and confirmed by the first run on the acceptance stack.
//
//   bid-and-price-book-writes-are-fenced-at-the-data-api  EP08-03  members forging writes with their own JWT are refused; the services still work
//   rebid-by-a-different-vendor-ends-the-incumbent-on-the-chosen-date  EP08-05  preview, chosen effective date, one resolvable price either side, notices to every bidder
//   rescinding-restores-the-prior-price-and-void-end-need-a-reason  EP08-05  rescind by the purchasing manager restores the incumbent; void and end carry a reason inside the member's division
//   concurrent-awards-for-the-same-scope-leave-one-active-price  EP08-05  two sessions award two packages of one scope and date; exactly one price takes effect
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race, asMember } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const eq = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message.replace(/^Failed to [^:]+: /, "").slice(0, 160) } }

const WORLDS = new WeakMap()
/** A production org of its own: price-book changes are organisation-wide and must not move how LOT-01 homes were priced. */
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "BID-01 price book" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    const divisionB = await kit.as(org.owner, () => app("divisions").createDivision({ name: "Atlantic", code: "AT", region: "Treasure Coast" }))
    const limited = (divisionId) => {
      const actor = kit.addMember(org, "org_purchasing_manager")
      kit.sql(`update public.memberships set division_scope='assigned' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};
insert into public.membership_divisions(membership_id, division_id) select id, ${kit.q(divisionId)} from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};`)
      return actor
    }
    return { org, plan: org.plans[0], communityA: org.communityId, divisionA: org.divisionId, divisionB: divisionB.id, buyerA: limited(org.divisionId), buyerB: limited(divisionB.id) }
  })())
  return WORLDS.get(kit)
}

/** A package on the community and plan with one priced unit line, invited bidders and their bids. */
async function pricedPackage(kit, w, { title, bidders }) {
  const bids = app("bids"), buyer = w.org.team.purchasing, costCode = w.org.costCodeIds["06-100"]
  const pkg = await kit.as(buyer, () => bids.createBidPackage({ input: { community_id: w.communityA, house_plan_id: w.plan.id, title, trade: "Framing", due_at: new Date(Date.now() + 14 * 86_400_000).toISOString() } }))
  const scope = await kit.as(buyer, () => bids.saveBidScopeItems({ input: { bid_package_id: pkg.id, items: [{ item_type: "base", description: "Frame the shell", quantity: 1000, unit: "sf", cost_code_id: costCode }] } }))
  await kit.as(buyer, () => bids.updateBidPackage({ bidPackageId: pkg.id, input: { status: "open" } }))
  const submissions = {}
  for (const bidder of bidders) {
    await kit.as(buyer, () => bids.createBidInvite({ input: { bid_package_id: pkg.id, company_id: w.org.vendorIds[bidder.vendor], invite_email: bidder.email, status: "sent" } }))
    submissions[bidder.vendor] = await kit.as(buyer, () => bids.createManualBidSubmission({ input: { bid_package_id: pkg.id, company_id: w.org.vendorIds[bidder.vendor], total_cents: bidder.amountCents,
      items: scope.map((item) => ({ bid_scope_item_id: item.id, description: item.description, response: "priced", amount_cents: bidder.amountCents, quantity: 1000 })) } }))
  }
  return { pkg, submissions }
}

const award = (kit, w, submissionId, extra = {}) => kit.as(w.org.team.purchasing, () => app("bids").awardBidSubmission({ input: { bid_submission_id: submissionId, reviewed_scope: "Frame the shell", reviewed_terms: "Net 30", readiness_exception: "Acceptance vendor: no compliance documents on file.", ...extra } }))
const agreement = (kit, id) => kit.rows(`select status, unit_cost_cents::int cents, effective_from::text effective_from, effective_to::text effective_to, superseded_by_id, source, source_bid_award_id from public.vendor_price_agreements where id=${kit.q(id)}`)[0]
const vendorName = (w, companyId) => Object.entries(w.org.vendorIds).find(([, id]) => id === companyId)?.[0] ?? "unknown"
const resolved = async (kit, w, asOfDate) => {
  const result = await kit.as(w.org.team.purchasing, () => app("price-book").resolvePriceForLine({ costCodeId: w.org.costCodeIds["06-100"], uom: "sf", quantity: 1, communityId: w.communityA, housePlanId: w.plan.id, divisionId: w.divisionA, asOfDate }))
  return result.resolved ? { vendor: vendorName(w, result.resolved.companyId), cents: result.resolved.unitCostCents } : result.exception.reason
}

/** One statement in a member's own session. Landing rows would raise, so nothing a refusal test tries can persist. */
function dataApi(kit, actor, statement) {
  const guarded = `do $$ declare n integer; begin ${statement}; get diagnostics n = row_count; if n > 0 then raise exception 'LANDED %', n; end if; end $$;`
  try { kit.sql(`${asMember(actor)}\n${guarded}`); return "no rows touched" } catch (error) {
    const line = /ERROR:\s+([^\n]+)/.exec(error.message)?.[1].trim() ?? error.message
    return /^LANDED/.test(line) ? "landed" : line.slice(0, 160)
  }
}

// ---------------------------------------------------------------------------
// EP08-03

async function writesAreFencedAtTheDataApi(kit, expected, check) {
  const w = await world(kit), { org } = w, q = kit.q
  const sales = org.team.sales, buyer = org.team.purchasing, owner = org.owner
  const bidder = { vendor: "Palmetto Framing", email: "palmetto@bid01.example.test", amountCents: 5_000_000 }
  const { pkg, submissions } = await pricedPackage(kit, w, { title: "BID-01 fence", bidders: [bidder] })
  const otherPkg = await kit.as(buyer, () => app("bids").createBidPackage({ input: { community_id: w.communityA, title: "BID-01 other" } }))
  const tryAs = (actor, statement) => dataApi(kit, actor, statement)
  const agreementInsert = (extra = {}) => {
    const columns = { org_id: q(org.orgId), company_id: q(org.vendorIds["Gulf Concrete"]), cost_code_id: q(org.costCodeIds["06-100"]), pricing_kind: "'unit'", uom: "'sf'", unit_cost_cents: "1", status: "'active'", effective_from: "current_date", ...extra }
    return `insert into public.vendor_price_agreements(${Object.keys(columns).join(",")}) values(${Object.values(columns).join(",")})`
  }

  const open = {
    salesRenamesPackage: tryAs(sales, `update public.bid_packages set title='Forged' where id=${q(pkg.id)}`),
    salesAddsScopeLine: tryAs(sales, `insert into public.bid_scope_items(org_id,bid_package_id,description) values(${q(org.orgId)},${q(pkg.id)},'Planted')`),
    salesAddsAgreement: tryAs(sales, agreementInsert()),
    buyerRenamesPackage: tryAs(buyer, `update public.bid_packages set title='Renamed by the buyer' where id=${q(pkg.id)}`),
    buyerAddsOrgWideAgreement: tryAs(buyer, agreementInsert()),
    gulfBuyerAddsOrgWideAgreement: tryAs(w.buyerA, agreementInsert()),
    gulfBuyerAddsOwnCommunityAgreement: tryAs(w.buyerA, agreementInsert({ community_id: q(w.communityA) })),
    atlanticBuyerAddsGulfCommunityAgreement: tryAs(w.buyerB, agreementInsert({ community_id: q(w.communityA) })),
    buyerPlantsAwardSourcedAgreement: tryAs(buyer, agreementInsert({ source: "'bid_award'" })),
  }
  const awarded = await award(kit, w, submissions["Palmetto Framing"].id)
  const minted = awarded.agreementIds[0]
  const after = {
    ownerStampsAwardRescinded: tryAs(owner, `update public.bid_awards set rescinded_at=now() where id=${q(awarded.awardId)}`),
    ownerReopensAwardedPackage: tryAs(owner, `update public.bid_packages set status='open' where id=${q(pkg.id)}`),
    ownerClearsAwardedPackagePlan: tryAs(owner, `update public.bid_packages set house_plan_id=null where id=${q(pkg.id)}`),
    ownerRetargetsPackage: tryAs(owner, `update public.bid_packages set award_target='commitment' where id=${q(pkg.id)}`),
    ownerMovesInviteToAnotherPackage: tryAs(owner, `update public.bid_invites set bid_package_id=${q(otherPkg.id)} where bid_package_id=${q(pkg.id)}`),
    ownerVoidsAgreementDirectly: tryAs(owner, `update public.vendor_price_agreements set status='void' where id=${q(minted)}`),
  }
  const stateAfterForgery = agreement(kit, minted)
  const voidWithoutReason = await attempt(() => kit.as(buyer, () => app("price-book").voidPriceAgreement(minted, { reason: "" }))).then((outcome) => /Say why/.test(outcome) ? "refused: reason required" : outcome)
  const voided = await kit.as(buyer, () => app("price-book").voidPriceAgreement(minted, { reason: "Vendor withdrew the quote" }))
  const trail = kit.rows(`select count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type='price_agreement.voided' and entity_id=${q(minted)}`)[0].n
  eq(check, "forged data-API writes on bid packages, scope lines, awards, invites and price agreements are refused or touch nothing, and what a buyer may write lands", expected.expected.dataApi, { beforeAward: open, afterAward: after })
  eq(check, "the award stays active after the forgeries, and the reasoned void through the service works and leaves an event", expected.expected.service, { statusAfterForgery: stateAfterForgery.status, voidWithoutReason, voidedStatus: voided.agreement.status, voidedAffectedOrders: voided.affectedPoCount, voidEvents: trail })
  return { orgId: org.orgId, packageId: pkg.id }
}

// ---------------------------------------------------------------------------
// EP08-05

const REBID = new WeakMap()
async function rebid(kit) {
  if (REBID.has(kit)) return REBID.get(kit)
  const work = (async () => {
    const w = await world(kit), buyer = w.org.team.purchasing
    const incumbentPkg = await pricedPackage(kit, w, { title: "BID-01 incumbent", bidders: [{ vendor: "Palmetto Framing", email: "palmetto@bid01.example.test", amountCents: 5_000_000 }] })
    const incumbentAward = await award(kit, w, incumbentPkg.submissions["Palmetto Framing"].id)
    // A contract with an end date is what makes it a renewal.
    await kit.as(buyer, () => app("price-book").setAgreementEnd(incumbentAward.agreementIds[0], { effective_to: day(60), reason: "Annual framing contract" }))
    const replacement = await pricedPackage(kit, w, { title: "BID-01 rebid", bidders: [
      { vendor: "Gulf Concrete", email: "gulf@bid01.example.test", amountCents: 4_500_000 },
      { vendor: "Palmetto Framing", email: "palmetto@bid01.example.test", amountCents: 4_800_000 },
    ] })
    const start = day(10)
    const preview = await kit.as(buyer, () => app("bids").previewPriceBookAward({ input: { bid_submission_id: replacement.submissions["Gulf Concrete"].id, effective_from: start } }))
    const pastDate = await attempt(() => award(kit, w, replacement.submissions["Gulf Concrete"].id, { effective_from: day(-1) }))
    const renewal = await kit.as(buyer, () => app("price-book").getRenewalCandidates({ windowDays: 365 }))
    const awarded = await award(kit, w, replacement.submissions["Gulf Concrete"].id, { effective_from: start })
    return { w, incumbentAward, incumbentId: incumbentAward.agreementIds[0], replacement, preview, pastDate, renewal, awarded, mintedId: awarded.agreementIds[0], start }
  })()
  REBID.set(kit, work)
  return work
}

async function rebidByADifferentVendorEndsTheIncumbent(kit, expected, check) {
  const r = await rebid(kit), { w } = r, q = kit.q
  const incumbent = agreement(kit, r.incumbentId), minted = agreement(kit, r.mintedId)
  const notices = kit.rows(`select payload->>'outcome' outcome, payload->>'to' recipient from public.outbox where org_id=${q(w.org.orgId)} and job_type='send_bid_email' and payload->>'kind'='award_notice' and payload->>'bidPackageId'=${q(r.replacement.pkg.id)} order by 1`)
  const own = r.renewal.rows.find((row) => row.agreement.id === r.incumbentId)
  eq(check, "the award sheet's preview lists the incumbent it replaces with the change and the day it ends", expected.expected.preview, r.preview.map((line) => line.replaces.map((replaced) => ({ vendor: replaced.vendorName, wasCents: replaced.price.cents, nowCents: line.price.cents, deltaPct: replaced.deltaPct, endsOn: replaced.endsOn === day(9) ? "day before the chosen date" : replaced.endsOn }))))
  eq(check, "an effective date in the past is refused before anything is minted", expected.expected.pastDate, { refusal: /today up to a year ahead/.test(r.pastDate) ? "refused: effective date" : r.pastDate })
  eq(check, "the renewal view lists the expiring incumbent beside the replacement bids with the lowest and its change", expected.expected.renewal, own ? { bids: own.bids.length, lowest: own.bids.find((bid) => bid.submissionId === own.bestBidSubmissionId)?.companyName ?? null } : "missing")
  eq(check, "the incumbent keeps pricing until the day before the chosen date and the new vendor takes over on it, with exactly one resolvable price on each side", expected.expected.handover, {
    incumbent: { status: incumbent.status, endsDayBeforeStart: incumbent.effective_to === day(9), replacedByMinted: incumbent.superseded_by_id === r.mintedId },
    minted: { status: minted.status, startsOnChosenDate: minted.effective_from === r.start, cents: minted.cents, fromAward: minted.source_bid_award_id === r.awarded.awardId },
    today: await resolved(kit, w, day(0)), dayBeforeStart: await resolved(kit, w, day(9)), onStart: await resolved(kit, w, day(10)),
  })
  eq(check, "the winner and the other bidder are each told the result", expected.expected.notices, notices.map((row) => ({ outcome: row.outcome, recipient: row.recipient })))
  return { orgId: w.org.orgId, awardId: r.awarded.awardId }
}

async function rescindingRestoresThePriorPrice(kit, expected, check) {
  const r = await rebid(kit), { w } = r, buyer = w.org.team.purchasing, q = kit.q
  const bids = app("bids"), book = app("price-book")
  const refusals = {
    salesConsultant: await attempt(() => kit.as(w.org.team.sales, () => bids.rescindBidAward({ input: { bid_package_id: r.replacement.pkg.id, reason: "Not allowed" } }))),
    noReason: await attempt(() => kit.as(buyer, () => bids.rescindBidAward({ input: { bid_package_id: r.replacement.pkg.id, reason: " " } }))),
  }
  const rescinded = await kit.as(buyer, () => bids.rescindBidAward({ input: { bid_package_id: r.replacement.pkg.id, reason: "Gulf Concrete withdrew its quote" } }))
  const incumbent = agreement(kit, r.incumbentId), minted = agreement(kit, r.mintedId)
  const packageStatus = kit.rows(`select status from public.bid_packages where id=${q(r.replacement.pkg.id)}`)[0].status
  const reAward = await award(kit, w, r.replacement.submissions["Palmetto Framing"].id, { effective_from: day(10) })
  const rescindedAgain = await kit.as(buyer, () => bids.rescindBidAward({ input: { bid_package_id: r.replacement.pkg.id, reason: "Second thoughts" } }))

  const noReason = await attempt(() => kit.as(buyer, () => book.setAgreementEnd(r.incumbentId, { effective_to: day(200), reason: "" })))
  const outsideDivision = await attempt(() => kit.as(w.buyerB, () => book.setAgreementEnd(r.incumbentId, { effective_to: day(200), reason: "Not my division" })))
  const ended = await kit.as(w.buyerA, () => book.setAgreementEnd(r.incumbentId, { effective_to: day(200), reason: "Seasonal contract ends" }))
  const voidOnVoid = await attempt(() => kit.as(buyer, () => book.voidPriceAgreement(r.mintedId, { reason: "Already void" })))
  const endedRow = agreement(kit, r.incumbentId)
  const trail = kit.rows(`select metadata->'state_change'->>'reason' reason from public.vendor_price_agreements where id=${q(r.incumbentId)}`)[0].reason
  eq(check, "a sales consultant and a blank reason cannot rescind", expected.expected.rescindRefusals, { salesConsultant: /Missing permission/.test(refusals.salesConsultant) ? "refused: missing permission" : refusals.salesConsultant, noReason: /Say why/.test(refusals.noReason) ? "refused: reason required" : refusals.noReason })
  eq(check, "the purchasing manager's rescind voids the minted price, restores the incumbent with its original end date and reopens the package", expected.expected.rescind, {
    voided: rescinded.voidedAgreementCount, restored: rescinded.restoredAgreementCount, skipped: rescinded.skippedAgreementCount, affectedOrders: rescinded.affectedPoCount,
    minted: minted.status, incumbent: { status: incumbent.status, endsOnItsOriginalDate: incumbent.effective_to === day(60), replacedBy: incumbent.superseded_by_id }, packageStatus,
    priceTomorrow: await resolved(kit, w, day(1)),
  })
  eq(check, "the package re-awards after the rescind and rescinds again", expected.expected.reAward, { agreements: reAward.agreementIds.length, restoredOnSecondRescind: rescindedAgain.restoredAgreementCount })
  eq(check, "ending an agreement needs a reason and a member inside its division, and records why", expected.expected.end, {
    noReason: /Say why/.test(noReason) ? "refused: reason required" : noReason,
    otherDivisionBuyer: /outside your divisions|not found/.test(outsideDivision) ? "refused: outside division" : outsideDivision,
    divisionBuyerEndsIt: { status: ended.agreement.status, endsOn: ended.agreement.effective_to === day(200), recordedEndedOn: endedRow.effective_to === day(200), reason: trail },
    voidingAVoidRow: /Only draft or active/.test(voidOnVoid) ? "refused: not active" : voidOnVoid,
  })
  return { orgId: w.org.orgId }
}

async function concurrentAwardsLeaveOneActivePrice(kit, expected, check) {
  const w = await world(kit), q = kit.q, costCode = w.org.costCodeIds["06-100"]
  const a = await pricedPackage(kit, w, { title: "BID-01 race A", bidders: [{ vendor: "Gulf Concrete", email: "gulf@bid01.example.test", amountCents: 4_000_000 }] })
  const b = await pricedPackage(kit, w, { title: "BID-01 race B", bidders: [{ vendor: "Palmetto Framing", email: "palmetto@bid01.example.test", amountCents: 3_900_000 }] })
  const call = (submissionId) => `set role service_role; select public.run_bid_award_price_agreements(${q(w.org.orgId)}, ${q(submissionId)}, null, 'Reviewed scope: race', '{}', ${q(day(30))});`
  const results = await race(kit, [call(a.submissions["Gulf Concrete"].id), call(b.submissions["Palmetto Framing"].id)])
  const scope = `org_id=${q(w.org.orgId)} and cost_code_id=${q(costCode)} and community_id=${q(w.communityA)} and house_plan_id=${q(w.plan.id)} and effective_from=${q(day(30))} and status='active' and source='bid_award' and source_bid_award_id in (select id from public.bid_awards where bid_package_id in (${q(a.pkg.id)}, ${q(b.pkg.id)}))`
  const active = kit.rows(`select count(*)::int n from public.vendor_price_agreements where ${scope}`)[0].n
  const superseded = kit.rows(`select count(*)::int n from public.vendor_price_agreements where org_id=${q(w.org.orgId)} and cost_code_id=${q(costCode)} and source='bid_award' and status='superseded' and effective_from=${q(day(30))} and source_bid_award_id in (select id from public.bid_awards where bid_package_id in (${q(a.pkg.id)}, ${q(b.pkg.id)}))`)[0].n
  eq(check, "two sessions awarding two packages of one scope both succeed and leave exactly one price taking effect on the chosen date, the other superseded outright", expected.expected, { bothSucceeded: results.every((result) => result.ok), activeFromTheDate: active, supersededOutright: superseded })
  return { orgId: w.org.orgId }
}

module.exports = {
  id: "BID-01",
  subcases: {
    "bid-and-price-book-writes-are-fenced-at-the-data-api": writesAreFencedAtTheDataApi,
    "rebid-by-a-different-vendor-ends-the-incumbent-on-the-chosen-date": rebidByADifferentVendorEndsTheIncumbent,
    "rescinding-restores-the-prior-price-and-void-end-need-a-reason": rescindingRestoresThePriorPrice,
    "concurrent-awards-for-the-same-scope-leave-one-active-price": concurrentAwardsLeaveOneActivePrice,
  },
}
