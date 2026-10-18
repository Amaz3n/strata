const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { asRole, createDatabase, insert, rpc, seedMember, setRequestHeaders, uuid } = require("./support/pglite")

const logged = []
stubModule("@/lib/logging/logger", {
  logger: { error: (event, context) => logged.push({ event, context }), warn() {}, info() {}, debug() {} },
})
stubModule("@/lib/observability/after-response", { afterResponse: () => {} })

const { AUDIT_RETRY_JOB_TYPE, AuditRecordPendingError, recordAudit, writeDeferredAudit } = freshRequire("lib/services/audit.ts")
const { withCorrelation } = require("@/lib/observability/correlation")

// A pay application calls into the invoice's critical mutations; the invoice
// service stands in so a test can make its audit row pend after it committed.
const invoiceCalls = []
stubModule("@/lib/services/invoices", {
  createInvoice: async () => {
    throw new Error("not used")
  },
  runInvoiceIssuance: async () => {},
  issueInvoice: async (input) => {
    invoiceCalls.push({ issue: input.invoiceId })
    throw new AuditRecordPendingError(true)
  },
  voidInvoice: async (input) => {
    invoiceCalls.push({ void: input.invoiceId })
    throw new AuditRecordPendingError(true)
  },
})
const { sendPayApplication, voidPayApplication } = freshRequire("lib/services/pay-applications.ts")
const { exportOrgAuditEvidence } = freshRequire("lib/services/audit-export.ts")
const { buildAuditExportCsv, verifyAuditExport } = require("@/lib/audit/export-format")

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

test("a deferred audit row is written only as recordAudit queues it", async () => {
  const row = {
    org_id: ORG,
    actor_user_id: ACTOR,
    action: "update",
    entity_type: "vendor_bill",
    entity_id: BILL,
    before_data: null,
    after_data: { status: "approved" },
    source: null,
    correlation_id: "req-9",
    created_at: new Date().toISOString(),
  }
  const healthy = createServiceHarness({ tables: { audit_log: [] } })

  await assert.rejects(healthy.run(() => writeDeferredAudit(ORG, { row: { ...row, id: 1 } })))
  await assert.rejects(healthy.run(() => writeDeferredAudit(ORG, { row: { ...row, created_at: undefined } })))
  await assert.rejects(
    healthy.run(() => writeDeferredAudit(ORG, { row: { ...row, created_at: new Date(Date.now() + 3_600_000).toISOString() } })),
    /dated in the future/,
  )
  assert.deepEqual(healthy.db.audit_log, [])

  await healthy.run(() => writeDeferredAudit(ORG, { row }))
  assert.equal(healthy.db.audit_log.length, 1)
})

test("only the server can queue, change or remove a deferred audit row", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const forged = { row: { org_id: owner.orgId, actor_user_id: owner.userId, action: "update", entity_type: "vendor_bill" } }

  const asMember = (sql, params) =>
    asRole(db, { role: "authenticated", userId: owner.userId }, (tx) => tx.query(sql, params))

  await assert.rejects(
    asMember("insert into outbox (org_id, job_type, payload) values ($1, 'audit_retry', $2)", [owner.orgId, forged]),
    /can only be queued by the server/,
  )

  // A job type members still enqueue through their own client is unaffected.
  const { rows: memberJob } = await asMember(
    "insert into outbox (org_id, job_type, payload) values ($1, 'reindex_search', '{}') returning id",
    [owner.orgId],
  )
  await assert.rejects(
    asMember("update outbox set job_type = 'audit_retry' where id = $1", [memberJob[0].id]),
    /can only be queued by the server/,
  )

  const queued = await insert(db, "outbox", { org_id: owner.orgId, job_type: "audit_retry", payload: forged })
  for (const sql of ["update outbox set status = 'failed' where id = $1", "delete from outbox where id = $1"]) {
    await assert.rejects(asMember(sql, [queued.id]), /can only be queued by the server/)
  }
  const { rows } = await db.query("select status from outbox where id = $1", [queued.id])
  assert.equal(rows[0].status, "pending")
})

const PROJECT = "00000000-0000-4000-8000-000000000201"
const APPLICATION = "00000000-0000-4000-8000-000000000202"
const INVOICE = "00000000-0000-4000-8000-000000000203"

