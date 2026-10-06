const test = require("node:test")
const assert = require("node:assert/strict")
const { cdcDatabase, id } = require("./fixtures/qbo-cdc-database")
require("../scripts/register-ts-node-test")
const { CDC_ENTITIES, cdcRow } = require("../lib/integrations/accounting/qbo/cdc")
const savedFetch = global.fetch
test.before(() => {
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
})
test.after(() => {
  global.fetch = savedFetch
})
const event = (time, extra = {}) => ({
  event_id: `realm:Invoice:42:Update:${time}`,
  realm_id: "realm",
  entity_name: "Invoice",
  entity_qbo_id: "42",
  operation: "Update",
  last_updated: time,
  ...extra,
})

test("exact recovery migration starts absent, installs service-only roles and preserves Q02/Q03 security", async (t) => {
  const f = await cdcDatabase(t)
  assert.equal(
    (await f.db.query("select to_regprocedure('claim_qbo_cdc_run(uuid,uuid,text,text,timestamptz,timestamptz,text[])') routine")).rows[0]
      .routine,
    null,
  )
  await f.install()
  for (const role of ["anon", "authenticated"])
    await f.role(role, async () => {
      for (const sql of [
        "select * from qbo_cdc_runs",
        "insert into qbo_cdc_runs(org_id,connection_id,realm_id,changed_since,checkpoint,first_checkpoint) values(null,null,'bad',now(),now(),now())",
        "update qbo_cdc_candidates set review_status='pending'",
        "delete from qbo_cdc_receipts",
        "select * from accounting_connections",
        "select access_token from accounting_connections",
        "update accounting_sync_records set status='pending'",
        "select * from qbo_webhook_events",
        `select claim_qbo_cdc_run('${f.org}','${f.connection}','realm',null,now(),now(),'{}')`,
        `select update_qbo_cdc_cursor('${f.connection}',now())`,
        `select persist_qbo_cdc_progress('${f.org}','${f.connection}','realm',null,null,0,null,'{}')`,
        "select qbo_cdc_timestamp_or_null('2026-01-01T00:00:00Z')",
        "select qbo_recovery_entity_name('invoice','{}')",
      ])
        await assert.rejects(f.db.exec(sql), /permission denied/)
    })
  await f.role("service_role", async () => {
    const run = await f.claim()
    const result = await f.persist(run, {
      completed_entities: CDC_ENTITIES,
      release: true,
    })
    assert.equal(result.run.status, "complete")
    assert.equal((await f.settings()).manual_setting, true)
    await assert.rejects(f.db.query("select update_qbo_cdc_cursor($1,now())", [f.connection]), /requires scoped validated/)
  })
})

test("atomic intake, revision investigations, candidate replay and progress rollback preserve terminal queue state", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim({
    reasons: ["lost_window"],
    original: "2025-01-01T00:00:00.000Z",
  })
  const time = new Date(Date.parse(f.now) - 5000).toISOString()
  const missing = cdcRow("Invoice", { Id: "missing-time", SyncToken: "1" }, "realm")
  const investigation = {
    ...event(time),
    event_id: missing.eventId,
    entity_qbo_id: missing.id,
    last_updated: null,
    revision: missing.revision,
  }
  const change = {
    events: [event(time)],
    investigations: [investigation],
    candidates: [
      {
        entity_name: "Invoice",
        external_id: "new",
        revision: "a".repeat(64),
        document_number: "new",
        transaction_date: "2026-01-01",
        last_updated: time,
      },
    ],
    reasons: ["ambiguous_timestamp"],
    entity: "Invoice",
    progress: { cdc_complete: false, cdc_attempted: true },
  }
  const first = await f.persist(run, change)
  assert.equal(first.inserted_ids.length, 2)
  assert.deepEqual(await f.persist(run, change), first, "same receipt is a truthful replay")
  await f.db.query(
    "update qbo_webhook_events set process_status='completed',attempts=4,process_error='retained',processed_at=now() where entity_qbo_id='42'",
  )
  const replay = await f.persist(first.run, change, id(200))
  assert.equal(replay.inserted_ids.length, 0)
  assert.equal((await f.candidates()).length, 1)
  const terminal = (await f.queue()).find((row) => row.entity_qbo_id === "42")
  assert.equal(terminal.process_status, "completed")
  assert.equal(terminal.attempts, 4)
  assert.equal(terminal.process_error, "retained")
  const revision2 = cdcRow("Invoice", { Id: "missing-time", SyncToken: "2" }, "realm")
  const second = await f.persist(
    replay.run,
    {
      investigations: [
        {
          ...investigation,
          event_id: revision2.eventId,
          revision: revision2.revision,
        },
      ],
    },
    id(201),
  )
  assert.equal(second.inserted_ids.length, 1)
  assert.equal((await f.queue()).filter((row) => row.entity_qbo_id === "missing-time").length, 2)
  const before = await f.queue()
  await assert.rejects(
    f.persist(
      second.run,
      {
        events: [
          event(time, {
            event_id: `realm:Invoice:new:Update:${time}`,
            entity_qbo_id: "new",
          }),
        ],
        candidates: [{ entity_name: "Invoice", external_id: "bad", revision: "invalid" }],
        entity: "Invoice",
        progress: { enumeration_position: 201 },
      },
      id(202),
    ),
    /Invalid CDC candidate/,
  )
  assert.deepEqual(await f.queue(), before)
  assert.equal((await f.settings()).qbo_cdc_recovery.progress.Invoice.enumeration_position, undefined)
})

