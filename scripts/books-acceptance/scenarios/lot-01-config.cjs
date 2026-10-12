// LOT-01 workflow proof: config (EP03-02, EP03-03, EP03-07, EP04-05, EP04-07, EP06-03).
// Every subcase acts as the role that owns the step through the real services. They run in
// ONE dedicated organisation (built lazily below) rather than the shared LOT-01 chain, because
// they turn the configuration-rules flag on, author rules and overrides, and bend lots, and none
// of that may leak into the other areas' organisation.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")
const lot = () => require("./lot-01.cjs").helpers

const FLAG = "production_configuration_rules"
const refusal = (work) => lot().refusal(work)
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const rowsOf = (kit, sql) => kit.rows(sql)
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)
const q = (kit, value) => kit.q(value)

// ---------------------------------------------------------------------------
// The organisation: a production builder with its community, plans and option catalog.

const ORGS = new WeakMap()
function configOrg(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "LOT-01 configuration" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    // A second community, so an option can be scoped somewhere the first community is not.
    const other = await kit.as(org.owner, () => app("communities").createCommunity({ name: "Heron Reserve", code: "HRN", divisionId: org.divisionId, status: "active", city: "Naples", state: "FL", postalCode: "34119", plannedLotCount: 4, targetAbsorptionPerMonth: 1 }))
    org.otherCommunityId = other.id
    await takeDownSecondTranche(kit, org)
    org.uses = { next: 0 }
    return org
  })())
  return ORGS.get(kit)
}

/** The next unused owned, developed lot (both tranches, 20 lots), so subcases never share a home's lot. */
function nextLot(org) {
  if (org.uses.next > 19) throw Error("Out of developed lots")
  return org.lots[org.uses.next++]
}
/** One lot kept for quotes that never reserve it. */
const quoteLot = (org) => (org.quoteLot ??= nextLot(org))

/** The second land tranche, the way the first is taken down: land bought in Books, the takedown closed, the lots developed. */
async function takeDownSecondTranche(kit, org, date = "2026-06-03") {
  const communities = app("communities"), lotsService = app("lots"), inventory = app("books/inventory")
  const tranche = org.lots.slice(10, 20)
  const takedown = await kit.as(org.team.land, () => communities.createLotTakedown(org.communityId, { name: "Tranche 2", communityPhaseId: org.phaseIds[1], scheduledDate: date, lotCount: 10, pricePerLotCents: 7200000 }))
  await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: tranche.map((row) => row.id), patch: { takedownId: takedown.id } }))
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date, allocations: tranche.map((row) => ({ lotId: row.id, amountCents: 7200000 })), cashAccountId: seed.glId(kit, org, "1000"), cashCents: 7200000 * tranche.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing tranche 2", evidenceUrl: `${seed.EVIDENCE}/tranche-2` }))
  await kit.as(org.team.land, () => communities.closeLotTakedown(takedown.id, { actualDate: date }))
  await kit.as(org.team.land, () => lotsService.bulkUpdateLots(org.communityId, { lotIds: tranche.map((row) => row.id), patch: { status: "developed" } }))
}