function payApplicationHarness(status) {
  return createServiceHarness({
    permissions: ["payapp.write", "invoice.read", "invoice.send", "project.read"],
    rpc: {
      void_pay_application: (args, store) => {
        store.pay_applications.find((row) => row.id === args.p_pay_application_id).status = "void"
        return { data: null, error: null }
      },
    },
    tables: {
      audit_log: [],
      outbox: [],
      orgs: [{ id: ORG, name: "Builder", slug: "builder" }],
      projects: [{ id: PROJECT, org_id: ORG, name: "House", client_id: null, property_type: "custom_home" }],
      invoices: [{ id: INVOICE, org_id: ORG, project_id: PROJECT, metadata: {}, total_cents: 100000 }],
      pay_applications: [
        { id: APPLICATION, org_id: ORG, project_id: PROJECT, application_number: 1, status, invoice_id: INVOICE, metadata: {} },
      ],
    },
  })
}

test("a pay application whose invoice issued with a pending audit row still records the send", async () => {
  invoiceCalls.length = 0
  const service = payApplicationHarness("invoiced")

  await assert.rejects(
    service.run(() => sendPayApplication(APPLICATION, { recipients: ["owner@example.com"] })),
    (error) => error instanceof AuditRecordPendingError,
  )

  assert.deepEqual(invoiceCalls, [{ issue: INVOICE }])
  const [application] = service.db.pay_applications
  assert.equal(application.metadata.send_count, 1)
  assert.deepEqual(application.metadata.sent_to_owner.recipients, ["owner@example.com"])
  assert.equal(service.events.some((event) => event.eventType === "pay_application.sent"), true)
  assert.equal(service.db.audit_log.some((row) => row.entity_id === APPLICATION && row.after_data.sent_to_owner), true)
})

test("a pay application whose invoice voided with a pending audit row is still recorded as void", async () => {
  invoiceCalls.length = 0
  const service = payApplicationHarness("invoiced")

  await assert.rejects(
    service.run(() => voidPayApplication(APPLICATION)),
    (error) => error instanceof AuditRecordPendingError,
  )

  assert.deepEqual(invoiceCalls, [{ void: INVOICE }])
  assert.equal(service.db.pay_applications[0].status, "void")
  assert.equal(service.events.some((event) => event.eventType === "pay_application.voided"), true)
  assert.equal(service.db.audit_log.some((row) => row.entity_id === APPLICATION && row.after_data.status === "void"), true)
})

// ---------------------------------------------------------------------------
// Export: the auditor's file.
// ---------------------------------------------------------------------------

const OTHER_ORG = id(900101)
const RANGE = { from: "2026-07-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }

/** `count` changes for `orgId` from 1 August, ids from `firstId`. */
function changeRows(orgId, count, firstId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    org_id: orgId,
    actor_user_id: ACTOR,
    action: "update",
    entity_type: "vendor_bill",
    entity_id: BILL,
    source: null,
    ip_address: null,
    correlation_id: `req-${firstId + index}`,
    before_data: { status: "pending", amount_cents: 1000 + index },
    after_data: { status: "approved", amount_cents: 1000 + index },
    // Two rows share each second, and a shared second straddles every 1,000-row page.
    created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, Math.floor((index + 1) / 2))).toISOString(),
  }))
}

function exportHarness({ rows = [], permissions = ["audit.read", "project.read"], ...options } = {}) {
  return createServiceHarness({
    permissions,
    ...options,
    tables: { audit_log: rows, authorization_audit_log: [], app_users: [{ id: ACTOR, email: "auditor@builder.test" }] },
  })
}

test("the audit export is refused without audit.read and to a division-limited auditor", async () => {
  const rows = changeRows(ORG, 3)
  const reader = exportHarness({ rows, permissions: ["project.read"] })
  await assert.rejects(reader.run(() => exportOrgAuditEvidence({ source: "changes", ...RANGE })), /audit\.read/)

  const limited = exportHarness({ rows, divisions: [id(900201)] })
  await assert.rejects(
    limited.run(() => exportOrgAuditEvidence({ source: "changes", ...RANGE })),
    (error) => error.reason === "forbidden" && /whole organization/.test(error.message),
  )

  for (const harness of [reader, limited]) {
    assert.deepEqual(harness.queries.filter((query) => query.table === "audit_log"), [])
  }
})

