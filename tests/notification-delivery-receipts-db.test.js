"use strict"

/**
 * Notification delivery receipts: `reserve_notification_delivery` turns one
 * notification into at most one queued job per channel, and a compact receipt
 * that outlives outbox and notification retention so a replay never sends the
 * same alert twice. Triggers on `outbox` and `notification_delivery_receipts`
 * keep the receipt and its job in lockstep. Workers call the function as
 * `service_role`, exactly as `lib/services/notification-delivery-reservation.ts`
 * does through `supabase.rpc()`.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, asRole, insert, rpc, seedMember } = require("./support/pglite")
const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire } = require("./support/modules")

const { reserveNotificationDeliveries } = freshRequire("lib/services/notification-delivery-reservation.ts")
const { FEATURE_FLAGS } = freshRequire("lib/feature-flags/registry.ts")

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An org member with one released-house notification waiting to be delivered. */
async function notifiedMember(db, { notificationId, payload = { title: "House released" } } = {}) {
  const { orgId, userId } = await seedMember(db)
  const note = await insert(db, "notifications", {
    ...(notificationId ? { id: notificationId } : {}),
    org_id: orgId,
    user_id: userId,
    notification_type: "start_released",
    payload,
  })
  const reserve = (channel = "deliver_push", org = orgId) =>
    rpc(db, "reserve_notification_delivery", {
      p_org_id: org,
      p_notification_id: note.id,
      p_job_type: channel,
    })
  return { orgId, userId, note, reserve }
}

function deliveryJob(db, orgId, notificationId, { channel = "deliver_push", status = "pending" } = {}) {
  return insert(db, "outbox", { org_id: orgId, job_type: channel, payload: { notificationId }, status })
}

async function setJobStatus(db, receipt, status) {
  await db.query("update outbox set status = $1 where id = $2", [status, receipt.job_id])
}

async function count(db, table) {
  return (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n
}

async function rejectWritesTo(db, table, message, { when = "true" } = {}) {
  await db.exec(`
    create function test_reject() returns trigger language plpgsql as $$
    begin
      if ${when} then raise exception '${message}'; end if;
      return new;
    end $$;
    create trigger test_reject before insert or update on ${table}
      for each row execute function test_reject();
  `)
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

test("a reservation is idempotent and reports its job's state until the job is pruned", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)

  const first = await home.reserve()
  assert.equal(first.status, "pending")
  assert.deepEqual(await home.reserve(), first)

  await setJobStatus(db, first, "processing")
  assert.equal((await home.reserve()).status, "processing")
  await setJobStatus(db, first, "completed")
  assert.equal((await home.reserve()).status, "completed")

  await db.query("delete from outbox where id = $1", [first.job_id])
  assert.deepEqual(await home.reserve(), { receipt_id: first.receipt_id, job_id: null, status: "completed" })
  assert.equal(await count(db, "outbox"), 0)
})

test("each channel gets its own job", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)

  const push = await home.reserve("deliver_push")
  const email = await home.reserve("deliver_notification")

  assert.notEqual(push.job_id, email.job_id)
  assert.equal(await count(db, "notification_delivery_receipts"), 2)
})

test("a changed notification or a foreign org is refused without queuing a replacement", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const stranger = await seedMember(db)
  await home.reserve()

  await db.query("update notifications set payload = '{}' where id = $1", [home.note.id])
  await assert.rejects(home.reserve(), /differs from its delivery receipt/)
  await assert.rejects(home.reserve("deliver_push", stranger.orgId), /unavailable in organization/)
  assert.equal(await count(db, "outbox"), 1)
})

test("a single historical job is adopted; duplicate history needs reconciliation", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  await deliveryJob(db, home.orgId, home.note.id, { status: "completed" })

  assert.equal((await home.reserve("deliver_push")).status, "completed")
  assert.equal(await count(db, "outbox"), 1)

  await deliveryJob(db, home.orgId, home.note.id, { channel: "deliver_notification" })
  await deliveryJob(db, home.orgId, home.note.id, { channel: "deliver_notification" })
  await assert.rejects(home.reserve("deliver_notification"), /historical delivery jobs require reconciliation/)
  assert.equal(await count(db, "notification_delivery_receipts"), 1)
})

test("a historical job written with upper-case UUIDs is adopted under the canonical id", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db, { notificationId: "abcdefab-cdef-4abc-8def-abcdefabcdef" })
  const legacy = await deliveryJob(db, home.orgId, home.note.id.toUpperCase(), { status: "completed" })

  assert.equal((await home.reserve()).status, "completed")
  const { payload } = (await db.query("select payload from outbox where id = $1", [legacy.id])).rows[0]
  assert.equal(payload.notificationId, home.note.id)
})

test("historical jobs are looked up through their source index", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query("select indexdef from pg_indexes where indexname = $1", [
    "outbox_notification_delivery_source_idx",
  ])
  assert.match(rows[0].indexdef, /\(org_id, job_type, lower\(\(payload ->> 'notificationId'::text\)\), id\)/)
})