const setFlag = (kit, org, enabled) => kit.sql(`insert into public.feature_flags(org_id, flag_key, enabled) values(${q(kit, org.orgId)}, '${FLAG}', ${enabled}) on conflict (org_id, flag_key) do update set enabled=excluded.enabled`)
const rulesIn = (kit, org) => count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)}`)
const clearRules = (kit, org) => kit.sql(`delete from public.selection_configuration_rules where org_id=${q(kit, org.orgId)}`)

const rules = () => app("configuration-rules")
const catalog = () => app("option-catalog")

/** A design-studio option in a category, created by the design coordinator. */
async function makeOption(kit, org, name, { category = "Kitchen", priceCents = 100000, costCents = 60000, scope = "design_studio", communityId = null, parentOptionId = null, isAvailable = true } = {}) {
  const saved = await kit.as(org.team.design, () => catalog().upsertOption({ categoryId: org.categoryIds[category], name, optionScope: scope, priceCents, costCents, costCodeId: org.costCodeIds["06-100"], communityId, parentOptionId, isAvailable, sortOrder: 0 }))
  return saved.id
}

const addRule = (kit, org, sourceId, targetId, kind, actor = org.team.design) => kit.as(actor, () => rules().addOptionConfigurationRule({ sourceId, targetId, kind }))
const ruleKinds = (kit, org, sourceId) => rowsOf(kit, `select target_option_id t, kind from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id=${q(kit, sourceId)} order by kind, t`)
const auditRows = (kit, org, entityType, action) => rowsOf(kit, `select entity_id, actor_user_id, action, before_data, after_data from public.audit_log where org_id=${q(kit, org.orgId)} and entity_type=${q(kit, entityType)} and action=${q(kit, action)} order by id`)

// ---------------------------------------------------------------------------
// EP03-02 — option dependency rules

async function optionRulesInheritAndRejectContradictions(kit, expected, check) {
  const org = await configOrg(kit)
  const sales = () => app("community-sales")
  const ids = {}
  for (const name of ["A", "B", "C", "D", "U", "X", "Y"]) ids[name] = await makeOption(kit, org, name === "A" ? "Rule option A" : `Rule option ${name}`)
  const { A: a, B: b, C: c, D: d, U: u, X: x, Y: y } = ids
  const override = await makeOption(kit, org, "Rule option Ao", { communityId: org.communityId, parentOptionId: a })
  const scopedElsewhere = await makeOption(kit, org, "Rule option scoped to Heron", { communityId: org.otherCommunityId })
  const archived = await makeOption(kit, org, "Rule option archived")
  await kit.as(org.team.design, () => catalog().archiveCatalogEntity({ type: "option", id: archived }))
  await kit.as(org.team.design, () => catalog().upsertOption({ id: u, categoryId: org.categoryIds.Kitchen, name: "Rule option U", optionScope: "design_studio", priceCents: 100000, isAvailable: false, sortOrder: 0 }))

  const observed = {}
  // The control is off until the organisation turns it on; nothing is authored before then.
  observed.beforeEnabled = /not enabled/.test(await refusal(() => addRule(kit, org, a, b, "requires"))) ? "refused: not enabled" : "allowed"
  setFlag(kit, org, true)
  // Only the catalog owner authors rules.
  observed.salesAgentAuthoring = /Missing permission: selections\.catalog\.manage/.test(await refusal(() => addRule(kit, org, a, b, "requires", org.team.sales))) ? "refused: selections.catalog.manage" : "allowed"

  // Authoring: A requires B; B requires C; the override of A requires D and may target a global option.
  const first = await addRule(kit, org, a, b, "requires")
  const second = await addRule(kit, org, b, c, "requires")
  const third = await addRule(kit, org, override, d, "requires")
  const authoredIds = [first.id, second.id, third.id]
  observed.authored = Object.fromEntries(await Promise.all([[a, "A"], [b, "B"], [override, "overrideOfA"]].map(async ([id, name]) => {
    const listed = await kit.as(org.team.design, () => rules().listOptionConfigurationRules(id))
    return [name, listed.rules.map((rule) => `${rule.kind}:${rule.targetName}`).sort()]
  })))
  observed.authoredAudit = auditRows(kit, org, "selection_configuration_rule", "insert").filter((row) => authoredIds.includes(row.entity_id)).map((row) => row.actor_user_id === org.team.design.userId && row.after_data.kind === "requires")

  // Inheritance at authoring: the override carries A's requirement of B (and so of C), so it cannot exclude either.
  const msg = async (work) => { const text = await refusal(work); return /impossible configuration/.test(text) ? "refused: impossible configuration" : /cannot require or exclude itself/.test(text) ? "refused: itself" : /Restore archived/.test(text) ? "refused: archived target" : /Restore unavailable/.test(text) ? "refused: unavailable target" : /community scope/.test(text) ? "refused: out of community scope" : /already exists|duplicate|pair_unique/.test(text) ? "refused: duplicate" : /not found/i.test(text) ? "refused: not found" : text }
  const before = rulesIn(kit, org)
  observed.overrideExcludesInheritedRequirement = await msg(() => addRule(kit, org, override, b, "excludes"))
  observed.overrideExcludesInheritedTransitive = await msg(() => addRule(kit, org, override, c, "excludes"))
  // Contradictions, direct and transitive, and rules that cannot stand.
  observed.sameEdgeOpposite = await msg(() => addRule(kit, org, a, b, "excludes"))
  observed.transitiveCycleContradiction = await msg(() => addRule(kit, org, c, a, "excludes"))
  observed.duplicate = await msg(() => addRule(kit, org, a, b, "requires"))
  observed.requireItself = await msg(() => addRule(kit, org, a, a, "requires"))
  observed.overrideRequiresItsBase = await msg(() => addRule(kit, org, override, a, "requires"))
  observed.unavailableTarget = await msg(() => addRule(kit, org, a, u, "requires"))
  observed.archivedTarget = await msg(() => addRule(kit, org, a, archived, "excludes"))
  observed.targetScopedToAnotherCommunity = await msg(() => addRule(kit, org, a, scopedElsewhere, "requires"))
  observed.targetUnknown = await msg(() => addRule(kit, org, a, randomUUID(), "requires"))
  // An option that carries rules cannot be made unavailable or moved out from under them.
  observed.makeRuledOptionUnavailable = /participates in configuration rules/.test(await refusal(() => kit.as(org.team.design, () => catalog().upsertOption({ id: b, categoryId: org.categoryIds.Kitchen, name: "Rule option B", optionScope: "design_studio", priceCents: 100000, isAvailable: false, sortOrder: 0 })))) ? "refused: participates in rules" : "allowed"
  observed.rulesAfterRejections = rulesIn(kit, org) - before

  // Inheritance at enforcement: the quote of the override must carry A's requirements (B, then C) and its own (D).
  const lotRow = quoteLot(org)
  const plan = org.plans[0]
  const swing = kit.rows(`select swing from public.lots where id=${q(kit, lotRow.id)}`)[0].swing
  const quote = (optionIds) => kit.as(org.team.sales, () => sales().priceAgreementDraft({ ...seed.configuration(org, { lotId: lotRow.id, plan, swing, skus: [] }), optionItems: optionIds.map((optionId) => ({ optionId })) }))
  const verdict = async (optionIds) => {
    const text = await refusal(() => quote(optionIds))
    if (text === "allowed") return "accepted"
    const unmet = [...text.matchAll(/Rule option (\w+) (requires|cannot be combined with) Rule option (\w+)\./g)].map((hit) => `${hit[1]}${hit[2] === "requires" ? ">" : "!"}${hit[3]}`).sort()
    return unmet.length ? `refused: ${unmet.join(", ")}` : text
  }
  observed.quoteOverrideAlone = await verdict([override])
  observed.quoteOverrideWithB = await verdict([override, b])
  observed.quoteOverrideWithBC = await verdict([override, b, c])
  observed.quoteOverrideWithBCD = await verdict([override, b, c, d])

  // Exclusions are authored the same way and inherited the same way: E1 excludes E2, and the override of E1 also excludes E3.
  const e1 = await makeOption(kit, org, "Rule option E1"), e2 = await makeOption(kit, org, "Rule option E2"), e3 = await makeOption(kit, org, "Rule option E3")
  const e1o = await makeOption(kit, org, "Rule option E1o", { communityId: org.communityId, parentOptionId: e1 })
  await addRule(kit, org, e1, e2, "excludes")
  await addRule(kit, org, e1o, e3, "excludes")
  observed.exclusionsAuthored = Object.fromEntries(await Promise.all([[e1, "E1"], [e1o, "overrideOfE1"]].map(async ([id, name]) => [name, (await kit.as(org.team.design, () => rules().listOptionConfigurationRules(id))).rules.map((rule) => `${rule.kind}:${rule.targetName}`).sort()])))
  observed.exclusionQuotes = { overrideAlone: await verdict([e1o]), overrideWithE2: await verdict([e1o, e2]), overrideWithE3: await verdict([e1o, e3]), baseWithE2: await verdict([e1, e2]), baseWithE3: await verdict([e1, e3]) }
  // Removing a rule: only from its own source, audited with what was removed, and the pair can be authored again.
  observed.removeFromWrongSource = /Rule changed or could not be removed/.test(await refusal(() => kit.as(org.team.design, () => rules().removeOptionConfigurationRule({ sourceId: b, ruleId: first.id })))) ? "refused" : "allowed"
  await kit.as(org.team.design, () => rules().removeOptionConfigurationRule({ sourceId: a, ruleId: first.id }))
  observed.removeAudited = auditRows(kit, org, "selection_configuration_rule", "delete").filter((row) => row.entity_id === first.id).map((row) => ({ by: row.actor_user_id === org.team.design.userId, was: `${row.before_data.kind}` }))
  observed.removedRuleGone = count(kit, `select id from public.selection_configuration_rules where id=${q(kit, first.id)}`)
  observed.reAuthoringAfterRemoval = (await addRule(kit, org, a, b, "requires")).id ? "authored" : "not saved"

  clearRules(kit, org)
  equal(check, "rules are authored by the catalog owner and inherited by community overrides; unavailable, contradictory, duplicate and out-of-scope rules are rejected and leave nothing behind", expected.expected, observed)
  return { orgId: org.orgId }
}

// A rule save from each of two sessions at once: the writer lock must give one consistent winner.
async function raceOptionRuleAuthoring(kit, expected, check) {
  const org = await configOrg(kit)
  setFlag(kit, org, true)
  const fresh = async (round, names) => Object.fromEntries(await Promise.all(names.map(async (name) => [name, await makeOption(kit, org, `Race ${round} ${name}`)])))
  const clean = (text) => /impossible configuration|pair_unique|duplicate key/.test(text) ? "refused" : text
  const settled = (results) => results.map((result) => result.status === "fulfilled" ? "saved" : clean(result.reason.message))
  const rulesBetween = (ids) => rowsOf(kit, `select kind, count(*)::int n from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id in (${ids.map((id) => q(kit, id)).join(",")}) group by kind order by kind`)
  const tally = (list) => list.reduce((all, item) => ({ ...all, [item]: (all[item] ?? 0) + 1 }), {})
  const rounds = { contradictoryPair: [], duplicateRule: [], oppositeKinds: [], transitiveTriangle: [], sqlContradictoryPair: [] }
  for (let round = 1; round <= 3; round += 1) {
    // Two rules that are each fine and together impossible: X requires Y, Y excludes X.
    let o = await fresh(round, ["X", "Y"])
    let results = await Promise.allSettled([addRule(kit, org, o.X, o.Y, "requires"), addRule(kit, org, o.Y, o.X, "excludes")])
    rounds.contradictoryPair.push({ outcomes: tally(settled(results)), stored: count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id in (${q(kit, o.X)},${q(kit, o.Y)})`) })
    // The same rule twice.
    o = await fresh(round, ["X", "Y"])
    results = await Promise.allSettled([addRule(kit, org, o.X, o.Y, "requires"), addRule(kit, org, o.X, o.Y, "requires")])
    rounds.duplicateRule.push({ outcomes: tally(settled(results)), stored: count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id=${q(kit, o.X)}`) })
    // The same pair, required by one author and excluded by the other.
    o = await fresh(round, ["X", "Y"])
    results = await Promise.allSettled([addRule(kit, org, o.X, o.Y, "requires"), addRule(kit, org, o.X, o.Y, "excludes")])
    rounds.oppositeKinds.push({ outcomes: tally(settled(results)), stored: count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id=${q(kit, o.X)}`) })
    // Three authors close a triangle that is impossible only when all three stand: X requires Y, Y requires Z, Z excludes X.
    o = await fresh(round, ["X", "Y", "Z"])
    results = await Promise.allSettled([addRule(kit, org, o.X, o.Y, "requires"), addRule(kit, org, o.Y, o.Z, "requires"), addRule(kit, org, o.Z, o.X, "excludes")])
    rounds.transitiveTriangle.push({ outcomes: tally(settled(results)), stored: count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id in (${q(kit, o.X)},${q(kit, o.Y)},${q(kit, o.Z)})`) })
    // The same contradiction straight at the database: two independent backends, released together.
    o = await fresh(round, ["X", "Y"])
    const insert = (s, t, kind) => `set role service_role; insert into public.selection_configuration_rules(org_id,source_option_id,target_option_id,kind) values(${q(kit, org.orgId)},${q(kit, s)},${q(kit, t)},'${kind}');`
    const sessions = await race(kit, [insert(o.X, o.Y, "requires"), insert(o.Y, o.X, "excludes")])
    rounds.sqlContradictoryPair.push({ outcomes: tally(sessions.map((s) => s.ok ? "saved" : clean(s.stderr).slice(0, 160))), stored: count(kit, `select id from public.selection_configuration_rules where org_id=${q(kit, org.orgId)} and source_option_id in (${q(kit, o.X)},${q(kit, o.Y)})`) })
  }
  clearRules(kit, org)
  equal(check, "two sessions saving rules at once: exactly one consistent winner, the loser is a clean refusal, nothing contradictory or duplicated is stored", expected.expected, { rounds })
  return { orgId: org.orgId }
}


// ---------------------------------------------------------------------------
// Homes. A buyer reserves a lot and signs; the consultant owns that, the design coordinator the choices.

const swingOf = (kit, lotId) => kit.rows(`select swing from public.lots where id=${q(kit, lotId)}`)[0].swing
const optionOf = (org, sku) => org.optionIds[sku]
const SKUS = ["ST-GAR", ...Object.values(seed.DESIGN_PICKS)]

/** Reserve the next lot for a new buyer; returns what the agreement needs. */
async function reserveNext(kit, org, name, { paid = false } = {}) {
  const lotRow = nextLot(org)
  const prospect = await seed.registerBuyer(kit, org, { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@acceptance.example.test` })
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lotRow.id, depositCents: 2000000, receivedOn: paid ? "2026-06-06" : null })
  return { lotRow, prospect, reservation }
}

const configFor = (kit, org, lotId, skus, plan = org.plans[0]) => seed.configuration(org, { lotId, plan, swing: swingOf(kit, lotId), skus })

/** A home with an executed agreement. */
async function soldHome(kit, org, name, skus = SKUS) {
  const reserved = await reserveNext(kit, org, name, { paid: true })
  const sale = await seed.signAgreement(kit, org, { reservationId: reserved.reservation.id, config: configFor(kit, org, reserved.lotRow.id, skus) })
  return { ...reserved, ...sale }
}

const designRows = (kit, projectId) => kit.rows(`select s.id, c.name category, s.selected_option_id, s.status, s.locked_at, s.price_cents_snapshot from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${q(kit, projectId)} and s.group_id is not null order by c.name`)

/** The design coordinator makes every design choice on a home, leaving them unconfirmed. */
async function chooseAll(kit, org, projectId, picks = seed.DESIGN_PICKS) {
  const rows = designRows(kit, projectId)
  for (const row of rows) await kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId, selectionId: row.id, optionId: optionOf(org, picks[row.category]) }))
  return designRows(kit, projectId)
}