test("the audit export pages through every row of this org in the range and nothing else", async () => {
  const ours = changeRows(ORG, 2_500)
  const theirs = changeRows(OTHER_ORG, 40, 5_001)
  const outside = changeRows(ORG, 1, 9_001).map((row) => ({ ...row, created_at: "2026-10-02T00:00:00.000Z" }))
  const service = exportHarness({ rows: [...theirs, ...ours, ...outside], maxRows: 1_000 })

  const file = await service.run(() => exportOrgAuditEvidence({ source: "changes", ...RANGE }))

  const check = verifyAuditExport(file.csv)
  assert.equal(check.valid, true, check.problems.join("; "))
  assert.equal(check.rowCount, 2_500)
  assert.equal(file.manifest.row_count, 2_500)
  assert.equal(file.manifest.org_id, ORG)
  assert.equal(file.manifest.exported_by.email, "auditor@builder.test")
  assert.equal(check.digest, file.digest)
  assert.equal(file.csv.includes(OTHER_ORG), false)
  assert.equal(file.csv.includes("req-9001"), false)
  assert.match(file.csv, /req-2500,/)
})

test("the audit export is itself audited with its manifest and digest", async () => {
  const service = exportHarness({ rows: changeRows(ORG, 2) })

  const file = await service.run(() => exportOrgAuditEvidence({ source: "changes", ...RANGE }))

  const record = service.db.audit_log.find((row) => row.entity_type === "audit_export")
  assert.equal(record.org_id, ORG)
  assert.equal(record.actor_user_id, ACTOR)
  assert.equal(record.after_data.digest, file.digest)
  assert.equal(record.after_data.row_count, 2)
  assert.deepEqual(
    service.events.map((event) => event.eventType),
    ["audit_exported"],
  )
})

test("an audit export whose range runs past now covers only up to the export", async () => {
  const service = exportHarness({ rows: changeRows(ORG, 2) })
  const before = Date.now()

  const file = await service.run(() => exportOrgAuditEvidence({ source: "changes", from: RANGE.from, to: "2999-01-01T00:00:00.000Z" }))

  const to = Date.parse(file.manifest.to)
  assert.ok(to >= before && to <= Date.now(), "the manifest ends at the moment of export, not in the future")
  assert.equal(verifyAuditExport(file.csv).valid, true)
})

test("an audit export too large for one file is refused, not truncated", async () => {
  const service = exportHarness({ rows: changeRows(ORG, 2) })
  service.tamper("audit_log", (result) => ({ ...result, count: 200_001 }), { on: "select", times: 1 })

  await assert.rejects(
    service.run(() => exportOrgAuditEvidence({ source: "changes", ...RANGE })),
    (error) => error.reason === "invalid" && /Narrow the range/.test(error.message),
  )
  assert.deepEqual(service.writes("audit_log"), [])
})

test("a tampered audit export fails verification", () => {
  const manifest = {
    format: "arc-audit-export/1",
    source: "access",
    org_id: ORG,
    from: RANGE.from,
    to: RANGE.to,
    generated_at: "2026-10-11T00:00:00.000Z",
    exported_by: { user_id: ACTOR, email: null },
    row_count: 2,
    columns: ["id", "occurred_at", "org_id", "user_agent", "context"],
    digest_algorithm: "sha256",
  }
  const rows = [
    { id: "a", occurred_at: "2026-08-01T00:00:00+00:00", org_id: ORG, user_agent: "=HYPERLINK(\"x\")", context: { b: 1, a: "line\none, two" } },
    { id: "b", occurred_at: "2026-08-02T00:00:00+00:00", org_id: ORG, user_agent: null, context: {} },
  ]
  const { csv } = buildAuditExportCsv(manifest, rows)
  assert.equal(verifyAuditExport(csv).valid, true)
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/, "a formula is never live in a spreadsheet")

  const tampered = [
    csv.replace("2026-08-02T00:00:00+00:00", "2026-08-03T00:00:00+00:00"),
    csv.replace(`"org_id":"${ORG}"`, `"org_id":"${OTHER_ORG}"`),
    csv.split("\n").filter((line) => !line.startsWith("b,")).join("\n"),
    csv.replace(/"digest_algorithm":"sha256"/, '"digest_algorithm":"sha256","extra":1'),
  ]
  for (const text of tampered) assert.equal(verifyAuditExport(text).valid, false)
})

// ---------------------------------------------------------------------------
// Retention: the evidence tables are append-only.
// ---------------------------------------------------------------------------

async function evidence(db, orgId) {
  const change = await insert(db, "audit_log", { org_id: orgId, action: "update", entity_type: "budget" })
  const access = await insert(db, "authorization_audit_log", { org_id: orgId, action_key: "bill.approve", decision: "deny" })
  return { change, access }
}