test("a failed receipt write rolls back the new job and the adopted job's payload", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  await rejectWritesTo(db, "notification_delivery_receipts", "Injected receipt failure")

  await assert.rejects(home.reserve(), /Injected receipt failure/)
  assert.equal(await count(db, "outbox"), 0)

  const legacy = await deliveryJob(db, home.orgId, home.note.id)
  await assert.rejects(home.reserve(), /Injected receipt failure/)
  const { payload } = (await db.query("select payload from outbox where id = $1", [legacy.id])).rows[0]
  assert.deepEqual(payload, { notificationId: home.note.id })
})

// ---------------------------------------------------------------------------
// Receipt and job lifecycle
// ---------------------------------------------------------------------------

test("a receipt and its job keep their identity", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()

  const tampering = [
    ["delete from outbox where id = $1", [receipt.job_id], /Active delivery jobs cannot be pruned/],
    ["update outbox set payload = '{}' where id = $1", [receipt.job_id], /job identity is immutable/],
    ["update notification_delivery_receipts set payload_hash = repeat('a', 64)", [], /identity is immutable/],
    ["delete from notification_delivery_receipts", [], /cannot be deleted/],
  ]
  for (const [sql, params, refusal] of tampering) {
    await assert.rejects(db.query(sql, params), refusal, sql)
  }
})

test("a completed delivery cannot be requeued or re-stamped", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()
  await setJobStatus(db, receipt, "completed")

  await assert.rejects(setJobStatus(db, receipt, "pending"), /cannot be requeued/)
  await assert.rejects(
    db.query("update notification_delivery_receipts set completed_at = clock_timestamp() + interval '1 hour'"),
    /receipt is immutable/,
  )
})

test("a failed delivery replays as failed and is requeued only through audited recovery", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()
  await setJobStatus(db, receipt, "failed")

  assert.equal((await home.reserve()).status, "failed")
  await assert.rejects(setJobStatus(db, receipt, "pending"), /Failed delivery requires audited recovery/)
})

test("a refused receipt completion rolls back the job's completion", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()
  await rejectWritesTo(db, "notification_delivery_receipts", "Injected completion failure", {
    when: "new.status = 'completed'",
  })

  await assert.rejects(setJobStatus(db, receipt, "completed"), /Injected completion failure/)
  assert.equal((await home.reserve()).status, "pending")
  const job = (await db.query("select status from outbox where id = $1", [receipt.job_id])).rows[0]
  assert.equal(job.status, "pending")
})

test("a completed receipt outlives its notification and still blocks a resend", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()
  await setJobStatus(db, receipt, "completed")

  await db.query("delete from notifications where id = $1", [home.note.id])
  assert.equal(await count(db, "notification_delivery_receipts"), 1)

  const { id, ...restored } = home.note
  await insert(db, "notifications", { id, ...restored })
  assert.equal((await home.reserve()).status, "completed")
  assert.equal(await count(db, "outbox"), 1)
})

// ---------------------------------------------------------------------------
// Browser roles
// ---------------------------------------------------------------------------

test("browser roles cannot reserve, read receipts or move a receipted job; other jobs are unaffected", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const receipt = await home.reserve()
  const member = { role: "authenticated", userId: home.userId }

  for (const caller of [{ role: "anon" }, member]) {
    await assert.rejects(
      rpc(
        db,
        "reserve_notification_delivery",
        { p_org_id: home.orgId, p_notification_id: home.note.id, p_job_type: "deliver_push" },
        caller,
      ),
      /permission denied/,
    )
    await assert.rejects(
      asRole(db, caller, (tx) => tx.query("select * from notification_delivery_receipts")),
      /permission denied/,
    )
  }
  await assert.rejects(
    asRole(db, member, (tx) => tx.query("update outbox set status = 'completed' where id = $1", [receipt.job_id])),
    /Receipted delivery jobs require service role/,
  )

  const ordinary = await insert(db, "outbox", { org_id: home.orgId, job_type: "ordinary", payload: {} })
  await asRole(db, member, (tx) => tx.query("update outbox set status = 'completed' where id = $1", [ordinary.id]))
  const job = (await db.query("select status from outbox where id = $1", [ordinary.id])).rows[0]
  assert.equal(job.status, "completed")
})

// ---------------------------------------------------------------------------
// The application adapter
// ---------------------------------------------------------------------------

test("the reservation adapter replays its receipts after jobs are completed and pruned", async (t) => {
  const db = await createDatabase(t)
  const home = await notifiedMember(db)
  const supabase = createFakeSupabase({
    feature_flags: [{ org_id: home.orgId, flag_key: FEATURE_FLAGS.notificationDeliveryReceipts, enabled: true }],
  })
  supabase.rpc = async (name, args) => {
    try {
      return { data: await rpc(db, name, args), error: null }
    } catch (error) {
      return { data: null, error: { code: error.code, message: error.message } }
    }
  }
  const input = {
    supabase,
    orgId: home.orgId,
    notificationId: home.note.id,
    channels: ["deliver_notification", "deliver_push"],
  }

  assert.equal(await reserveNotificationDeliveries(input), true)
  await db.exec("update outbox set status = 'completed'; delete from outbox")
  assert.equal(await reserveNotificationDeliveries(input), true)

  assert.equal(await count(db, "outbox"), 0)
  assert.equal(await count(db, "notification_delivery_receipts"), 2)
})
