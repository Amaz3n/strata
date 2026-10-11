const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { asRole, createDatabase, insert, seedMember, setRequestHeaders } = require("./support/pglite")

const logged = []
stubModule("@/lib/logging/logger", {
  logger: { error: (event, context) => logged.push({ event, context }), warn() {}, info() {}, debug() {} },
})
stubModule("@/lib/observability/after-response", { afterResponse: () => {} })

const { AUDIT_RETRY_JOB_TYPE, recordAudit, writeDeferredAudit } = freshRequire("lib/services/audit.ts")
const { withCorrelation } = require("@/lib/observability/correlation")

const BILL = "00000000-0000-4000-8000-000000000101"
const approval = { orgId: ORG, action: "update", entityType: "vendor_bill", entityId: BILL, after: { status: "approved" } }

test("a failed audit insert is reported to the error pipeline without its snapshots", async () => {
  logged.length = 0
  const service = createServiceHarness({ tables: { audit_log: [] } })
  service.tamper("audit_log", replies.error("permission denied"), { on: "insert" })

  await service.run(() =>
    recordAudit({ orgId: ORG, action: "update", entityType: "vendor_bill", entityId: "bill-1", after: { amount_cents: 1 } }),
  )

  assert.equal(logged.length, 1)
  assert.equal(logged[0].event, "audit.record_failed")
  assert.equal(logged[0].context.entityType, "vendor_bill")
  assert.equal(logged[0].context.error.message, "permission denied")
  assert.equal(JSON.stringify(logged[0].context).includes("amount_cents"), false)
})

test("an ordinary audit failure never fails the mutation it describes", async () => {
  const service = createServiceHarness({ tables: { audit_log: [], outbox: [] } })
  service.tamper("audit_log", replies.error("permission denied"), { on: "insert" })

  await service.run(() => recordAudit(approval))

  assert.deepEqual(service.db.outbox, [])
})

test("a critical audit that cannot be written is refused, reported and queued for retry", async () => {
  logged.length = 0
  const service = createServiceHarness({ tables: { audit_log: [], outbox: [] } })
  service.tamper("audit_log", replies.error("connection reset"), { on: "insert" })

  await assert.rejects(
    service.run(() => withCorrelation("req-7", () => recordAudit({ ...approval, critical: true }))),
    (error) => error.code === "AUDIT_RECORD_PENDING" && /saved, but its audit record is still pending/.test(error.message),
  )

  assert.equal(service.queries.filter((query) => query.table === "audit_log").length, 2, "retried once inline")
  assert.equal(logged.at(-1).event, "audit.record_failed")
  assert.equal(service.db.outbox.length, 1)
  const [job] = service.db.outbox
  assert.equal(job.job_type, AUDIT_RETRY_JOB_TYPE)
  assert.deepEqual(
    { entity: job.payload.row.entity_id, actor: job.payload.row.actor_user_id, after: job.payload.row.after_data, correlation: job.payload.row.correlation_id },
    { entity: BILL, actor: ACTOR, after: { status: "approved" }, correlation: "req-7" },
  )

  // The queued job writes the row exactly as the mutation would have.
  const healthy = createServiceHarness({ tables: { audit_log: [] } })
  await healthy.run(() => writeDeferredAudit(ORG, job.payload))
  assert.equal(healthy.db.audit_log[0].entity_id, BILL)
  assert.equal(healthy.db.audit_log[0].correlation_id, "req-7")
  await assert.rejects(healthy.run(() => writeDeferredAudit("00000000-0000-4000-8000-000000000999", job.payload)), /another organization/)
})

test("a critical audit that succeeds on its retry is not escalated", async () => {
  const service = createServiceHarness({ tables: { audit_log: [], outbox: [] } })
  service.tamper("audit_log", replies.error("connection reset"), { on: "insert", times: 1 })

  await service.run(() => recordAudit({ ...approval, critical: true }))

  assert.equal(service.queries.filter((query) => query.table === "audit_log").length, 2)
  assert.deepEqual(service.db.outbox, [])
})

test("audit rows carry the correlation id of the unit of work that wrote them", async () => {
  const service = createServiceHarness({ tables: { audit_log: [] } })

  await service.run(() => withCorrelation("outbox:42", () => recordAudit(approval)))

  assert.equal(service.db.audit_log[0].correlation_id, "outbox:42")
})

test("an audit row written inside the database takes its correlation id from the request header", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)

  await setRequestHeaders(db, { "x-correlation-id": "req-db-1" })
  const correlated = await insert(db, "audit_log", { org_id: owner.orgId, action: "update", entity_type: "budget" })
  await setRequestHeaders(db, {})
  const uncorrelated = await insert(db, "audit_log", { org_id: owner.orgId, action: "update", entity_type: "budget" })

  assert.equal(correlated.correlation_id, "req-db-1")
  assert.equal(uncorrelated.correlation_id, null)
})

test("only audit readers see the org's history; a member sees only the rows they wrote", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const member = await seedMember(db, { orgId: owner.orgId, role: "org_viewer" })
  for (const actor of [owner.userId, member.userId]) {
    await insert(db, "audit_log", { org_id: owner.orgId, actor_user_id: actor, action: "update", entity_type: "budget" })
  }

  const visibleTo = async (userId) => {
    const { rows } = await asRole(db, { role: "authenticated", userId }, (tx) =>
      tx.query("select actor_user_id from audit_log order by actor_user_id"),
    )
    return rows.map((row) => row.actor_user_id)
  }

  assert.deepEqual(await visibleTo(owner.userId), [owner.userId, member.userId].sort())
  assert.deepEqual(await visibleTo(member.userId), [member.userId])
})