test("audit rows cannot be changed, deleted or truncated by any role", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const { change, access } = await evidence(db, owner.orgId)

  const attempts = [
    ["update audit_log set after_data = '{}' where id = $1", change.id],
    ["delete from audit_log where id = $1", change.id],
    ["update authorization_audit_log set decision = 'allow' where id = $1", access.id],
    ["delete from authorization_audit_log where id = $1", access.id],
  ]
  for (const [sql, rowId] of attempts) {
    await assert.rejects(db.query(sql, [rowId]), /append-only/, `postgres: ${sql}`)
    await assert.rejects(asRole(db, { role: "service_role" }, (tx) => tx.query(sql, [rowId])), /append-only/, `service_role: ${sql}`)
  }
  for (const table of ["audit_log", "authorization_audit_log"]) {
    await assert.rejects(db.exec(`truncate ${table} cascade`), /append-only/)
  }

  const { rows } = await db.query("select after_data from audit_log where id = $1", [change.id])
  assert.equal(rows.length, 1)
})

test("deleting an organization removes its audit evidence and no other organization's", async (t) => {
  const db = await createDatabase(t)
  const leaving = await seedMember(db)
  const staying = await seedMember(db)
  await evidence(db, leaving.orgId)
  await evidence(db, staying.orgId)

  await assert.rejects(db.query("delete from orgs where id = $1", [leaving.orgId]), /foreign key/, "access rows do not cascade")
  await rpc(db, "delete_organization", { p_org: leaving.orgId })
  assert.equal((await db.query("select count(*)::int n from orgs where id = $1", [leaving.orgId])).rows[0].n, 0)

  const remaining = async (table) =>
    (await db.query(`select org_id from ${table} order by org_id`)).rows.map((row) => row.org_id)
  assert.deepEqual(await remaining("audit_log"), [staying.orgId])
  assert.deepEqual(await remaining("authorization_audit_log"), [staying.orgId])
  await assert.rejects(rpc(db, "delete_organization", { p_org: staying.orgId }, { role: "authenticated", userId: staying.userId }), /permission denied/)
  await assert.rejects(rpc(db, "delete_organization", { p_org: leaving.orgId }), /Organization not found/)
})

test("deleting a project only clears its reference on access decisions", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const project = await insert(db, "projects", { org_id: owner.orgId, name: "Lot 12" })
  const access = await insert(db, "authorization_audit_log", {
    org_id: owner.orgId,
    project_id: project.id,
    action_key: "bill.approve",
    decision: "deny",
  })

  await assert.rejects(db.query("update authorization_audit_log set project_id = null where id = $1", [access.id]), /append-only/)
  await db.query("delete from projects where id = $1", [project.id])

  const { rows } = await db.query("select project_id, decision from authorization_audit_log where id = $1", [access.id])
  assert.deepEqual(rows, [{ project_id: null, decision: "deny" }])
})

test("sealed warranty completion evidence stays undeletable inside an organization purge", async (t) => {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const { change: sealed } = await evidence(db, owner.orgId)
  const { change: loose } = await evidence(db, owner.orgId)
  // Only the receipt's audit_id matters to the guard; its other references are
  // not part of this behaviour, so the fixture skips their foreign keys.
  await db.transaction(async (tx) => {
    await tx.exec("set local session_replication_role = replica")
    await tx.query(
      `insert into warranty_visit_completion_receipts
        (org_id, project_id, request_id, visit_id, actor_id, input, visit_evidence, request_evidence, event_id, audit_id)
       values ($1, $2, $3, $4, $5, '{}', '{}', '{}', $6, $7)`,
      [owner.orgId, uuid(), uuid(), uuid(), owner.userId, uuid(), sealed.id],
    )
  })

  const purging = (auditId) =>
    db.transaction(async (tx) => {
      await tx.query("select set_config('arc.purge_org', $1, true)", [owner.orgId])
      await tx.query("delete from audit_log where id = $1", [auditId])
    })
  await assert.rejects(purging(sealed.id), /Recorded warranty completion evidence cannot be deleted/)
  await purging(loose.id)
  const { rows } = await db.query("select id from audit_log where id = any($1::bigint[])", [[sealed.id, loose.id]])
  assert.deepEqual(rows.map((row) => String(row.id)), [String(sealed.id)])
})