/** Adopts a home for owned-inventory accounting, as the release does (the same revenue-policy step production-seed.releaseHome takes). */
async function adoptInventory(kit, org, projectId) {
  const policies = app("books/revenue-policies"), inventory = app("books/inventory")
  const adopt = () => kit.as(org.owner, () => inventory.enableProjectInventory({ projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/ownership` }))
  await adopt().catch(async (error) => {
    if (!/earn revenue differently|recognizes revenue at sale/.test(error.message)) throw error
    const contracts = kit.rows(`select id, contract_type from public.contracts where project_id=${q(kit, projectId)} and status='active'`)
    // A spec home has no contract at all: its policy is the project's own.
    if (!contracts.length) {
      const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: null, method: "closing", billingMethod: "fixed_price", effectiveFrom: "2026-06-01", rationale: "A spec home earns its revenue at closing; there is no contract before a buyer." }))
      await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    }
    for (const contract of contracts) {
      const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: contracts.length === 1 ? null : contract.id, method: "closing", billingMethod: contract.contract_type === "purchase_agreement" ? "purchase_agreement" : "fixed_price", effectiveFrom: "2026-06-01", rationale: "A home earns its revenue at closing; the placeholder contract carries none." }))
      await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    }
    await adopt()
  })
}

/** The refusal text, trimmed to the sentence the configuration control wrote (or the raw text when it is something else). */
const configRefusal = async (work) => {
  const text = await refusal(work)
  if (text === "allowed") return text
  const hits = [...text.matchAll(/([A-Z][\w\- ]+?) (requires|cannot be combined with) ([\w\- ]+?)\./g)].map((hit) => `${hit[1]} ${hit[2]} ${hit[3]}`).sort()
  return hits.length ? `refused: ${hits.join("; ")}` : text.slice(0, 200)
}

// ---------------------------------------------------------------------------
// EP03-03 — configuration preflight

async function preflightRejectsInvalidEffectiveConfigurations(kit, expected, check) {
  const org = await configOrg(kit)
  setFlag(kit, org, true)
  clearRules(kit, org)
  const [qtz, lvp, lgt] = ["KT-QTZ", "FL-LVP", "EL-LGT"].map((sku) => optionOf(org, sku))
  const alt = await makeOption(kit, org, "Alternate lighting", { category: "Electrical", priceCents: 150000 })
  const observed = {}
  // The rule the buyer's choices all satisfy: quartz countertops need the lighting package.
  await addRule(kit, org, qtz, lgt, "requires")

  // SALES: a quote (and the agreement written from it) is refused while the lighting package is missing.
  const unsold = await reserveNext(kit, org, "Quote Refused")
  const missing = configFor(kit, org, unsold.lotRow.id, ["ST-GAR", "KT-QTZ", "FL-LVP"])
  observed.salesQuoteMissingRequirement = await configRefusal(() => kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft(missing)))
  observed.salesAgreementMissingRequirement = await configRefusal(() => kit.as(org.team.sales, () => app("community-sales").createPurchaseAgreement({ ...missing, ...seed.agreementPacketFor(kit, org, missing.lotId), reservationId: unsold.reservation.id, expectedQuoteHash: "0".repeat(64) })))
  observed.agreementsWrittenForRefused = count(kit, `select id from public.contracts where org_id=${q(kit, org.orgId)} and contract_type='purchase_agreement' and id in (select contract_id from public.lot_reservations where id=${q(kit, unsold.reservation.id)})`)
  observed.salesQuoteWithRequirement = (await refusal(() => kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft(configFor(kit, org, unsold.lotRow.id, SKUS))))) === "allowed" ? "accepted" : "refused"

  // SELECTION CHANGE: swapping the lighting out from under the quartz countertops is refused and nothing moves.
  const h2 = await soldHome(kit, org, "Selection Change")
  const chosen = await chooseAll(kit, org, h2.projectId)
  const electrical = chosen.find((row) => row.category === "Electrical")
  observed.selectionsAfterChoosing = chosen.map((row) => row.status).sort()
  observed.selectionChangeBreakingRequirement = await configRefusal(() => kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId: h2.projectId, selectionId: electrical.id, optionId: alt })))
  observed.electricalUnchangedAfterRefusal = designRows(kit, h2.projectId).find((row) => row.category === "Electrical").selected_option_id === lgt

  // CONFIRMATION: a rule added after the choices were made (flooring excludes the lighting package) stops the group confirming.
  const lateRule = await addRule(kit, org, lvp, lgt, "excludes")
  observed.groupConfirmationRefused = await configRefusal(() => kit.as(org.team.design, () => app("selections").confirmSelectionGroup({ orgId: org.orgId, projectId: h2.projectId, groupId: org.selectionGroupId })))
  observed.statusesAfterRefusedConfirmation = designRows(kit, h2.projectId).map((row) => row.status).sort()
  // PO GENERATION on the same home.
  observed.purchaseOrderPreviewRefused = await configRefusal(() => kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: h2.projectId, mode: "dry_run" })))
  await kit.as(org.owner, () => rules().removeOptionConfigurationRule({ sourceId: lvp, ruleId: lateRule.id }))
  observed.groupConfirmedOnceRuleRemoved = (await kit.as(org.team.design, () => app("selections").confirmSelectionGroup({ orgId: org.orgId, projectId: h2.projectId, groupId: org.selectionGroupId }))).confirmed
  observed.statusesAfterConfirmation = designRows(kit, h2.projectId).map((row) => row.status).sort()

  // STARTS: a fully gated home cannot be released, or finish releasing, under a configuration that has become invalid.
  const h1 = await soldHome(kit, org, "Starts Release")
  await seed.chooseDesign(kit, org, { projectId: h1.projectId })
  const gates = await seed.clearStartGates(kit, org, { lotId: h1.lotRow.id, projectId: h1.projectId })
  const starts = app("starts")
  const packageStatus = () => kit.rows(`select status from public.start_packages where id=${q(kit, gates.packageId)}`)[0].status
  const purchaseOrders = () => count(kit, `select id from public.commitments where project_id=${q(kit, h1.projectId)} and commitment_type='purchase_order'`)
  observed.packageReadyBefore = gates.ready.status
  const releaseRule = await addRule(kit, org, lvp, lgt, "excludes")
  observed.startReleaseRefused = await configRefusal(() => kit.as(org.team.starts, () => starts.releaseStart(gates.packageId, { scheduledStartDate: seed.isoDay(0) })))
  observed.startPurchaseOrderPreviewRefused = await configRefusal(() => kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: h1.projectId, mode: "dry_run" })))
  observed.afterRefusedRelease = { package: packageStatus(), purchaseOrders: purchaseOrders(), lot: lot().lotStatus(kit, h1.lotRow.id) }
  // A release already queued when the rule lands stops at the purchase-order step.
  await kit.as(org.owner, () => rules().removeOptionConfigurationRule({ sourceId: lvp, ruleId: releaseRule.id }))
  await adoptInventory(kit, org, h1.projectId)
  const queued = await kit.as(org.team.starts, () => starts.releaseStart(gates.packageId, { scheduledStartDate: seed.isoDay(0) }))
  observed.releaseQueuedWhenValid = queued.released === true
  if (!kit.storage) kit.sql(`update public.start_release_steps set status='completed', completed_at=now(), detail='{"harness":"no file storage on the acceptance stack"}' where start_package_id=${q(kit, gates.packageId)} and step_key='drawings'`)
  const lateRelease = await addRule(kit, org, lvp, lgt, "excludes")
  for (let attempt = 0; attempt < 8 && !["released", "attention"].includes(packageStatus()); attempt += 1) {
    kit.sql(`update public.outbox set run_at=now() where org_id=${q(kit, org.orgId)} and status='pending' and payload->>'start_package_id'=${q(kit, gates.packageId)}`)
    await kit.service(() => app("starts-pipeline").runStartsPipeline())
  }
  const failedStep = kit.rows(`select step_key, status, error from public.start_release_steps where start_package_id=${q(kit, gates.packageId)} and status='failed'`)
  observed.queuedReleaseStopped = { package: packageStatus(), failedStep: failedStep.map((row) => row.step_key), message: failedStep.length && /requires|cannot be combined/.test(failedStep[0].error ?? "") ? "configuration conflict" : (failedStep[0]?.error ?? "none"), purchaseOrders: purchaseOrders(), lot: lot().lotStatus(kit, h1.lotRow.id) }
  await kit.as(org.owner, () => rules().removeOptionConfigurationRule({ sourceId: lvp, ruleId: lateRelease.id }))
  // Once the configuration is valid again the parked release can be retried and finishes.
  await kit.as(org.team.starts, () => starts.retryRelease(gates.packageId))
  for (let attempt = 0; attempt < 8 && packageStatus() !== "released"; attempt += 1) {
    kit.sql(`update public.outbox set run_at=now() where org_id=${q(kit, org.orgId)} and status='pending' and payload->>'start_package_id'=${q(kit, gates.packageId)}`)
    await kit.service(() => app("starts-pipeline").runStartsPipeline())
  }
  observed.recoveredOnceValid = { package: packageStatus(), purchaseOrders: purchaseOrders(), lot: lot().lotStatus(kit, h1.lotRow.id) }
  clearRules(kit, org)
  equal(check, "sales, selection changes, confirmation, purchase-order generation and starts each reject an invalid effective configuration, and none of them leaves a half-applied change", expected.expected, observed)
  return { orgId: org.orgId, projectId: h1.projectId }
}


async function storedChoicesDoNotAdoptNewOverride(kit, expected, check) {
  const org = await configOrg(kit)
  setFlag(kit, org, true)
  clearRules(kit, org)
  const catalogService = catalog()
  org.categoryIds["Outdoor living"] ??= (await kit.as(org.team.design, () => catalogService.upsertCategory({ name: "Outdoor living", sortOrder: 9 }))).id
  org.optionIds["KT-BLK"] ??= await makeOption(kit, org, "Butcher block countertops", { category: "Kitchen", priceCents: 400000, costCents: 250000 })
  org.optionIds["ST-LAN"] ??= await makeOption(kit, org, "Covered lanai", { category: "Outdoor living", scope: "structural", priceCents: 900000, costCents: 500000 })
  const picks = { ...seed.DESIGN_PICKS, Kitchen: "KT-BLK" }
  const observed = {}
  const overrideSentence = async (work) => { const text = await refusal(work); return text === "allowed" ? text : /community override has changed a selected option/.test(text) ? "refused: a community override changed a selected option" : /locked/i.test(text) ? "refused: locked" : text.slice(0, 200) }
  const kitchen = (projectId) => designRows(kit, projectId).find((row) => row.category === "Kitchen")
  const selections = () => app("selections")

  // A design choice: the override lands after the buyer chose.
  const home = await soldHome(kit, org, "Design Override", ["ST-GAR", "KT-BLK", "FL-LVP", "EL-LGT"])
  await chooseAll(kit, org, home.projectId, picks)
  const base = org.optionIds["KT-BLK"]
  const before = kitchen(home.projectId)
  observed.choiceBefore = { isBase: before.selected_option_id === base, priceCents: before.price_cents_snapshot }
  const override = await makeOption(kit, org, "Butcher block countertops (Cypress Landing)", { category: "Kitchen", priceCents: 450000, costCents: 280000, communityId: org.communityId, parentOptionId: base })
  const flooring = designRows(kit, home.projectId).find((row) => row.category === "Flooring")
  observed.unrelatedSelectionRefused = await overrideSentence(() => kit.as(org.team.design, () => selections().selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: flooring.id, optionId: optionOf(org, "FL-LVP") })))
  observed.confirmationRefused = await overrideSentence(() => kit.as(org.team.design, () => selections().confirmSelectionGroup({ orgId: org.orgId, projectId: home.projectId, groupId: org.selectionGroupId })))
  observed.purchaseOrderPreviewRefused = await overrideSentence(() => kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: home.projectId, mode: "dry_run" })))
  const stillBase = kitchen(home.projectId)
  observed.choiceAfterRefusals = { isBase: stillBase.selected_option_id === base, status: stillBase.status, priceCents: stillBase.price_cents_snapshot }
  // Adopting the override is a person's explicit change; it re-prices to the override and the home moves again.
  await kit.as(org.team.design, () => selections().selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: kitchen(home.projectId).id, optionId: base }))
  const adopted = kitchen(home.projectId)
  observed.choiceAfterExplicitChange = { isOverride: adopted.selected_option_id === override, status: adopted.status, priceCents: adopted.price_cents_snapshot }
  observed.confirmationAfterExplicitChange = (await kit.as(org.team.design, () => selections().confirmSelectionGroup({ orgId: org.orgId, projectId: home.projectId, groupId: org.selectionGroupId }))).confirmed
  observed.purchaseOrderPreviewAfterExplicitChange = await overrideSentence(() => kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: home.projectId, mode: "dry_run" })))

  // A signed structural choice: the override cannot replace it, and only a change order can move it.
  const signed = await soldHome(kit, org, "Structural Override", ["ST-GAR", "ST-LAN", "KT-BLK", "FL-LVP", "EL-LGT"])
  const lanai = org.optionIds["ST-LAN"]
  const lanaiRow = () => kit.rows(`select s.id, s.selected_option_id, s.locked_at from public.project_selections s join public.selection_categories c on c.id=s.category_id where s.project_id=${q(kit, signed.projectId)} and c.name='Outdoor living'`)[0]
  observed.signedStructuralBefore = { isBase: lanaiRow().selected_option_id === lanai, locked: Boolean(lanaiRow().locked_at) }
  await makeOption(kit, org, "Covered lanai (Cypress Landing)", { category: "Outdoor living", scope: "structural", priceCents: 1100000, costCents: 600000, communityId: org.communityId, parentOptionId: lanai })
  observed.signedPurchaseOrderPreviewRefused = await overrideSentence(() => kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: signed.projectId, mode: "dry_run" })))
  observed.signedExplicitChangeRefused = await overrideSentence(() => kit.as(org.team.design, () => selections().selectProjectOption({ orgId: org.orgId, projectId: signed.projectId, selectionId: lanaiRow().id, optionId: lanai })))
  observed.signedStructuralAfter = { isBase: lanaiRow().selected_option_id === lanai }
  equal(check, "a choice the buyer already made, or signed, keeps pointing at what they chose when a community override is authored; only an explicit change adopts it", expected.expected, observed)
  return { orgId: org.orgId, projectId: home.projectId }
}


// ---------------------------------------------------------------------------
// EP03-07 — deterministic pricing resolution

async function priceResolutionIsDeterministicAndFailsExplicitly(kit, expected, check) {
  const org = await configOrg(kit)
  const paging = require("../../../lib/land/paging")
  const [v1, v2] = org.plans.map((plan) => plan.versionId)
  const [c1, c2] = [org.communityId, org.otherCommunityId]
  const design = org.team.design
  const resolve = async (optionId, versionId, communityId) => {
    const [row] = await catalog().resolveOptionPricing({ orgId: org.orgId, items: [{ optionId }], ...(versionId ? { housePlanVersionId: versionId } : {}), ...(communityId ? { communityId } : {}) })
    return { optionId: row.optionId === optionId ? "base" : row.optionId, priceCents: row.priceCents, available: row.available, source: row.source }
  }
  const setPrice = (optionId, versionId, priceCents, communityId = null, isAvailable = true) => kit.as(design, () => catalog().setCatalogPrice({ optionId, housePlanVersionId: versionId, priceCents, communityId, isAvailable }))
  const priceRows = (optionId, versionId, communityId) => count(kit, `select id from public.selection_catalog_prices where option_id=${q(kit, optionId)} and house_plan_version_id=${q(kit, versionId)} and community_id ${communityId ? `=${q(kit, communityId)}` : "is null"}`)
  const observed = {}

  // Precedence: community price on the plan > the plan's price > the option's own price.
  const px = await makeOption(kit, org, "Pricing option", { priceCents: 100000, costCents: 60000 })
  observed.optionOnly = await resolve(px, v1, c1)
  await setPrice(px, v1, 90000)
  observed.planPrice = { sameCommunityAndPlan: await resolve(px, v1, c1), otherPlanUnpriced: await resolve(px, v2, c1), noPlanGiven: await resolve(px, null, c1) }
  await setPrice(px, v1, 80000, c1)
  observed.communityPrice = { inItsCommunity: await resolve(px, v1, c1), inAnotherCommunity: await resolve(px, v1, c2), onAnotherPlan: await resolve(px, v2, c1) }
  const again = [await resolve(px, v1, c1), await resolve(px, v1, c1), await resolve(px, v1, c1)]
  observed.repeatable = again.every((r) => JSON.stringify(r) === JSON.stringify(again[0]))
  await setPrice(px, v1, 70000, c1)
  observed.resavedCellIsOneRow = { rows: priceRows(px, v1, c1), resolved: (await resolve(px, v1, c1)).priceCents }

  // A community override: its own price when nothing prices the plan, and the base option's community price when something does.
  const py = await makeOption(kit, org, "Pricing option with override", { priceCents: 50000 })
  const pyOverride = await makeOption(kit, org, "Pricing option with override (Cypress Landing)", { priceCents: 55000, communityId: c1, parentOptionId: py })
  const effective = async (optionId, versionId, communityId) => { const row = await resolve(optionId, versionId, communityId); return { ...row, effectiveIsOverride: row.optionId === pyOverride, optionId: undefined } }
  observed.overrideInItsCommunity = await effective(py, v1, c1)
  observed.overrideInAnotherCommunity = await effective(py, v1, c2)
  const pxOverride = await makeOption(kit, org, "Pricing option (Cypress Landing)", { priceCents: 95000, communityId: c1, parentOptionId: px })
  const withOverride = await resolve(px, v1, c1)
  observed.overrideKeepsTheCommunityPlanPrice = { effectiveIsOverride: withOverride.optionId === pxOverride, priceCents: withOverride.priceCents, source: withOverride.source }

  // An unavailable community price makes the item unavailable, and the quote refuses it.
  await setPrice(px, v2, 60000, c1, false)
  observed.unavailableCommunityPrice = (await resolve(px, v2, c1)).available
  const lotRow = quoteLot(org)
  const swing = swingOf(kit, lotRow.id)
  const quote = (planIndex, optionIds) => kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft({ ...seed.configuration(org, { lotId: lotRow.id, plan: org.plans[planIndex], swing, skus: [] }), optionItems: optionIds.map((optionId) => ({ optionId })) }))
  const text = async (work) => { const message = await refusal(work); return message === "allowed" ? message : message.slice(0, 160) }
  observed.quoteWithUnavailableItem = await text(() => quote(1, [px]))

  // The quote the sales desk signs: plan base + lot premium + each option at its resolved price, as integer cents.
  org.categoryIds["Pricing structure"] ??= (await kit.as(design, () => catalog().upsertCategory({ name: "Pricing structure", sortOrder: 11 }))).id
  const ps = (await kit.as(design, () => catalog().upsertOption({ categoryId: org.categoryIds["Pricing structure"], name: "Pricing structural option", optionScope: "structural", priceCents: 200000, costCents: 120000, costCodeId: org.costCodeIds["03-300"], sortOrder: 0, isAvailable: true }))).id
  await setPrice(ps, v1, 175000, c1)
  const priced = await quote(0, [ps, px])
  const premium = Number(kit.rows(`select premium_cents from public.lots where id=${q(kit, lotRow.id)}`)[0].premium_cents)
  observed.quote = { structuralCents: priced.structuralOptionsCents, designCents: priced.designSelectionsCents, totalMatchesBasePlusPremiumPlusOptions: priced.totalCents === org.plans[0].basePriceCents + premium + 175000 + 70000,
    sources: Object.fromEntries([...priced.structuralOptions, ...priced.designSelections].map((item) => [item.label, `${item.priceCents}:${item.source}`])) }

  // Duplicates fail explicitly.
  const pd = await makeOption(kit, org, "Pricing option duplicated override", { priceCents: 10000 })
  await makeOption(kit, org, "Pricing option duplicated override (one)", { priceCents: 11000, communityId: c1, parentOptionId: pd })
  await makeOption(kit, org, "Pricing option duplicated override (two)", { priceCents: 12000, communityId: c1, parentOptionId: pd })
  observed.duplicateOverrides = { resolve: /Multiple community overrides match/.test(await refusal(() => resolve(pd, v1, c1))) ? "refused: multiple overrides" : "resolved", quote: /Multiple community overrides match/.test(await refusal(() => quote(0, [pd]))) ? "refused: multiple overrides" : "quoted", otherCommunityStillResolves: (await resolve(pd, v1, c2)).priceCents }
  const duplicatePrice = (communityId) => { try { kit.sql(`insert into public.selection_catalog_prices(org_id, option_id, house_plan_version_id, community_id, price_cents) values(${q(kit, org.orgId)}, ${q(kit, px)}, ${q(kit, v1)}, ${communityId ? q(kit, communityId) : "null"}, 1)`); return "inserted" } catch (error) { return /selection_catalog_prices_option_key/.test(error.message) ? "refused: duplicate price cell" : error.message.slice(0, 200) } }
  observed.duplicatePriceCell = { community: duplicatePrice(c1), plan: duplicatePrice(null), rowsAfter: priceRows(px, v1, c1) + priceRows(px, v1, null) }

  // Missing context fails explicitly.
  const resolveRaw = (items, scope = { housePlanVersionId: v1, communityId: c1 }) => catalog().resolveOptionPricing({ orgId: org.orgId, items, ...scope })
  observed.missingContext = {
    unknownOption: /Catalog item was not found/.test(await refusal(() => resolveRaw([{ optionId: randomUUID() }]))) ? "refused: not found" : "resolved",
    neitherOptionNorPackage: /Choose exactly one option or package/.test(await refusal(() => resolveRaw([{}]))) ? "refused: choose one" : "resolved",
    bothOptionAndPackage: /Choose exactly one option or package/.test(await refusal(() => resolveRaw([{ optionId: px, packageId: randomUUID() }]))) ? "refused: choose one" : "resolved",
    quoteWithoutAPlanVersion: await text(() => kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft({ lotId: lotRow.id, elevationId: org.plans[0].elevationIds[0], swing, optionItems: [{ optionId: px }], incentiveIds: [] }))),
    quoteOnAnUnknownVersion: await text(() => kit.as(org.team.sales, () => app("community-sales").priceAgreementDraft({ ...seed.configuration(org, { lotId: lotRow.id, plan: org.plans[0], swing, skus: [] }), housePlanVersionId: randomUUID(), optionItems: [{ optionId: px }] }))),
    priceForAnUnknownPlanVersion: /released plan version/.test(await refusal(() => setPrice(px, randomUUID(), 1000))) ? "refused" : "saved",
  }

  // Invalid money fails explicitly and changes nothing.
  const before = (await resolve(px, v1, c1)).priceCents
  const bad = async (work) => { const message = await refusal(work); return message === "allowed" ? message : "refused" }
  observed.invalidMoney = {
    negativeCatalogPrice: await bad(() => setPrice(px, v1, -1, c1)),
    fractionalCatalogPrice: await bad(() => setPrice(px, v1, 99.5, c1)),
    textCatalogPrice: await bad(() => setPrice(px, v1, "100", c1)),
    notANumber: await bad(() => setPrice(px, v1, Number.NaN, c1)),
    beyondIntegerRange: await bad(() => setPrice(px, v1, 2147483648, c1)),
    negativeOptionPrice: await bad(() => makeOption(kit, org, "Bad option", { priceCents: -5 })),
    fractionalOptionPrice: await bad(() => makeOption(kit, org, "Bad option", { priceCents: 12.5 })),
    negativeCost: await bad(() => makeOption(kit, org, "Bad option", { costCents: -1 })),
    databaseRefusesNegativePrice: (() => { try { kit.sql(`insert into public.selection_catalog_prices(org_id, option_id, house_plan_version_id, community_id, price_cents) values(${q(kit, org.orgId)}, ${q(kit, py)}, ${q(kit, v2)}, null, -1)`); return "inserted" } catch (error) { return /price_cents_check/.test(error.message) ? "refused" : error.message.slice(0, 160) } })(),
    priceUnchanged: (await resolve(px, v1, c1)).priceCents === before,
    badOptionsCreated: count(kit, `select id from public.selection_options where org_id=${q(kit, org.orgId)} and name='Bad option'`),
  }

  // Complete reads: a 250-item resolution (reads are batched by 100) returns every item, in order, and a pager that cannot finish says so.
  kit.sql(`insert into public.selection_options(id, org_id, category_id, name, price_cents, price_type, option_scope, is_available)
    select gen_random_uuid(), ${q(kit, org.orgId)}, ${q(kit, org.categoryIds.Kitchen)}, 'Bulk option ' || n, 1000 + n, 'upgrade', 'design_studio', true from generate_series(1, 250) n`)
  const bulk = kit.rows(`select id, name from public.selection_options where org_id=${q(kit, org.orgId)} and name like 'Bulk option %' order by (substring(name from 13))::int`)
  await setPrice(bulk[0].id, v1, 5, c1)
  await setPrice(bulk[249].id, v1, 6)
  const all = await resolveRaw(bulk.map((row) => ({ optionId: row.id })))
  observed.completeReads = { items: all.length, inOrder: all.every((row, i) => row.optionId === bulk[i].id), sumCents: all.reduce((a, row) => a + row.priceCents, 0),
    sources: { first: all[0].source, middle: all[100].source, last: all[249].source } }
  const ids = Array.from({ length: 7 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}` }))
  const reader = (rows) => async (after, take) => ({ data: rows.filter((row) => !after || row.id > after).slice(0, take), error: null })
  observed.pager = {
    allSevenInSmallPages: (await paging.readAllRowsById(reader(ids), { cap: 20, label: "x", pageSize: 2 })).length,
    overTheCap: /Validation limit exceeded/.test(await refusal(() => paging.readAllRowsById(reader(ids), { cap: 5, label: "x", pageSize: 2 }))) ? "refused: limit exceeded" : "returned",
    cursorStuck: /did not advance/.test(await refusal(() => paging.readAllRowsById(async () => ({ data: [{ id: ids[0].id }], error: null }), { cap: 20, label: "x", pageSize: 2 }))) ? "refused: cursor" : "returned",
    rangeReaderSaysTruncated: (await paging.readAllRows(async (from, to) => ({ data: ids.slice(from, to + 1), error: null }), { cap: 4, label: "x", pageSize: 2 })).truncated,
  }
  equal(check, "community prices take precedence deterministically; duplicate, missing-context and invalid-money inputs fail explicitly and complete reads are never silently truncated", expected.expected, observed)
  return { orgId: org.orgId }
}