test("serialized stale completions, foreign companies, lease takeover and receipt replay never regress cursor/settings", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const old = await f.claim()
  assert.equal(await f.claim(), null, "active lease excludes another worker")
  await assert.rejects(
    f.persist(old, { completed_entities: CDC_ENTITIES }, id(300), {
      realm: "other-realm",
    }),
    /company scope/,
  )
  await assert.rejects(
    f.persist(old, { completed_entities: CDC_ENTITIES }, id(301), {
      version: 9,
    }),
    /Stale CDC/,
  )
  const newer = new Date(Date.parse(old.checkpoint) + 300000).toISOString()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text,'concurrent_manual',true) where id=$2",
    [newer, f.connection],
  )
  const complete = await f.persist(old, { completed_entities: CDC_ENTITIES }, id(302))
  assert.equal(complete.run.status, "complete")
  const settings = await f.settings()
  assert.equal(settings.qbo_cdc_last_synced_at, newer)
  assert.equal(settings.concurrent_manual, true)
  const other = await f.claim({
    org: f.otherOrg,
    connection: f.otherConnection,
    realm: "other-realm",
  })
  await assert.rejects(f.persist(other, { events: [event(new Date(Date.parse(f.now) - 1000).toISOString())] }, id(303)), /Foreign CDC/)
  await f.db.exec("update qbo_cdc_runs set lease_until=now()-interval '1 second' where status='open'")
  const takeover = await f.claim({
    org: f.otherOrg,
    connection: f.otherConnection,
    realm: "other-realm",
  })
  assert.notEqual(takeover.lease_token, other.lease_token)
  await assert.rejects(f.persist(other, { completed_entities: CDC_ENTITIES }, id(304)), /Stale CDC/)
})

test("permanent saturation cycles durable observation windows, retains original gap and records an aged resumed window", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  let run = await f.claim()
  let result = await f.persist(run, { completed_entities: CDC_ENTITIES.filter((name) => name !== "Invoice") }, id(400))
  result = await f.persist(
    result.run,
    {
      entity: "Invoice",
      progress: { cdc_complete: false, cdc_attempted: true },
      reasons: ["saturated"],
      release: true,
    },
    id(401),
  )
  const before = await f.settings()
  assert.equal(before.qbo_cdc_last_synced_at, undefined)
  assert.equal(Date.parse(before.qbo_cdc_observation_start), Date.parse(run.checkpoint))
  const requested = new Date(Date.parse(f.now) + 500).toISOString()
  const nextSince = new Date(Date.parse(run.checkpoint) - 5 * 60000).toISOString()
  const next = await f.claim({ checkpoint: requested, since: nextSince })
  assert.equal(Date.parse(next.changed_since), Date.parse(nextSince))
  assert.equal(Date.parse(next.checkpoint), Date.parse(requested))
  assert.equal(next.original_boundary, run.original_boundary)
  assert.equal(next.progress.Invoice.cdc_attempted, false)
  assert.ok(next.reasons.includes("saturated"))
  await f.db.query("update qbo_cdc_runs set changed_since=now()-interval '31 days',lease_until=now()-interval '1 second' where id=$1", [
    run.id,
  ])
  const aged = await f.claim()
  assert.ok(aged.reasons.includes("recovery_window_expired"))
  assert.ok(aged.reasons.includes("saturated"))
  assert.equal(aged.id, run.id)
  assert.equal(aged.original_boundary, run.original_boundary)
})

