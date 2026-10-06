require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { ORG, PACKAGE, ACTOR, buildHarness, succeedingInstantiation, stubModule } = require("./support/starts-harness")
function setup({ count = 1, denied = false, outsideDivision = false } = {}) {
  const h = buildHarness({ packageStatus: "released", instantiate: succeedingInstantiation() })
  h.store.communities[0].division_id = "division"
  h.store.outbox = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1), org_id: ORG, job_type: "start_release_trade_notice", status: "failed",
    payload: { start_package_id: PACKAGE, company_id: `company-${i}`, actor_id: "old-actor", preserved: true },
    retry_count: 3, last_error: "Mail unavailable", run_at: "2026-01-01T00:00:00Z",
  }))
  h.store.companies = Array.from({ length: count }, (_, i) => ({ id: `company-${i}`, org_id: ORG, name: `Trade ${i}` }))
  stubModule("@/lib/services/permissions", { requirePermission: async () => { if (denied) throw new Error("Forbidden") }, getCurrentUserPermissions: async () => ({ permissions: ["*"] }) })
  stubModule("@/lib/services/authorization", { getDivisionAccessForUser: async () => ({ assignedOnly: true, divisionIds: outsideDivision ? ["other"] : ["division"] }), getDivisionScopedProjectIds: async () => null })
  // Fake Supabase keeps embedded filter fields literal, so model the lot lens.
  h.store.start_packages[0]["lot.division_id"] = "division"
  const reads = [], from = h.supabase.from.bind(h.supabase)
  h.supabase.from = (table) => {
    const q = from(table), run = q.run.bind(q), inQuery = q.in.bind(q)
    q.in = (key, ids) => { if (table === "companies") assert.ok(ids.length <= 100); return inQuery(key, ids) }
    q.run = () => { reads.push({ table, action: q.action, range: q.rangeValue }); return run() }
    return q
  }
  delete require.cache[require.resolve("@/lib/services/starts")]
  return { ...h, reads, service: require("@/lib/services/starts") }
}
test("coordinator retries only the failed notice, preserving the released home and payload", async () => {
  const h = setup()
  await h.service.retryStartTradeNotice(PACKAGE, "1")
  const notice = h.store.outbox[0]
  assert.equal(notice.status, "pending")
  assert.equal(notice.retry_count, 0)
  assert.equal(notice.last_error, null)
  assert.equal(notice.payload.actor_id, ACTOR)
  assert.equal(notice.payload.preserved, true)
  assert.equal(h.store.start_packages[0].status, "released")
  assert.equal(h.calls.instantiate.length, 0)
  assert.equal(h.calls.events[0].eventType, "start.trade_notice_retried")
})
test("notice retry checks permission and division before writes", async () => {
  for (const options of [{ denied: true }, { outsideDivision: true }]) {
    const h = setup(options)
    await assert.rejects(h.service.retryStartTradeNotice(PACKAGE, "1"), /Forbidden|division access/)
    assert.equal(h.store.outbox[0].status, "failed")
    assert.ok(!h.reads.some(read => read.action === "update"))
  }
})
test("retry refuses foreign organizations, packages, job types and active or completed notices", async () => {
  for (const patch of [{ org_id: "foreign" }, { payload: { start_package_id: "other" } }, { job_type: "start_release" }, { status: "pending" }, { status: "processing" }, { status: "completed" }]) {
    const h = setup(); Object.assign(h.store.outbox[0], patch)
    await assert.rejects(h.service.retryStartTradeNotice(PACKAGE, "1"), /not found|Only failed/)
    assert.ok(!h.reads.some(read => read.action === "update"))
  }
  const h = setup(); h.store.start_packages[0].status = "attention"
  await assert.rejects(h.service.retryStartTradeNotice(PACKAGE, "1"), /Only released/)
})
test("competing retry and failed update cannot report successful recovery", async () => {
  for (const concurrent of [true, false]) {
    const h = setup(), from = h.supabase.from.bind(h.supabase)
    h.supabase.from = table => {
      const q = from(table), run = q.run.bind(q)
      q.run = () => {
        if (table === "outbox" && q.action === "update") {
          if (concurrent) h.store.outbox[0].status = "pending"
          else return { data: null, error: { message: "offline" } }
        }
        return run()
      }
      return q
    }
    await assert.rejects(h.service.retryStartTradeNotice(PACKAGE, "1"), /state changed|offline/)
    assert.equal(h.calls.events.length, 0)
  }
})
test("start detail includes every notice and bounded company names beyond a database page", async () => {
  const h = setup({ count: 1001 })
  // The fake client does not materialize PostgREST joins. Supply the embedded
  // definition returned by loadGateRows before exercising the detail mapper.
  for (const gate of h.store.start_package_gates) {
    gate.definition = h.store.start_gate_definitions.find(definition => definition.id === gate.gate_definition_id)
  }
  const detail = await h.service.getStartPackage(PACKAGE)
  assert.equal(detail.tradeNotices.length, 1001)
  assert.equal(detail.tradeNotices.find(notice => notice.id === "1001").companyName, "Trade 1000")
  assert.ok(h.reads.some(read => read.table === "outbox" && read.range?.[0] === 1000))
})
test("notice queue read failures are surfaced instead of an empty delivery panel", async () => {
  const h = setup(), from = h.supabase.from.bind(h.supabase)
  h.supabase.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => table === "outbox" && q.action === "select" ? { data: null, error: { message: "offline" } } : run()
    return q
  }
  await assert.rejects(h.service.getStartPackage(PACKAGE), /offline/)
})

test("all existing package mutation paths refuse a package outside the actor's division", async () => {
  const operations = [
    service => service.updateStartPackage(PACKAGE, { notes: "test" }),
    service => service.refreshAutoGates(PACKAGE),
    service => service.attestGate(PACKAGE, "gate", {}),
    service => service.reopenGate(PACKAGE, "gate"),
    service => service.releaseStart(PACKAGE, { scheduledStartDate: new Date().toISOString().slice(0, 10) }),
    service => service.retryRelease(PACKAGE),
    service => service.cancelRelease(PACKAGE),
    service => service.cancelStartPackage(PACKAGE, { reason: "No longer needed for construction" }),
  ]
  for (const operation of operations) {
    const h = setup({ outsideDivision: true })
    await assert.rejects(operation(h.service), /division access/)
    assert.ok(!h.reads.some(read => ["update", "insert", "upsert", "delete"].includes(read.action)))
  }
})
test("opening a start checks community and lot division before seeding or creating records", async () => {
  for (const outsideDivision of [true, false]) {
    const h = setup({ outsideDivision })
    h.store.lots[0].division_id = "hidden"
    await assert.rejects(h.service.openStartPackage(h.store.lots[0].id, {}), /division access/)
    assert.ok(!h.reads.some(read => ["update", "insert", "upsert", "delete"].includes(read.action)))
    assert.equal(h.calls.projects.length, 0)
  }
})