// ---------------------------------------------------------------------------
// EP06-03 — schedule-derived cutoffs and explicit overrides

const daysFromToday = (date) => date == null ? null : Math.round((Date.parse(date) - Date.parse(seed.isoDay(0))) / 86400000)

async function cutoffsFollowTheScheduleAndOverridesAreControlled(kit, expected, check) {
  const org = await configOrg(kit)
  // No configuration rules here: this is the cutoff control alone.
  clearRules(kit, org)
  const cutoffs = app("selection-cutoffs"), selections = app("selections")
  const observed = {}
  const home = await soldHome(kit, org, "Cutoff Home")
  const projectId = home.projectId
  await chooseAll(kit, org, projectId)
  await kit.as(org.team.design, () => selections.confirmSelectionGroup({ orgId: org.orgId, projectId, groupId: org.selectionGroupId }))
  const instance = () => kit.rows(`select id, cutoff_date::text cutoff, cutoff_source source, override_reason reason, overridden_by by, status, locked_at is not null locked from public.project_selection_groups where project_id=${q(kit, projectId)} and group_id=${q(kit, org.selectionGroupId)}`)[0]
  const state = () => { const row = instance(); return { cutoffDays: daysFromToday(row.cutoff), source: row.source, status: row.status, locked: row.locked } }
  const override = (actor, cutoffDate, reason) => kit.as(actor, () => cutoffs.overrideGroupCutoff({ projectId, groupId: org.selectionGroupId, cutoffDate, reason }))
  const revert = (actor, reason) => kit.as(actor, () => cutoffs.revertCutoffToSchedule({ projectId, groupId: org.selectionGroupId, reason }))
  const flooring = () => designRows(kit, projectId).find((row) => row.category === "Flooring")
  const touchFlooring = () => kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId, selectionId: flooring().id, optionId: optionOf(org, "FL-LVP") }))
  const confirmFlooring = () => kit.as(org.team.design, () => selections.confirmSelection({ orgId: org.orgId, projectId, selectionId: flooring().id }))
  const mutation = async (work) => { const text = await refusal(work); return text === "allowed" ? "allowed" : /selection deadline|is locked/i.test(text) ? "refused: past the cutoff" : text.slice(0, 160) }
  const denied = async (work) => { const text = await refusal(work); return /Missing permission: selections\.cutoff\.override/.test(text) ? "refused: selections.cutoff.override" : text === "allowed" ? "allowed" : text.slice(0, 160) }
  const evidence = (type) => kit.rows(`select payload from public.events where org_id=${q(kit, org.orgId)} and entity_id=${q(kit, instance().id)} and event_type=${q(kit, type)} order by created_at`)

  // Authority and reason come before anything moves.
  observed.beforeAnyOverride = state()
  observed.overrideByOtherRoles = { salesConsultant: await denied(() => override(org.team.sales, seed.isoDay(-1), "Buyer finished the design appointment")), superintendent: await denied(() => override(org.team.superintendent, seed.isoDay(-1), "Buyer finished the design appointment")), startsCoordinator: await denied(() => override(org.team.starts, seed.isoDay(-1), "Buyer finished the design appointment")) }
  observed.overrideWithoutAReason = { tooShort: (await refusal(() => override(org.team.design, seed.isoDay(-1), "ok"))) === "allowed" ? "allowed" : "refused", empty: (await refusal(() => override(org.team.design, seed.isoDay(-1), ""))) === "allowed" ? "allowed" : "refused", notADate: (await refusal(() => override(org.team.design, "tomorrow", "Buyer finished the design appointment"))) === "allowed" ? "allowed" : "refused" }
  observed.afterRefusedOverrides = state()

  // An authorised override with a reason: recorded on the group, the event stream and the audit log, and it closes the group.
  await override(org.team.design, seed.isoDay(-1), "Buyer finished the design appointment")
  const manual = instance()
  observed.overrideRecorded = { ...state(), reasonStored: manual.reason, byTheDesignCoordinator: manual.by === org.team.design.userId }
  observed.overrideEvents = evidence("selection_cutoff_overridden").map((row) => ({ reason: row.payload.reason, cutoffDate: daysFromToday(row.payload.cutoffDate) }))
  observed.overrideAudit = kit.rows(`select actor_user_id, after_data from public.audit_log where org_id=${q(kit, org.orgId)} and entity_type='project_selection_group' and entity_id=${q(kit, manual.id)} and action='update' order by id`).map((row) => ({ by: row.actor_user_id === org.team.design.userId, source: row.after_data.cutoff_source, reason: row.after_data.override_reason }))
  observed.mutationsAfterTheCutoff = { select: await mutation(touchFlooring), confirm: await mutation(confirmFlooring) }

  // The release builds the schedule; an explicit override is not rewritten by it.
  const gates = await seed.clearStartGates(kit, org, { lotId: home.lotRow.id, projectId })
  await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId })
  const interior = () => kit.rows(`select id, start_date::text start_date from public.schedule_items where project_id=${q(kit, projectId)} and name='Interior finishes'`)[0]
  const releaseDay = seed.isoDay(0)
  observed.afterReleaseOverrideStands = { ...state(), interiorFinishesStartsDaysAfterRelease: Math.round((Date.parse(interior().start_date) - Date.parse(releaseDay)) / 86400000) }

  // Returning to the schedule is itself controlled; the derived cutoff is the task's start less the group's 14 days.
  observed.revertByOtherRoles = await denied(() => revert(org.team.sales, "Back to the schedule date"))
  observed.revertWithoutAReason = (await refusal(() => revert(org.team.design, "no"))) === "allowed" ? "allowed" : "refused"
  const afterRefused = state()
  await revert(org.team.design, "Back to the schedule date")
  const derived = instance()
  observed.reverted = { source: derived.source, status: derived.status, locked: derived.locked, reasonCleared: derived.reason === null, cutoffIsInteriorStartLess14: derived.cutoff === kit.rows(`select (start_date - 14)::text d from public.schedule_items where id=${q(kit, interior().id)}`)[0].d, stillOverriddenBeforeRevert: afterRefused.source }
  observed.revertEvents = evidence("selection_cutoff_reverted").map((row) => ({ reason: row.payload.reason, discarded: daysFromToday(row.payload.discarded_cutoff_date) }))
  observed.revertAudit = kit.rows(`select actor_user_id, before_data, after_data from public.audit_log where org_id=${q(kit, org.orgId)} and entity_type='project_selection_group' and entity_id=${q(kit, derived.id)} and after_data->>'revert_reason' is not null`).map((row) => ({ by: row.actor_user_id === org.team.design.userId, was: row.before_data.cutoff_source, discarded: daysFromToday(row.before_data.cutoff_date), reason: row.after_data.revert_reason }))
  observed.mutationOpenAgain = await mutation(touchFlooring)

  // The derived cutoff follows the schedule; an explicit one does not.
  const moveInterior = (date) => kit.sql(`update public.schedule_items set start_date=${q(kit, date)}, end_date=(${q(kit, date)}::date + 28) where id=${q(kit, interior().id)}`)
  const recompute = () => kit.service(() => cutoffs.recomputeProjectSelectionCutoffs(projectId, org.orgId))
  moveInterior(seed.isoDay(100))
  const moved = await recompute()
  observed.scheduleMovedLater = { cutoffDays: state().cutoffDays, changedGroups: moved.changed, source: state().source }
  const lastChange = evidence("selection_cutoff_changed").pop()
  observed.cutoffChangedEvent = { old: daysFromToday(lastChange?.payload.old), new: daysFromToday(lastChange?.payload.new) }
  await override(org.team.design, seed.isoDay(20), "Buyer asked for three more weeks")
  moveInterior(seed.isoDay(40))
  await recompute()
  observed.explicitCutoffIgnoresScheduleMoves = { ...state(), mutation: await mutation(touchFlooring) }
  await override(org.team.design, seed.isoDay(-2), "Design window closed")
  observed.explicitCutoffInThePast = { ...state(), select: await mutation(touchFlooring), confirm: await mutation(confirmFlooring) }

  // A derived cutoff that passes locks the group and its choices when the sweep runs.
  await revert(org.team.design, "Back to the schedule date")
  moveInterior(seed.isoDay(8))
  await recompute()
  observed.derivedCutoffPassed = { ...state(), stillOpenBeforeSweep: state().status }
  const swept = await kit.service(() => cutoffs.lockDueGroups(org.orgId))
  const lockedRows = kit.rows(`select count(*)::int n from public.project_selections where project_id=${q(kit, projectId)} and group_id=${q(kit, org.selectionGroupId)} and locked_at is not null`)[0].n
  observed.sweep = { groupsLocked: swept.locked >= 1, group: state().status, choicesLocked: lockedRows, select: await mutation(touchFlooring) }
  equal(check, "selection cutoffs follow the schedule, explicit overrides need authority and a reason and leave events and audit evidence, and both are enforced on every selection mutation", expected.expected, observed)
  return { orgId: org.orgId, projectId }
}


