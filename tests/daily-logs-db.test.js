"use strict"

/**
 * The daily log's database contract: `create_daily_log_submission` saves a
 * log, its entries, the linked schedule/task/punch changes, mentions, audit,
 * events and email jobs in one transaction, idempotently per submission id.
 * The server calls it as `service_role` (lib/services/daily-logs.ts).
 *
 * One migrated database serves the suite; every test works in its own org.
 */

const test = require("node:test")
const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

/** A project with a writer, a mentionable member and one of each linkable item. */
async function site() {
  const { orgId, userId: writer } = await seedMember(db)
  const { userId: reader } = await seedMember(db, { orgId, role: "org_user" })
  await db.query("update app_users set full_name = $2 where id = $1", [writer, "Writer"])
  await db.query("update app_users set full_name = $2 where id = $1", [reader, "Reader"])
  const project = await insert(db, "projects", { org_id: orgId, name: "Job", location: { address: "Site" } })
  await db.query(
    "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'field'",
    [orgId, project.id, reader],
  )
  const schedule = await insert(db, "schedule_items", {
    org_id: orgId,
    project_id: project.id,
    name: "Framing",
    status: "planned",
    actual_hours: 2,
  })
  const task = await insert(db, "tasks", {
    org_id: orgId,
    project_id: project.id,
    title: "Inspect roof",
    status: "todo",
    metadata: { preserve: true },
  })
  const punch = await insert(db, "punch_items", { org_id: orgId, project_id: project.id, title: "Door", status: "open" })
  const location = await insert(db, "project_locations", {
    org_id: orgId,
    project_id: project.id,
    name: "Room A",
    full_path: "Level 1 / Room A",
    is_active: true,
  })

  const input = {
    date: "2026-09-07",
    summary: "Done @Reader",
    weather: { conditions: "Sunny" },
    entries: [
      { entry_type: "work", schedule_item_id: schedule.id, hours: 3, progress: 50, location_id: location.id },
      { entry_type: "task_update", task_id: task.id, metadata: { mark_complete: true } },
      { entry_type: "punch_update", punch_item_id: punch.id, metadata: { mark_closed: true } },
    ],
  }
  const submit = (submissionId, value = input, mentions = [reader]) =>
    rpc(db, "create_daily_log_submission", {
      p_org_id: orgId,
      p_project_id: project.id,
      p_actor_id: writer,
      p_submission_id: submissionId,
      p_input: value,
      p_mentioned_user_ids: mentions,
    })
  const count = async (table, where = "true") =>
    Number((await db.query(`select count(*) as n from ${table} where org_id = $1 and ${where}`, [orgId])).rows[0].n)
  const value = async (sql) => (await db.query(sql)).rows[0]
  return { db, orgId, writer, reader, project, schedule, task, punch, location, input, submit, count, value }
}

const MENTION_EMAIL = "job_type = 'send_daily_log_mention_email'"

test("a submission saves the log and every linked change together", async () => {
  const s = await site()

  const saved = await s.submit(randomUUID())

  assert.equal(saved.entries.length, 3)
  assert.equal(saved.entries.find((entry) => entry.entry_type === "work").location, "Level 1 / Room A")
  assert.equal(saved.mentions[0].user.full_name, "Reader")
  assert.equal(Number((await s.value(`select actual_hours from schedule_items where id = '${s.schedule.id}'`)).actual_hours), 5)
  const task = await s.value(`select status, metadata from tasks where id = '${s.task.id}'`)
  assert.equal(task.status, "done")
  assert.equal(task.metadata.preserve, true, "unrelated task metadata is kept")
  assert.equal((await s.value(`select status from punch_items where id = '${s.punch.id}'`)).status, "closed")
  assert.equal(await s.count("audit_log", "entity_type = 'daily_log'"), 1)
  const email = await s.value(`select payload from outbox where ${MENTION_EMAIL}`)
  assert.match(email.payload.message, /on Job:/)
})

test("a retry returns the same records without repeating hours, events or email", async () => {
  const s = await site()
  const id = randomUUID()
  const saved = await s.submit(id)
  const events = await s.count("events")

  const replay = await s.submit(id)

  assert.equal(replay.replayed, true)
  assert.equal(replay.log.id, saved.log.id)
  assert.deepEqual(replay.entries.map((entry) => entry.id), saved.entries.map((entry) => entry.id))
  assert.equal(await s.count("daily_logs"), 1)
  assert.equal(await s.count("outbox", MENTION_EMAIL), 1)
  assert.equal(await s.count("events"), events)
  assert.equal(Number((await s.value(`select actual_hours from schedule_items where id = '${s.schedule.id}'`)).actual_hours), 5)
  await assert.rejects(s.submit(id, { ...s.input, summary: "Changed" }), /different content/)
})

