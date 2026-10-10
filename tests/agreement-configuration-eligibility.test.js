require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const test = require("node:test")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ORG = id(1), LOT = id(2), COMMUNITY = id(3), PLAN = id(4), VERSION = id(5), ELEVATION = id(6), HOME = id(7), DIVISION = id(8)

function harness({ lot = {}, version = {}, elevation = {}, offer = {}, assignedOnly = false, divisions = [DIVISION], homeDenied = false, resolved = [], failure = null, openCount = 0, linkedContract = null, insertConflict = false, writeFailure = null, missingWrite = null, versionRows = null, elevationRows = null, incentiveRows = [], rowCap = 1000, lateFailure = null, selectionOptions = [], selectionPackages = [], atomic = false, durable = true, savedReceipt = null, receiptError = false, signingFailure = false, catalogRevisions = ["1", "1"], capacityRows = [] } = {}) {
  const calls = [], authorizations = [], writes = [], receiptCalls = [], signingCalls = [], logs = []
  const today = new Date().toISOString().slice(0, 10)
  const tables = {
    selection_options: selectionOptions, selection_packages: selectionPackages,
    lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, project_id: HOME, premium_cents: 1000, house_plan_id: PLAN, house_plan_version_id: VERSION, house_plan_elevation_id: ELEVATION, swing: "left", ...lot }],
    communities: [{ id: COMMUNITY, org_id: ORG, division_id: DIVISION }],
    house_plan_versions: [{ id: VERSION, org_id: ORG, house_plan_id: PLAN, status: "released", plan: { name: "Oak", org_id: ORG }, ...version }],
    house_plan_elevations: [{ id: ELEVATION, org_id: ORG, house_plan_id: PLAN, is_active: true, name: "Brick", code: "B", ...elevation }],
    community_plan_availability: [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, elevation_id: ELEVATION, is_available: true, effective_start: null, effective_end: null, base_price_cents: 30000000, ...offer }],
  }
  if (versionRows) tables.house_plan_versions = versionRows
  if (elevationRows) tables.house_plan_elevations = elevationRows
  tables.incentives = incentiveRows
  tables.agreement_incentive_capacity = capacityRows
  tables.lot_reservations = [{ id: id(11), org_id: ORG, status: "reserved", community_id: COMMUNITY, buyer_contact_id: id(20), co_buyer_contact_id: null, deposit_invoice_id: null, contract_id: linkedContract, lot_id: LOT, lot: tables.lots[0] }]
  if (savedReceipt) tables.contracts = [savedReceipt.contract]
  const supabase = { from(table) {
    let rows = tables[table] ?? [], inserting = false, pageLimit = 1000, cursor = null
    calls.push(table)
    const query = {
      select() { return query },
      contains() { return query },
      order(key) { rows = [...rows].sort((a,b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0); return query },
      limit(value) { pageLimit = value; return query },
      gt(key,value) { cursor = value; rows = rows.filter(row => row[key] > value); return query },
      insert(payload) { writes.push(payload); inserting = true; return query },
      update() { return query },
      async single() { if (inserting && insertConflict) return { data: null, error: { code: "23505", message: insertConflict === "number" ? "duplicate agreement number" : "contracts_open_purchase_agreement_home_unique" } }; return { data: inserting ? { id: id(12), project_id: HOME, total_cents: 30001000 } : missingWrite === table ? null : rows[0], error: writeFailure === table ? { message: "write failed" } : null } },
      eq(key, value) { rows = rows.filter(row => key.split('.').reduce((v,k) => v?.[k], row) === value); return query },
      is(key, value) { rows = rows.filter(row => row[key] === value); return query },
      in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query },
      or(expression) {
        if (expression.startsWith("community_id")) { rows = rows.filter(row => row.community_id === null || row.community_id === COMMUNITY); return query }
        // Evaluate PostgREST's actual inclusive date predicate rather than ignore the filter.
        const groups = [...expression.matchAll(/and\(([^)]+)\)/g)].map(match => match[1].split(','))
        assert.equal(groups.length, 4)
        rows = rows.filter(row => groups.some(group => group.every(predicate => {
          const [key, operator, value] = predicate.split('.')
          if (operator === 'is') return value === 'null' && row[key] === null
          assert.equal(value, today)
          return row[key] !== null && (operator === 'lte' ? row[key] <= value : operator === 'gte' && row[key] >= value)
        })))
        return query
      },
      async maybeSingle() { return { data: rows.length === 1 ? rows[0] : null, error: failure === table ? { message: "read failed" } : rows.length > 1 ? { message: "multiple rows" } : null } },
      then(resolve, reject) { return Promise.resolve({ data: rows.slice(0,Math.min(pageLimit,rowCap)), count: table === "contracts" ? openCount : null, error: failure === table || (lateFailure === table && cursor) ? { message: "lookup failed" } : null }).then(resolve,reject) },
    }
    return query
  } }
  const compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/community-sales.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports,
    process: { env: { ARC_AGREEMENT_ATOMIC_CREATION_ENABLED: atomic ? "true" : "false", ARC_AGREEMENT_DURABLE_SIGNING_ENABLED: durable ? "true" : "false", DOCUMENT_SIGNING_SECRET: "test-only" } },
    require(name) {
      if (name === "@/lib/services/agreement-catalog-revision") return { readAgreementCatalogRevision: async () => { calls.push("catalog_revision"); return catalogRevisions.length > 1 ? catalogRevisions.shift() : catalogRevisions[0] } }
      if (name === "@/lib/logging/logger") return { logger: { warn: (...args) => logs.push(args) } }
      if (name === "@/lib/services/agreement-creation") return {
        agreementCreationExpected: require("../lib/services/agreement-creation").agreementCreationExpected,
        saveAgreementCreation: async payload => {
          receiptCalls.push(payload)
          if (receiptError) throw new Error("Creation receipt unavailable")
          if (savedReceipt) return savedReceipt
          if (!payload.snapshot) return null
          const contract = { id: id(12), org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "draft", total_cents: payload.snapshot.purchase_agreement.pricing.totalCents, snapshot: payload.snapshot, buyer_contact_id: id(20), co_buyer_contact_id: null }
          tables.contracts = [contract]
          savedReceipt = { receipt_id: id(21), created: true, contract }
          return savedReceipt
        },
      }
      if (name === "@/lib/storage/files-storage") return { getFilesStorageProvider: () => "r2" }
      if (name === "@/lib/services/agreement-signing-ownership") return {
        reserveAgreementSigningDocument: async payload => { signingCalls.push(payload); if (signingFailure) throw new Error("Signing source unavailable"); return { id: id(22), source_file_id: id(23) } },
        publishOwnedAgreementDocument: async () => ({ documentId: id(22), envelopeId: id(24), reason: "Buyer invitations are queued for delivery" }),
      }
      if (name === "@/lib/land/paging") return require("../lib/land/paging")
      if (name === "@/lib/sales/agreement-quote") return require("../lib/sales/agreement-quote")
      if (name === "@/lib/sales/agreement-selections") return require("../lib/sales/agreement-selections")
      if (name === "zod") return require("zod")
      if (name === "@/lib/validation/community-sales") return require("../lib/validation/community-sales")
      if (name === "@/lib/financials/purchase-agreement-pricing") return require("../lib/financials/purchase-agreement-pricing")
      if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ orgId: ORG, userId: id(9), supabase }) }
      if (name === "@/lib/services/permissions") return { requirePermission: async () => {} }
      if (name === "@/lib/services/authorization") return {
        getDivisionAccessForUser: async () => ({ assignedOnly, divisionIds: divisions }),
        requireAuthorization: async args => { authorizations.push(args); if (homeDenied) throw new Error("Home access denied") },
      }
      if (name === "@/lib/services/option-catalog") return { resolveOptionPricing: async () => resolved, listCatalog: async () => ({ categories: [], packages: [] }) }
      if (name === "@/lib/services/configuration-rules") return { assertSalesConfiguration: async () => {} }
      return {}
    },
  })
  return { price: compiled.exports.priceAgreementDraft, service: compiled.exports, calls, authorizations, writes, receiptCalls, signingCalls, logs }
}
const input = { expectedQuoteHash: "a".repeat(64), lotId: LOT, optionItems: [], incentiveIds: [] }