async function extendingASweptCutoffReopensTheChoices(kit, expected, check) {
  const org = await configOrg(kit)
  clearRules(kit, org)
  const cutoffs = app("selection-cutoffs"), selections = app("selections")
  const home = await soldHome(kit, org, "Swept Cutoff")
  const projectId = home.projectId
  await chooseAll(kit, org, projectId)
  const instance = () => kit.rows(`select id, status, locked_at is not null locked from public.project_selection_groups where project_id=${q(kit, projectId)} and group_id=${q(kit, org.selectionGroupId)}`)[0]
  const choicesLocked = () => kit.rows(`select count(*)::int n from public.project_selections where project_id=${q(kit, projectId)} and group_id=${q(kit, org.selectionGroupId)} and locked_at is not null`)[0].n
  const flooring = () => designRows(kit, projectId).find((row) => row.category === "Flooring")
  const touch = async () => { const text = await refusal(() => kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId, selectionId: flooring().id, optionId: optionOf(org, "FL-LVP") }))); return text === "allowed" ? "allowed" : "refused" }
  // The cutoff is today (still open); the day then passes and the nightly sweep locks the group and its choices.
  await kit.as(org.team.design, () => cutoffs.overrideGroupCutoff({ projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(0), reason: "Cutoff set for today" }))
  kit.sql(`update public.project_selection_groups set cutoff_date=(current_date - 1) where id=${q(kit, instance().id)}`)
  await kit.service(() => cutoffs.lockDueGroups(org.orgId))
  const observed = { afterSweep: { group: instance().status, choicesLocked: choicesLocked(), select: await touch() } }
  // The design coordinator, with a reason, gives the buyer ten more days.
  await kit.as(org.team.design, () => cutoffs.overrideGroupCutoff({ projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(10), reason: "Buyer has ten more days to choose" }))
  observed.afterExtension = { group: instance().status, choicesLocked: choicesLocked(), select: await touch() }
  equal(check, "an authorised override that extends a swept cutoff reopens the group and its choices", expected.expected, observed)
  return { orgId: org.orgId, projectId }
}