test("a reference outside this project, or an inactive location, saves nothing", async () => {
  const s = await site()
  const other = await insert(s.db, "projects", { org_id: s.orgId, name: "Other job" })
  const foreignSchedule = await insert(s.db, "schedule_items", { org_id: s.orgId, project_id: other.id, name: "Elsewhere" })

  await assert.rejects(
    s.submit(randomUUID(), { date: "2026-09-06", entries: [{ entry_type: "work", schedule_item_id: foreignSchedule.id }] }),
    /Schedule item is unavailable/,
  )
  await s.db.query("update project_locations set is_active = false where id = $1", [s.location.id])
  await assert.rejects(s.submit(randomUUID()), /Location is unavailable/)

  assert.equal(await s.count("daily_reports"), 0)
  assert.equal(await s.count("daily_logs"), 0)
})

test("a failure after the log is written rolls back everything before it", async () => {
  const s = await site()
  await s.db.exec(`
    create function test_fail_entry() returns trigger language plpgsql as $$ begin raise exception 'entry failed'; end $$;
    create trigger test_fail_entry before insert on daily_log_entries for each row execute function test_fail_entry();
  `)
  try {
    await assert.rejects(s.submit(randomUUID()), /entry failed/)
  } finally {
    await s.db.exec("drop trigger test_fail_entry on daily_log_entries; drop function test_fail_entry()")
  }

  for (const table of ["daily_reports", "daily_logs", "daily_log_mentions"]) assert.equal(await s.count(table), 0, table)
  assert.equal(await s.count("outbox", MENTION_EMAIL), 0)
  assert.equal(Number((await s.value(`select actual_hours from schedule_items where id = '${s.schedule.id}'`)).actual_hours), 2)
})

test("a daily log cannot close a verification-required punch item without evidence", async () => {
  const s = await site()
  await s.db.query("update punch_items set verification_required = true where id = $1", [s.punch.id])

  await assert.rejects(s.submit(randomUUID()), /Add verification evidence/)
  assert.equal((await s.value(`select status from punch_items where id = '${s.punch.id}'`)).status, "open")
  assert.equal(await s.count("daily_logs"), 0, "the refused close saves nothing")

  const file = await insert(s.db, "files", { org_id: s.orgId, project_id: s.project.id, file_name: "after.jpg", storage_path: `${s.orgId}/after.jpg` })
  await insert(s.db, "file_links", { org_id: s.orgId, file_id: file.id, project_id: s.project.id, entity_type: "punch_item", entity_id: s.punch.id, link_role: "after" })
  await s.submit(randomUUID())

  const closed = await s.value(`select status, verified_at, verified_by, resolved_by from punch_items where id = '${s.punch.id}'`)
  assert.equal(closed.status, "closed")
  assert.ok(closed.verified_at, "the closer is stamped as the verifier")
  assert.equal(closed.verified_by, s.writer)
})

test("a submitted day takes addenda without unlocking its weather", async () => {
  const s = await site()
  const first = await s.submit(randomUUID())
  await s.db.query("update daily_reports set status = 'submitted' where id = $1", [first.log.daily_report_id])

  const addendum = await s.submit(randomUUID(), { date: "2026-09-07", summary: "Addendum", weather: { conditions: "Rain" } }, [])

  assert.equal(addendum.log.daily_report_id, first.log.daily_report_id)
  const report = await s.value(`select status, weather from daily_reports where id = '${first.log.daily_report_id}'`)
  assert.equal(report.status, "submitted")
  assert.equal(report.weather.conditions, "Sunny")
})

test("only the server may run the submission", async () => {
  const signature = "public.create_daily_log_submission(uuid,uuid,uuid,uuid,jsonb,uuid[])"
  for (const role of ["anon", "authenticated", "service_role"]) {
    const { rows } = await db.query("select has_function_privilege($1, $2, 'execute') as allowed", [role, signature])
    assert.equal(rows[0].allowed, role === "service_role", role)
  }
})
