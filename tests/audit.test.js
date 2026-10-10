const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

const logged = []
stubModule("@/lib/logging/logger", {
  logger: { error: (event, context) => logged.push({ event, context }), warn() {}, info() {}, debug() {} },
})
stubModule("@/lib/observability/after-response", { afterResponse: () => {} })

const { recordAudit } = freshRequire("lib/services/audit.ts")

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