// ---------------------------------------------------------------------------
// EP04-05 — lot lifecycle and bounded inventory

const lotRow = (kit, lotId) => kit.rows(`select status, project_id, delivered_at is not null delivered from public.lots where id=${q(kit, lotId)}`)[0]

async function lotStatesNeedTheHomeAndReversalsAreControlled(kit, expected, check) {
  const org = await configOrg(kit)
  const lots = app("lots"), starts = app("starts")
  const observed = {}
  const verdict = async (work) => {
    const message = await refusal(work)
    if (message === "allowed") return "allowed"
    const rules = [[/project must be attached|cannot start without an attached project/, "refused: a started lot needs its home"], [/Record the actual land acquisition/, "refused: land must be acquired in Books first"], [/not been delivered/, "refused: land not delivered"], [/already attached to another lot/, "refused: the home is on another lot"], [/explicit force confirmation/, "refused: needs force"], [/only one step unless force/, "refused: needs force"], [/Missing permission: community\.write/, "refused: community.write"], [/Missing permission: lot\.write/, "refused: lot.write"], [/Only controlled, owned, or developed lots can be deleted/, "refused: only unbuilt lots are deleted"]]
    return (rules.find(([pattern]) => pattern.test(message)) ?? [null, message.slice(0, 160)])[1]
  }
  const shape = (row) => ({ status: row.status, hasHome: row.project_id != null })
  // Fresh lots of their own, so nothing depends on another subcase.
  observed.created = (await kit.as(org.team.land, () => lots.createLots(org.communityId, { lots: ["L1", "L2", "L3"].map((name) => ({ lotNumber: `LC-${name}`, status: "controlled" })) }))).created
  const [l1, l2, l3] = kit.rows(`select id from public.lots where org_id=${q(kit, org.orgId)} and lot_number like 'LC-L%' order by lot_number`).map((row) => row.id)
  const [x, y, z] = [nextLot(org), nextLot(org), nextLot(org)]

  // A started lot is a lot with a home; nothing sets it any other way.
  observed.startedNeedsAHome = {
    create: await verdict(() => kit.as(org.team.land, () => lots.createLots(org.communityId, { lots: [{ lotNumber: "LC-S", status: "started" }] }))),
    setStatus: await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(l1, "started"))),
    setStatusForced: await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(l1, "started", { force: true }))),
    update: await verdict(() => kit.as(org.team.land, () => lots.updateLot(l1, { status: "started" }))),
    bulk: await verdict(() => kit.as(org.team.land, () => lots.bulkUpdateLots(org.communityId, { lotIds: [l1, l2], patch: { status: "started" } }))),
    lotsUnchanged: [l1, l2].map((id) => lotRow(kit, id).status),
  }
  observed.salesCannotMoveLots = await verdict(() => kit.as(org.team.sales, () => lots.setLotStatus(l1, "controlled")))
  observed.ownershipNeedsTheLandBought = await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(l1, "owned")))

  // Opening a start package gives the lot its home; the lot is assigned, never below.
  await kit.as(org.team.starts, () => starts.openStartPackage(x.id, { isFinanced: false }))
  const home = lotRow(kit, x.id).project_id
  observed.homeOpened = shape(lotRow(kit, x.id))
  observed.detachBeforeStart = await verdict(() => kit.as(org.team.starts, () => lots.detachProjectFromLot(x.id)))
  observed.afterDetachBeforeStart = shape(lotRow(kit, x.id))
  // Linking a home starts the lot, on delivered land, once.
  observed.attachToUndeliveredLand = await verdict(() => kit.as(org.team.starts, () => lots.attachProjectToLot(l2, home)))
  observed.attachToDeliveredLand = await verdict(() => kit.as(org.team.starts, () => lots.attachProjectToLot(y.id, home)))
  observed.afterAttach = shape(lotRow(kit, y.id))
  observed.sameHomeOnASecondLot = await verdict(() => kit.as(org.team.starts, () => lots.attachProjectToLot(z.id, home)))
  // Taking a started home off its lot is a reversal: it needs force, and force needs community.write.
  observed.reverseWithoutForce = await verdict(() => kit.as(org.team.starts, () => lots.detachProjectFromLot(y.id)))
  observed.reverseForcedWithoutAuthority = await verdict(() => kit.as(org.team.starts, () => lots.detachProjectFromLot(y.id, { force: true })))
  observed.afterRefusedReversals = shape(lotRow(kit, y.id))
  observed.reverseForcedByTheOwner = await verdict(() => kit.as(org.owner, () => lots.detachProjectFromLot(y.id, { force: true })))
  observed.afterForcedReversal = shape(lotRow(kit, y.id))
  // A correction of more than one step back is a reversal too.
  observed.backTwoStepsWithoutForce = await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(z.id, "controlled")))
  observed.backTwoStepsForcedWithoutAuthority = await verdict(() => kit.as(org.team.starts, () => lots.setLotStatus(z.id, "controlled", { force: true })))
  observed.afterRefusedCorrections = lotRow(kit, z.id).status
  observed.backTwoStepsForcedByLand = await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(z.id, "controlled", { force: true })))
  observed.afterForcedCorrection = lotRow(kit, z.id).status
  // A settled lot cannot be quietly reopened or given a second home. Planted the way
  // legacy closed lots without a home exist (the guard refuses making one now).
  const w = nextLot(org)
  kit.sql(`begin; set local session_replication_role = replica; update public.lots set status='closed' where id=${q(kit, w.id)}; commit;`)
  observed.closedLot = { moveBackWithoutForce: await verdict(() => kit.as(org.team.land, () => lots.setLotStatus(w.id, "assigned"))), attachHomeWithoutForce: await verdict(() => kit.as(org.team.starts, () => lots.attachProjectToLot(w.id, home))), status: lotRow(kit, w.id).status, homeStillFree: lotRow(kit, w.id).project_id === null }
  // Only unbuilt lots are deleted.
  observed.deleteAssigned = await verdict(() => kit.as(org.team.land, () => lots.deleteLot(y.id)))
  observed.deleteControlled = await verdict(() => kit.as(org.team.land, () => lots.deleteLot(l3)))
  observed.controlledLotGone = count(kit, `select id from public.lots where id=${q(kit, l3)}`)

  // The org never holds a started lot without a home, or a home on a lot below assigned.
  observed.invariants = kit.rows(`select count(*) filter (where status='started' and project_id is null)::int "startedWithoutHome", count(*) filter (where project_id is not null and status in ('controlled','owned','developed'))::int "homeBelowAssigned" from public.lots where org_id=${q(kit, org.orgId)}`)[0]
  // Every reversal leaves its record.
  const trail = (id) => kit.rows(`select event_type, payload->>'force' forced, payload->>'from' from_status, payload->>'to' to_status from public.events where org_id=${q(kit, org.orgId)} and entity_id=${q(kit, id)} and event_type like 'lot.%' and event_type not in ('lot.updated','lot.created') order by created_at`).map((row) => `${row.event_type}${row.forced ? ` force=${row.forced}` : ""}${row.from_status ? ` ${row.from_status}->${row.to_status}` : ""}`)
  observed.eventTrail = { forcedDetach: trail(y.id), forcedCorrection: trail(z.id) }
  observed.auditOfForcedCorrection = kit.rows(`select actor_user_id, before_data->>'status' b, after_data->>'status' a from public.audit_log where org_id=${q(kit, org.orgId)} and entity_type='lot' and entity_id=${q(kit, z.id)} and action='update' and before_data->>'status'='developed' and after_data->>'status'='controlled'`).map((row) => ({ by: row.actor_user_id === org.team.land.userId, from: row.b, to: row.a }))
  equal(check, "lot states require the right home association, and every reversal is explicit, authorised and recorded", expected.expected, observed)
  return { orgId: org.orgId }
}