test("confirmed missing mapped identities are company-scoped pending corrections, never inferred from enumeration absence", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim({ reasons: ["lost_window"] })
  await f.db.query(
    "insert into accounting_sync_records(id,org_id,connection_id,entity_type,entity_id,external_id) values($1,$2,$3,'invoice',$4,'missing')",
    [id(500), f.org, f.connection, id(501)],
  )
  await assert.rejects(
    f.persist(
      run,
      {
        confirmed_missing: [
          {
            mapping_id: id(500),
            entity_name: "Bill",
            entity_qbo_id: "missing",
          },
        ],
      },
      id(502),
    ),
    /Invalid confirmed missing/,
  )
  const change = {
    confirmed_missing: [{ mapping_id: id(500), entity_name: "Invoice", entity_qbo_id: "missing" }],
    mapped_after: id(500),
  }
  const result = await f.persist(run, change, id(503))
  assert.equal(result.inserted_ids.length, 1)
  const [queued] = await f.queue()
  assert.equal(queued.operation, "Delete")
  assert.equal(queued.last_updated, null)
  assert.equal(queued.process_status, "pending")
  assert.match(queued.event_id, /:confirmed-missing:/)
  assert.equal((await f.db.query("select status from accounting_sync_records where id=$1", [id(500)])).rows[0].status, "synced")
})

test("null fencing and commands reject atomically before durable intake", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim()
  const change = {
    events: [event(new Date(Date.parse(f.now) - 1000).toISOString())],
  }
  await assert.rejects(f.persist(run, change, id(600), { version: null }), /Stale CDC/)
  await assert.rejects(f.persist(run, null, id(601)), /Invalid CDC progress command/)
  await assert.rejects(f.persist(run, { ...change, mapped_after: null }, id(602)), /Invalid mapped/)
  assert.equal((await f.queue()).length, 0)
  assert.equal((await f.db.query("select version from qbo_cdc_runs where id=$1", [run.id])).rows[0].version, 0)
})

test("same-owner receipt survives lease takeover while null/foreign owner or command collision is rejected", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim({ reasons: ["lost_window"] })
  const change = {
    entity: "Invoice",
    progress: { cdc_attempted: true },
    release: true,
  }
  const saved = await f.persist(run, change, id(700))
  const takeover = await f.claim()
  assert.notEqual(takeover.lease_token, run.lease_token)
  assert.deepEqual(await f.persist(run, change, id(700)), saved)
  await assert.rejects(f.persist(run, change, id(700), { token: null }), /command or owner/)
  await assert.rejects(f.persist(run, change, id(700), { token: takeover.lease_token }), /receipt owner/)
  await assert.rejects(f.persist(run, { release: true }, id(700)), /receipt owner or command/)
})