test("agreement quote authorizes the actual home and preserves its configured labels, swing and cents", async () => {
  const { price, authorizations } = harness()
  const result = await price(input)
  assert.equal(authorizations[0].projectId, HOME)
  assert.equal(authorizations[0].permission, "sales.read")
  assert.equal(result.elevationLabel, "Brick")
  assert.equal(result.swing, "left")
  assert.equal(result.basePriceCents, 30000000)
})

test("division and home denials stop before catalog pricing", async () => {
  for (const settings of [{ assignedOnly: true, divisions: [] }, { homeDenied: true }]) {
    const { price, calls } = harness(settings)
    await assert.rejects(price(input), /Community not found|Home access denied/)
    assert.ok(!calls.includes("community_plan_availability"))
  }
})

test("pinned version, elevation, ancestry and fixed swing cannot be changed", async () => {
  for (const patch of [{ housePlanVersionId: id(10) }, { elevationId: id(10) }, { elevationId: null }, { swing: "right" }]) {
    await assert.rejects(harness().price({ ...input, ...patch }), /pinned|only supports/)
  }
  await assert.rejects(harness({ version: { house_plan_id: id(10) } }).price(input), /ancestry/)
})

test("unreleased or foreign versions and inactive or foreign-plan elevations are rejected", async () => {
  for (const version of [{ status: "draft" }, { plan: { org_id: id(10) } }]) {
    await assert.rejects(harness({ version }).price(input), /not released/)
  }
  for (const elevation of [{ is_active: false }, { house_plan_id: id(10) }, { org_id: id(10) }]) {
    await assert.rejects(harness({ elevation }).price(input), /inactive|belong/)
  }
})