/** A community big enough to outgrow every cap: 1,100 lots, the first 600 developed and the rest controlled (lots written directly: volume, not workflow). */
async function bigCommunity(kit, org) {
  org.bigCommunity ??= (async () => {
    const big = await kit.as(org.owner, () => app("communities").createCommunity({ name: "Big Sky", code: "BIG", divisionId: org.divisionId, status: "active", city: "Naples", state: "FL", postalCode: "34119", plannedLotCount: 1100, targetAbsorptionPerMonth: 3 }))
    kit.sql(`insert into public.lots(org_id, community_id, division_id, lot_number, status, premium_cents)
      select ${q(kit, org.orgId)}, ${q(kit, big.id)}, ${q(kit, org.divisionId)}, 'B-' || n, case when n <= 600 then 'developed' else 'controlled' end, 0 from generate_series(1, 1100) n`)
    return big
  })()
  return org.bigCommunity
}

async function inventoryPagingNeverClaimsATruncatedTotalIsComplete(kit, expected, check) {
  const org = await configOrg(kit)
  const inventory = app("community-inventory"), sales = app("community-sales")
  const big = await bigCommunity(kit, org)
  const oracle = (where = "true") => count(kit, `select id from public.lots where org_id=${q(kit, org.orgId)} and community_id=${q(kit, big.id)} and ${where}`)
  const land = org.team.land
  const page = async (filters) => { const r = await kit.as(land, () => inventory.listCommunityInventory(big.id, filters)); return { rows: r.lots.length, total: r.total, page: r.page, pageSize: r.pageSize, truncated: r.truncated } }
  const observed = {}
  observed.defaultPage = await page({})
  observed.lastFullPage = await page({ page: 11 })
  observed.pastTheEnd = await page({ page: 12 })
  observed.pageAndSizeClamped = await page({ page: 0, pageSize: 0 })
  observed.statusFilter = await page({ status: "developed" })
  observed.statusFilterLastPage = await page({ status: "controlled", page: 5 })
  observed.searchFilter = await page({ search: "B-99" })
  observed.searchOracle = oracle("lot_number ilike '%B-99%'")
  observed.filterWithNoMatch = await page({ status: "closed" })
  // Counts and the phase cross-tab are exact past the read caps.
  observed.statusCounts = await kit.as(land, () => inventory.countCommunityLotsByStatus(big.id))
  observed.statusCountsWithSearch = await kit.as(land, () => inventory.countCommunityLotsByStatus(big.id, { search: "B-1" }))
  observed.statusCountsWithSearchOracle = { developed: oracle("status='developed' and lot_number ilike '%B-1%'"), controlled: oracle("status='controlled' and lot_number ilike '%B-1%'") }
  const phases = await kit.as(land, () => inventory.countLotsByPhase(big.id))
  observed.phaseCounts = { truncated: phases.truncated, unphased: { developed: phases.byPhase.unphased.developed, controlled: phases.byPhase.unphased.controlled } }
  // A select-all bulk edit says when the ids are not all of the matches.
  const select = async (filters) => { const r = await kit.as(land, () => inventory.listCommunityInventoryLotIds(big.id, filters)); return { ids: r.ids.length, total: r.total, capped: r.capped } }
  observed.selectAll = await select({})
  observed.selectAllDeveloped = await select({ status: "developed" })
  observed.selectAllControlled = await select({ status: "controlled" })
  observed.selectAllSmall = await select({ status: "controlled", search: "B-11" })
  observed.selectAllSmallOracle = oracle("status='controlled' and lot_number ilike '%B-11%'")
  // The sales desk's pickers.
  const specs = (opts) => kit.as(org.team.sales, () => sales.listSpecInventoryPage(opts)).then((r) => ({ rows: r.lots.length, truncated: r.truncated }))
  observed.salesInventoryLimit = await specs({ communityId: big.id, includeToBeBuilt: true, limit: 5 })
  observed.salesInventoryAskedForTooMany = await specs({ communityId: big.id, includeToBeBuilt: true, limit: 5000 })
  observed.salesInventoryWhollyShown = await specs({ communityId: org.otherCommunityId, includeToBeBuilt: true })
  const sellable = await kit.as(org.team.sales, () => sales.listSellableLots(big.id))
  observed.sellablePicker = { rows: sellable.lots.length, truncated: sellable.truncated }
  const sellableSmall = await kit.as(org.team.sales, () => sales.listSellableLots(big.id, "B-59"))
  observed.sellablePickerSearch = { rows: sellableSmall.lots.length, truncated: sellableSmall.truncated, oracle: oracle("status in ('owned','developed','assigned','started') and lot_number ilike '%B-59%'") }
  // Another community's lots never count toward this one.
  const otherTotal = (await kit.as(land, () => inventory.listCommunityInventory(org.communityId, {}))).total
  const otherOracle = count(kit, `select id from public.lots where org_id=${q(kit, org.orgId)} and community_id=${q(kit, org.communityId)}`)
  observed.otherCommunityTotalIsItsOwnLots = otherTotal === otherOracle && otherOracle >= 20 && otherOracle < 100
  equal(check, "scoped inventory filters and paging report the true total, flag every truncated page, and never present a capped selection as complete", expected.expected, observed)
  return { orgId: org.orgId, communityId: big.id }
}