test("failed mapping evidence is scoped, receipt-idempotent and durable beyond bounded summary", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  let run = await f.claim({ reasons: ["lost_window"] })
  for (let n = 0; n < 12; n++)
    await f.db.query(
      "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id,metadata) values($1,$2,$3,'qbo','invoice',$4,$5,'{\"external_entity_type\":\"Invoice\"}')",
      [id(300 + n), f.org, f.connection, id(500 + n), `failed${n}`],
    )
  const command = (n) => ({
    failed_mapping: {
      mapping_id: id(300 + n),
      entity_name: "Invoice",
      entity_qbo_id: `failed${n}`,
      reason: "malformed_read",
    },
    mapped_after: id(300 + n),
  })
  for (const change of [
    {
      ...command(0),
      failed_mapping: { ...command(0).failed_mapping, mapping_id: null },
    },
    {
      ...command(0),
      failed_mapping: { ...command(0).failed_mapping, entity_name: "Payment" },
    },
    {
      ...command(0),
      failed_mapping: {
        ...command(0).failed_mapping,
        entity_qbo_id: "foreign",
      },
    },
  ])
    await assert.rejects(f.persist(run, change, id(700)), /Invalid failed/)
  assert.equal((await f.queue()).length, 0)
  for (let n = 0; n < 12; n++) {
    const old = run,
      result = await f.persist(run, command(n), id(710 + n))
    assert.deepEqual(await f.persist(old, command(n), id(710 + n)), result)
    run = result.run
  }
  assert.equal((await f.queue()).length, 12)
  assert.ok((await f.queue()).every((event) => event.process_status === "investigation" && event.operation === "Update"))
  assert.equal(run.mapped_failure_count, 12)
  assert.equal(run.mapped_failures.length, 10)
  const summary = (await f.settings()).qbo_cdc_recovery
  assert.equal(summary.mapped_failures_truncated, true)
  assert.equal(summary.mapped_failure_count, 12)
  assert.ok(summary.reasons.includes("malformed_response"))
  await assert.rejects(f.persist(run, command(11), id(800)), /Regressing/)
})

test("failed mapping itself prevents complete proof even when caller omits reasons", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim()
  await f.db.query(
    "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id) values($1,$2,$3,'qbo','invoice',$4,'failed')",
    [id(900), f.org, f.connection, id(901)],
  )
  const result = await f.persist(
    run,
    {
      failed_mapping: {
        mapping_id: id(900),
        entity_name: "Invoice",
        entity_qbo_id: "failed",
        reason: "malformed_read",
      },
      mapped_after: id(900),
      completed_entities: CDC_ENTITIES,
    },
    id(902),
  )
  assert.equal(result.run.status, "open")
  assert.ok(result.run.reasons.includes("malformed_response"))
  assert.equal(result.summary.status, "required")
  assert.equal((await f.settings()).qbo_cdc_last_synced_at, undefined)
})

test("immutable original requested interval survives restart, current observation rotation and window aging", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim()
  let saved = await f.persist(run, { completed_entities: CDC_ENTITIES.filter((entity) => entity !== "Invoice") }, id(950))
  saved = await f.persist(
    saved.run,
    { entity: "Invoice", progress: { cdc_attempted: true, cdc_complete: false }, reasons: ["saturated"], release: true },
    id(951),
  )
  let next = await f.claim({ since: new Date(Date.parse(run.checkpoint) - 300000).toISOString() })
  assert.equal(next.first_changed_since, run.changed_since)
  assert.equal(next.first_checkpoint, run.checkpoint)
  await f.db.query("update qbo_cdc_runs set changed_since=now()-interval '31 days',lease_until=now()-interval '1 second' where id=$1", [
    run.id,
  ])
  next = await f.claim()
  assert.equal(next.first_changed_since, run.changed_since)
  assert.equal(next.first_checkpoint, run.checkpoint)
  const summary = (await f.settings()).qbo_cdc_recovery
  assert.equal(Date.parse(summary.first_changed_since), Date.parse(run.changed_since))
  assert.equal(Date.parse(summary.first_checkpoint), Date.parse(run.checkpoint))
  assert.equal(next.original_boundary, null)
  assert.ok(next.reasons.includes("saturated"))
  assert.ok(next.reasons.includes("recovery_window_expired"))
})

test("phase commands reject null/unknown values atomically and replay under the same receipt", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim()
  for (const phase of [null, 1, "other"])
    await assert.rejects(
      f.persist(run, { recovery_phase: phase, events: [event(new Date(Date.parse(f.now) - 1000).toISOString())] }, id(980)),
      /Invalid recovery phase/,
    )
  assert.equal((await f.queue()).length, 0)
  assert.equal((await f.db.query("select version,recovery_phase from qbo_cdc_runs")).rows[0].version, 0)
  const change = { recovery_phase: "mapped" }
  const result = await f.persist(run, change, id(981))
  assert.equal(result.run.recovery_phase, "mapped")
  assert.deepEqual(await f.persist(run, change, id(981)), result)
})