test("flexible lots require an explicit swing and base elevation is explicit", async () => {
  const settings = { lot: { project_id: null, swing: "either" }, offer: { elevation_id: null } }
  await assert.rejects(harness(settings).price({ ...input, elevationId: null }), /Choose a left or right/)
  const result = await harness(settings).price({ ...input, elevationId: null, swing: "right" })
  assert.equal(result.swing, "right")
  assert.equal(result.elevationId, null)
  assert.equal(result.elevationLabel, null)
})

test("community pricing honors open and inclusive date bounds and fails closed on lookup errors", async () => {
  const today = new Date().toISOString().slice(0, 10)
  for (const offer of [{}, { effective_start: today }, { effective_end: today }, { effective_start: today, effective_end: today }]) {
    await harness({ offer }).price(input)
  }
  for (const offer of [{ effective_start: "9999-01-01" }, { effective_end: "2000-01-01" }, { is_available: false }]) {
    await assert.rejects(harness({ offer }).price(input), /not available/)
  }
  await assert.rejects(harness({ failure: "community_plan_availability" }).price(input), /read failed/)
})

test("incomplete option resolution cannot produce a partial agreement quote", async () => {
  await assert.rejects(harness().price({ ...input, optionItems: [{ optionId: id(10) }] }), /fully priced/)
})

test("agreement bootstrap and creation enforce actual-home management permission", async () => {
  for (const operation of ["getAgreementDraftContext", "createPurchaseAgreement"]) {
    const { service, calls, authorizations, writes } = harness({ homeDenied: true })
    const arg = operation === "getAgreementDraftContext" ? id(11) : { ...input, reservationId: id(11) }
    await assert.rejects(service[operation](arg), /Home access denied/)
    assert.equal(authorizations[0].permission, "sales.manage")
    assert.equal(authorizations[0].projectId, HOME)
    assert.ok(!calls.includes("contracts"))
    assert.ok(!calls.includes("house_plan_versions"))
  }
})