async function inventoryMapPageLoadsAtItsDocumentedSize(kit, expected, check) {
  const org = await configOrg(kit)
  const big = await bigCommunity(kit, org)
  const inventory = app("community-inventory")
  const read = async (pageSize) => { try { const r = await kit.as(org.team.land, () => inventory.listCommunityInventory(big.id, { pageSize })); return { rows: r.lots.length, pageSize: r.pageSize, total: r.total, truncated: r.truncated } } catch (error) { return { error: error.message.trim().slice(0, 120) } } }
  const observed = { tablePage: await read(100), midSizedPage: await read(250), mapPage: await read(600), askedForMoreThanTheMapPage: await read(10000) }
  equal(check, "the plat's 600-lot page (and a request for more, clamped to it) loads and reports that 500 lots are still unseen", expected.expected, observed)
  return { orgId: org.orgId, communityId: big.id }
}


// ---------------------------------------------------------------------------
// EP04-07 — spec age

/** A spec home (no buyer): plan pinned on its lot, the package opened and cleared, released, built and billed on the given days, completed on `completeOn` when given. */
async function specHome(kit, org, { release = false, startInDays = 0, billDate = seed.isoDay(7), completeOn = null }) {
  const lotRow = nextLot(org)
  const plan = org.plans[1]
  seed.pinSpecPlan(kit, { lot: lotRow, plan })
  if (!release) {
    const pkg = await kit.as(org.team.starts, () => app("starts").openStartPackage(lotRow.id, { isFinanced: false }))
    return { lotRow, projectId: kit.rows(`select project_id from public.start_packages where id=${q(kit, pkg.id)}`)[0].project_id }
  }
  // The week already carries this community's other releases; the starts desk raises its target for the spec home.
  const start = new Date(`${seed.isoDay(startInDays)}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  await kit.as(org.team.starts, () => app("even-flow").setReleaseSlot(org.communityId, start.toISOString().slice(0, 10), { targetStarts: 10 }))
  const gates = await seed.clearStartGates(kit, org, { lotId: lotRow.id, spec: true })
  await adoptInventory(kit, org, gates.projectId)
  await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: gates.projectId, startInDays, adoptInventory: false })
  await seed.buildHome(kit, org, { projectId: gates.projectId, billDate })
  if (completeOn) await seed.completeHome(kit, org, { projectId: gates.projectId, reserveCents: 650000, date: completeOn })
  return { lotRow, projectId: gates.projectId }
}

async function specAgeStartsAtActualCompletion(kit, expected, check) {
  const org = await configOrg(kit)
  const { specInventoryAge } = require("../../../lib/sales/spec-inventory")
  const salesService = app("community-sales")
  const unfinished = await specHome(kit, org, {})
  // A release cannot be dated in the past, so this home is completed today through the services and the recorded date is then aged 30 days (the clock moving, not the computation).
  const completedLongAgo = await specHome(kit, org, { release: true, completeOn: seed.isoDay(0) })
  kit.sql(`update public.project_financial_settings set books_inventory_completed_on=(current_date - 30) where project_id=${q(kit, completedLongAgo.projectId)}`)
  const completesLater = await specHome(kit, org, { release: true, startInDays: 0 })
  // Seeing the home through to completion in the future: finished on paper but not yet on the day Books recorded.
  await kit.as(org.owner, () => app("books/warranty-accounting").setWarrantyReserveEstimate({ projectId: completesLater.projectId, date: seed.isoDay(14), amountCents: 650000, evidenceUrl: `${seed.EVIDENCE}/warranty-reserve` }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: completesLater.projectId, date: seed.isoDay(14), evidenceUrl: `${seed.EVIDENCE}/completion` }))
  // The schedule's projected end date is long past for every one of them; it must never start a clock.
  for (const home of [unfinished, completedLongAgo, completesLater]) kit.sql(`update public.projects set end_date=${q(kit, seed.isoDay(-200))} where id=${q(kit, home.projectId)}`)
  const listed = await kit.as(org.team.sales, () => salesService.listSpecInventory({ communityId: org.communityId }))
  const row = (home) => listed.find((item) => item.lotId === home.lotRow.id)
  const age = (home) => { const item = row(home); return item ? { isSpec: item.isSpec, completedAtDays: item.completedAt ? Math.round((Date.parse(item.completedAt) - Date.parse(seed.isoDay(0))) / 86400000) : null, underConstruction: item.underConstruction, agingDays: item.agingDays } : "not listed" }
  const recorded = (home) => kit.rows(`select books_inventory_completed_on::text d from public.project_financial_settings where project_id=${q(kit, home.projectId)}`)[0]?.d ?? null
  const observed = {
    unfinished: age(unfinished),
    completedThirtyDaysAgo: age(completedLongAgo),
    completionRecordedForAFutureDay: { ...age(completesLater), recordedInDays: Math.round((Date.parse(recorded(completesLater)) - Date.parse(seed.isoDay(0))) / 86400000) },
    recordedCompletionOfTheUnfinished: recorded(unfinished),
    soldHomesAreNotSpecStock: listed.filter((item) => kit.rows(`select 1 from public.contracts where project_id=${q(kit, item.projectId)} and contract_type='purchase_agreement' and status='active'`).length > 0).length,
  }
  // The pure rule at its edges.
  const now = Date.parse("2026-10-11T15:00:00Z")
  const edge = (project, on) => { const { completedAt, underConstruction, agingDays } = specInventoryAge(project, on, now); return { completedAt, underConstruction, agingDays } }
  observed.rule = {
    completedTenDaysAgo: edge({ status: "completed" }, "2026-10-01"),
    completedToday: edge({ status: "completed" }, "2026-10-11"),
    completedTomorrow: edge({ status: "active" }, "2026-10-12"),
    completedOnPaperNeverRecorded: edge({ status: "completed" }, null),
    underConstructionNoCompletion: edge({ status: "active" }, undefined),
    notADate: edge({ status: "active" }, "soon"),
    noProject: edge(null, "2026-10-01"),
  }
  equal(check, "spec age starts at the recorded actual completion, never a projected date, and an unfinished or future-completed home reports no aging", expected.expected, observed)
  return { orgId: org.orgId }
}

const subcases = {
  "option-rules-inherit-and-reject-contradictions": optionRulesInheritAndRejectContradictions,
  "race-option-rule-authoring": raceOptionRuleAuthoring,
  "preflight-rejects-invalid-effective-configurations": preflightRejectsInvalidEffectiveConfigurations,
  "stored-choices-do-not-adopt-a-new-override": storedChoicesDoNotAdoptNewOverride,
  "price-resolution-is-deterministic-and-fails-explicitly": priceResolutionIsDeterministicAndFailsExplicitly,
  "cutoffs-follow-the-schedule-and-overrides-are-controlled": cutoffsFollowTheScheduleAndOverridesAreControlled,
  "extending-a-swept-cutoff-reopens-the-choices": extendingASweptCutoffReopensTheChoices,
  "lot-states-need-the-home-and-reversals-are-controlled": lotStatesNeedTheHomeAndReversalsAreControlled,
  "inventory-paging-never-claims-a-truncated-total-is-complete": inventoryPagingNeverClaimsATruncatedTotalIsComplete,
  "inventory-map-page-loads-at-its-documented-size": inventoryMapPageLoadsAtItsDocumentedSize,
  "spec-age-starts-at-actual-completion": specAgeStartsAtActualCompletion,
}
module.exports = { subcases }
