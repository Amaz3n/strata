"use strict"

/**
 * Task mentions in the database: the `tasks_queue_mentions` trigger writes the
 * in-app notification and its email job in the same transaction as the task,
 * once per newly mentioned person, and refuses a mention of someone who
 * cannot open the task.
 *
 * One migrated database serves the suite; every test works in its own org.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

/**
 * A project task board: the author, a project member, an org member who is not
 * on the project, and someone from another org.
 */
async function board() {
  const { orgId, userId: author } = await seedMember(db, { role: "org_user" })
  const { userId: teammate } = await seedMember(db, { orgId, role: "org_user" })
  const { userId: offProject } = await seedMember(db, { orgId, role: "org_user" })
  const { userId: outsider } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  for (const member of [author, teammate]) {
    await db.query(
      "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'field'",
      [orgId, project.id, member],
    )
  }
  // Tasks are written by the signed-in author, so auth.uid() names them.
  const write = (sql, params) => asRole(db, { role: "service_role", userId: author }, (tx) => tx.query(sql, params))
  const create = async (mentioned) =>
    (
      await write(
        "insert into tasks (org_id, project_id, title, metadata) values ($1, $2, 'Review plans', $3) returning *",
        [orgId, project.id, { mentioned_user_ids: mentioned }],
      )
    ).rows[0]
  const count = async (table, where = "true") =>
    Number((await db.query(`select count(*) as n from ${table} where org_id = $1 and ${where}`, [orgId])).rows[0].n)
  return { orgId, author, teammate, offProject, outsider, project, write, create, count }
}

const EMAIL_JOBS = ["outbox", "job_type = 'deliver_notification'"]

test("mentioning a teammate notifies them once, linking to the task", async () => {
  const b = await board()

  const task = await b.create([b.teammate, b.teammate])

  const { rows } = await db.query("select user_id, payload from notifications where org_id = $1", [b.orgId])
  assert.deepEqual(rows.map((row) => row.user_id), [b.teammate])
  assert.equal(rows[0].payload.href, `/tasks?task=${task.id}`)
  assert.equal(await b.count(...EMAIL_JOBS), 1)
})

test("saving a task again, or mentioning yourself, sends nothing new", async () => {
  const b = await board()
  const task = await b.create([b.teammate])

  await b.write("update tasks set metadata = $1 where id = $2", [{ mentioned_user_ids: [b.teammate], checklist: [] }, task.id])
  await b.write("update tasks set metadata = $1 where id = $2", [{ mentioned_user_ids: [b.teammate, b.author] }, task.id])

  assert.equal(await b.count("notifications"), 1)
  assert.equal(await b.count(...EMAIL_JOBS), 1)
})

test("someone off the project or from another org cannot be mentioned, and the task is not saved", async () => {
  const b = await board()

  for (const stranger of [b.offProject, b.outsider]) {
    await assert.rejects(b.create([stranger]), /cannot access/)
  }

  assert.equal(await b.count("tasks"), 0)
  assert.equal(await b.count("notifications"), 0)
})

test("if the email job cannot be queued, neither the task nor its notification is kept", async () => {
  const b = await board()
  await db.exec("alter table outbox add constraint test_fail_queue check (job_type <> 'deliver_notification') not valid")
  try {
    await assert.rejects(b.create([b.teammate]), /test_fail_queue/)
  } finally {
    await db.exec("alter table outbox drop constraint test_fail_queue")
  }

  assert.equal(await b.count("tasks"), 0)
  assert.equal(await b.count("notifications"), 0)
})