test("linked, existing and unverifiable agreements block duplicate creation before repricing", async () => {
  for (const settings of [{ linkedContract: id(12) }, { openCount: 1 }, { openCount: 2 }, { openCount: null }, { failure: "contracts" }]) {
    const { service, calls } = harness(settings)
    await assert.rejects(service.createPurchaseAgreement({ ...input, reservationId: id(11) }), /already|could not be verified/)
    assert.ok(!calls.includes("house_plan_versions"))
  }
})

test("database ownership conflict cannot be reported as a newly created agreement", async () => {
  for (const insertConflict of [true,"number"]) {
    const h = harness({ insertConflict })
    const quote = await h.price(input)
    await assert.rejects(h.service.createPurchaseAgreement({ ...input, expectedQuoteHash: quote.quoteHash, reservationId: id(11) }), insertConflict === true ? /already owns this home/ : /Failed to create purchase agreement: duplicate agreement number/)
  }
})

test("partial reservation or lot writes stop before signature preparation", async () => {
  for (const settings of [{ writeFailure: "lot_reservations" }, { missingWrite: "lot_reservations" }, { writeFailure: "lots" }, { missingWrite: "lots" }]) {
    const h = harness(settings), quote = await h.price(input)
    await assert.rejects(h.service.createPurchaseAgreement({ ...input, expectedQuoteHash: quote.quoteHash, reservationId: id(11) }), /saved but.*could not be recorded/)
  }
})

test("agreement setup exhausts short plan/elevation/incentive pages and restores display order", async () => {
  const versionRows = Array.from({ length: 7 }, (_,i) => ({ id: id(1000+i), org_id: ORG, house_plan_id: PLAN, status: "released", label: `Version ${i}`, released_at: `2026-09-${String(i+1).padStart(2,"0")}` }))
  const elevationRows = Array.from({ length: 7 }, (_,i) => ({ id: id(2000+i), org_id: ORG, house_plan_id: PLAN, is_active: true, name: `Elevation ${6-i}` }))
  const incentiveRows = Array.from({ length: 7 }, (_,i) => ({ id: id(3000+i), org_id: ORG, community_id: COMMUNITY, status: "active", created_at: `2026-09-${String(i+1).padStart(2,"0")}`, name: `Credit ${i}`, incentive_type: "fixed_amount", applies_to: "price", amount_cents: 1000 }))
  const { service } = harness({ versionRows, elevationRows, incentiveRows, rowCap: 2, lot: { house_plan_version_id: id(1005), house_plan_elevation_id: id(2006) } })
  const result = await service.getAgreementDraftContext(id(11))
  assert.equal(result.versions.length,7)
  assert.equal(result.versions[0].label,"Version 6")
  assert.equal(result.elevations.length,7)
  assert.equal(result.elevations[0].label,"Elevation 0")
  assert.equal(result.incentives.length,7)
  assert.equal(result.incentives[0].name,"Credit 6")
  assert.equal(result.pinnedVersionId,id(1005))
  assert.equal(result.pinnedElevationId,id(2006))
})

test("agreement setup rejects failed reads and missing pinned choices instead of showing empty lists", async () => {
  for (const failure of ["lot_reservations","house_plan_versions","house_plan_elevations","incentives"]) {
    await assert.rejects(harness({ failure }).service.getAgreementDraftContext(id(11)), /not found|lookup failed/)
  }
  for (const lot of [{ house_plan_version_id: id(99) }, { house_plan_elevation_id: id(99) }]) {
    await assert.rejects(harness({ lot }).service.getAgreementDraftContext(id(11)), /pinned/)
  }
})

test("a missing exact incentive usage count cannot restore an exhausted offer", async () => {
  const incentiveRows = [{ id: id(20), org_id: ORG, community_id: COMMUNITY, status: "active", max_uses: 1 }]
  await assert.rejects(harness({ incentiveRows, openCount: null }).service.listIncentives({ communityId: COMMUNITY }), /Exact usage count unavailable/)
})

test("quoted choice amounts retain the requested identity when community resolution substitutes an option", async () => {
  const resolved = [{ optionId: id(21), categoryId: id(22), categoryIds: [id(22)], available: true, priceCents: 2200, source: "plan_community" }]
  const selectionOptions = [{ id: id(21), org_id: ORG, name: "Community finish", option_scope: "structural", category: { name: "Exterior" } }]
  const result = await harness({ resolved, selectionOptions }).price({ ...input, optionItems: [{ optionId: id(20) }] })
  assert.equal(result.choicePrices[0].optionId,id(20))
  assert.equal(result.choicePrices[0].priceCents,2200)
  assert.equal(result.structuralOptions[0].optionId,id(21))
  assert.equal(result.structuralOptions[0].label,"Community finish")
})

test("missing, truncated or failed option metadata cannot produce mislabeled agreement lines", async () => {
  const resolved = [{ optionId: id(21), available: true, priceCents: 2200, source: "plan" }]
  for (const settings of [{}, { selectionOptions: [{ id: id(21), org_id: ORG }] }, { selectionOptions: [{ id: id(21), org_id: ORG, name: "Finish", option_scope: "unknown" }] }, { selectionOptions: [{ id: id(21), org_id: ORG }], failure: "selection_options" }]) {
    await assert.rejects(harness({ resolved,...settings }).price({ ...input, optionItems: [{ optionId: id(20) }] }), /names and categories/)
  }
})

test("creation rejects changed reviewed economics before inserting a contract", async () => {
  const reviewed = await harness().price(input)
  const current = harness({ offer: { base_price_cents: 30001000 } })
  await assert.rejects(current.service.createPurchaseAgreement({ ...input, reservationId: id(11), expectedQuoteHash: reviewed.quoteHash }), error => error.code === "AGREEMENT_QUOTE_CHANGED")
  assert.equal(current.writes.length,0)
  await assert.rejects(current.service.createPurchaseAgreement({ ...input, reservationId: id(11), expectedQuoteHash: undefined }))
  assert.equal(current.writes.length,0)
})


test("atomic creation commits through the receipt RPC and separately reports signing preparation", async () => {
 for (const signingFailure of [false,true]) {
  const h=harness({atomic:true,signingFailure}),quote=await h.price(input)
  const result=await h.service.createPurchaseAgreement({...input,expectedQuoteHash:quote.quoteHash,reservationId:id(11)})
  assert.equal(result.creationReceiptId,id(21));assert.equal(result.recovered,false)
  assert.equal(h.receiptCalls.length,2);assert.ok(h.receiptCalls[1].snapshot)
  assert.equal(h.writes.length,0,'legacy insert/update path is not used')
  assert.equal(result.total_cents,quote.totalCents)
  if(signingFailure){assert.equal(h.logs.length,1);assert.equal(h.logs[0][1].contractId,id(12));assert.equal(result.signing.documentId,null);assert.match(result.signing.reason,/agreement was saved.*could not be confirmed/i)}
  else {assert.equal(result.signing.documentId,id(22));assert.match(result.signing.reason,/queued/)}
 }
})
test("atomic replay recovers the original agreement before current catalog repricing", async () => {
 const quote=await harness().price(input),savedReceipt={receipt_id:id(21),created:false,contract:{id:id(12),org_id:ORG,project_id:HOME,contract_type:'purchase_agreement',status:'active',total_cents:quote.totalCents,snapshot:{purchase_agreement:{pricing:quote}},buyer_contact_id:id(20),co_buyer_contact_id:null}}
 const h=harness({atomic:true,savedReceipt,offer:{base_price_cents:50000000},linkedContract:id(12)})
 const result=await h.service.createPurchaseAgreement({...input,expectedQuoteHash:quote.quoteHash,reservationId:id(11)})
 assert.equal(result.id,id(12));assert.equal(result.recovered,true);assert.equal(result.pricing.totalCents,quote.totalCents)
 assert.equal(h.receiptCalls.length,1);assert.equal(h.signingCalls.length,0);assert.equal(h.writes.length,0)
 assert.ok(!h.calls.includes('house_plan_versions')&&!h.calls.includes('community_plan_availability'))
 assert.equal(h.authorizations[0].projectId,HOME)
})
test("atomic receipt failures, disabled recovery and changed quotes never fall back to legacy writes", async () => {
 for(const settings of [{receiptError:true},{durable:false},{homeDenied:true}]){
  const h=harness({atomic:true,...settings});await assert.rejects(h.service.createPurchaseAgreement({...input,reservationId:id(11)}))
  assert.equal(h.writes.length,0);assert.equal(h.signingCalls.length,0)
 }
 const h=harness({atomic:true});await assert.rejects(h.service.createPurchaseAgreement({...input,reservationId:id(11)}),error=>error.code==='AGREEMENT_QUOTE_CHANGED')
 assert.equal(h.receiptCalls.length,1);assert.equal(h.writes.length,0);assert.equal(h.signingCalls.length,0)
})
test("a quote cannot mix catalog revisions or commit without its reviewed revision", async () => {
 const changing=harness({atomic:true,catalogRevisions:['1','2']})
 await assert.rejects(changing.price(input),error=>error.code==='AGREEMENT_QUOTE_CHANGED')
 const first=harness({atomic:true,catalogRevisions:['1','1']}),second=harness({atomic:true,catalogRevisions:['2','2']})
 const [a,b]=await Promise.all([first.price(input),second.price(input)])
 assert.equal(a.totalCents,b.totalCents);assert.notEqual(a.quoteHash,b.quoteHash,'catalog content changes require new review even when the total is unchanged')
 const h=harness({atomic:true}),quote=await h.price(input)
 await h.service.createPurchaseAgreement({...input,expectedQuoteHash:quote.quoteHash,reservationId:id(11)})
 assert.equal(h.receiptCalls[1].expected.catalog_revision,'1')
 assert.equal(h.receiptCalls[1].snapshot.purchase_agreement.pricing.catalogRevision,'1')
 const legacy=harness();assert.equal((await legacy.price(input)).catalogRevision,null);assert.ok(!legacy.calls.includes('catalog_revision'))
})

 test('atomic incentives use bounded draft-inclusive capacity and reject incomplete or malformed counts',async()=>{
  const incentiveRows=Array.from({length:701},(_,n)=>({id:id(5000+n),org_id:ORG,community_id:COMMUNITY,status:'active',max_uses:2,requires_approval:false}))
  const capacityRows=incentiveRows.map(row=>({org_id:ORG,incentive_id:row.id,used_count:'1'}))
  const h=harness({atomic:true,incentiveRows,capacityRows})
  const rows=await h.service.listIncentives({communityId:COMMUNITY})
  assert.equal(rows.length,701);assert.ok(rows.every(row=>row.used_count===1&&row.eligible))
  assert.equal(h.calls.filter(table=>table==='agreement_incentive_capacity').length,2)
  assert.equal(h.calls.filter(table=>table==='contracts').length,0)
  for(const capacityRows of [[],[{org_id:ORG,incentive_id:incentiveRows[0].id,used_count:-1}],[{org_id:ORG,incentive_id:incentiveRows[0].id,used_count:'9007199254740992'}]]){
   await assert.rejects(harness({atomic:true,incentiveRows:incentiveRows.slice(0,1),capacityRows}).service.listIncentives({communityId:COMMUNITY}),/capacity/)
  }
 })
