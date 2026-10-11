"use strict"

/**
 * Division scope is enforced by the database, not only by authorize().
 *
 * A member whose membership is limited to some divisions (or to the projects
 * they are assigned to) reads and writes through their own JWT exactly what the
 * application would let them: a direct PostgREST call cannot reach another
 * division's project or the money, schedule and files hanging off it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember, uuid } = require("./support/pglite")

async function member(db, orgId, { role, divisionScope = "all", projectScope = "all", divisions = [], projects = [] }) {
  const { userId } = await seedMember(db, { orgId, role })
  const { rows } = await db.query(
    "update memberships set division_scope = $3, project_scope = $4 where org_id = $1 and user_id = $2 returning id",
    [orgId, userId, divisionScope, projectScope],
  )
  for (const divisionId of divisions) {
    await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: divisionId })
  }
  for (const projectId of projects) {
    await db.query(
      "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'pm'",
      [orgId, projectId, userId],
    )
  }
  return { userId, membershipId: rows[0].id }
}

/** One project's worth of the rows a builder's staff live in. */
async function stockProject(db, orgId, project) {
  await insert(db, "contracts", { org_id: orgId, project_id: project.id, title: `${project.name} agreement` })
  const budget = await insert(db, "budgets", { org_id: orgId, project_id: project.id })
  await insert(db, "budget_lines", { org_id: orgId, budget_id: budget.id, description: `${project.name} framing` })
  await insert(db, "vendor_bills", { org_id: orgId, project_id: project.id, bill_number: `B-${project.name}` })
  await insert(db, "schedule_items", { org_id: orgId, project_id: project.id, name: `${project.name} slab` })
  await insert(db, "files", {
    org_id: orgId,
    project_id: project.id,
    file_name: `${project.name}.pdf`,
    storage_path: `${orgId}/${project.id}/plan.pdf`,
  })
}

/**
 * An org with a North and a South division, a project in each and one with no
 * division, plus the members whose scopes differ.
 */
async function dividedOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const northHome = await insert(db, "projects", { org_id: orgId, name: "North", division_id: north.id })
  const southHome = await insert(db, "projects", { org_id: orgId, name: "South", division_id: south.id })
  const loose = await insert(db, "projects", { org_id: orgId, name: "Loose" })
  for (const project of [northHome, southHome, loose]) await stockProject(db, orgId, project)

  // Belongs to both projects, so only the division keeps South out.
  const northLead = await member(db, orgId, {
    role: "org_project_lead",
    divisionScope: "assigned",
    divisions: [north.id],
    projects: [northHome.id, southHome.id],
  })
  const orgWideLead = await member(db, orgId, { role: "org_project_lead" })
  const northAdmin = await member(db, orgId, { role: "org_admin", divisionScope: "assigned", divisions: [north.id] })
  const assignedSuper = await member(db, orgId, {
    role: "org_superintendent",
    projectScope: "assigned",
    projects: [southHome.id],
  })

  return { db, orgId, ownerId, north, south, northHome, southHome, loose, northLead, orgWideLead, northAdmin, assignedSuper }
}

const SCOPED_READS = {
  projects: "select name from projects order by name",
  contracts: "select c.title as name from contracts c order by 1",
  budgets: "select p.name from budgets b join projects p on p.id = b.project_id order by 1",
  budget_lines: "select description as name from budget_lines order by 1",
  vendor_bills: "select bill_number as name from vendor_bills order by 1",
  schedule_items: "select name from schedule_items order by 1",
  files: "select file_name as name from files order by 1",
}

async function readAll(db, userId) {
  return asRole(db, { role: "authenticated", userId }, async (tx) => {
    const seen = {}
    for (const [table, sql] of Object.entries(SCOPED_READS)) {
      seen[table] = (await tx.query(sql)).rows.map((row) => row.name)
    }
    return seen
  })
}

test("a division-restricted member reads only their division's projects and the rows under them", async (t) => {
  const { db, northLead } = await dividedOrg(t)

  const seen = await readAll(db, northLead.userId)

  assert.deepEqual(seen, {
    projects: ["North"],
    contracts: ["North agreement"],
    budgets: ["North"],
    budget_lines: ["North framing"],
    // A project_members row on South does not outrank the division.
    vendor_bills: ["B-North"],
    schedule_items: ["North slab"],
    files: ["North.pdf"],
  })
})

test("a division-restricted member cannot change, delete or add to another division's project", async (t) => {
  const { db, orgId, northLead, northHome, southHome, south } = await dividedOrg(t)
  const as = (fn) => asRole(db, { role: "authenticated", userId: northLead.userId }, fn)

  const touched = await as(async (tx) => ({
    renamed: (await tx.query("update projects set name = 'Mine' where id = $1", [southHome.id])).affectedRows,
    rescheduled: (await tx.query("update schedule_items set name = 'moved' where project_id = $1", [southHome.id])).affectedRows,
    deleted: (await tx.query("delete from contracts where project_id = $1", [southHome.id])).affectedRows,
  }))
  assert.deepEqual(touched, { renamed: 0, rescheduled: 0, deleted: 0 })

  await assert.rejects(
    as((tx) => tx.query("insert into contracts (org_id, project_id, title) values ($1, $2, 'Side deal')", [orgId, southHome.id])),
    /row-level security/,
  )
  await assert.rejects(
    as((tx) => tx.query("insert into projects (org_id, name, division_id) values ($1, 'Elsewhere', $2)", [orgId, south.id])),
    /row-level security/,
  )
  // Re-parenting a reachable project into a foreign division would hand it away.
  await assert.rejects(
    as((tx) => tx.query("update projects set division_id = $2 where id = $1", [northHome.id, south.id])),
    /row-level security/,
  )

  const { rows } = await db.query("select name, division_id from projects where id = $1", [southHome.id])
  assert.deepEqual(rows, [{ name: "South", division_id: south.id }])
})

test("a division-restricted member still works their own division", async (t) => {
  const { db, orgId, north, northLead, northHome } = await dividedOrg(t)

  const result = await asRole(db, { role: "authenticated", userId: northLead.userId }, async (tx) => {
    await tx.query("insert into contracts (org_id, project_id, title) values ($1, $2, 'Addendum')", [orgId, northHome.id])
    const created = await tx.query(
      "insert into projects (org_id, name, division_id) values ($1, 'North 2', $2) returning name",
      [orgId, north.id],
    )
    const renamed = await tx.query("update schedule_items set name = 'North pour' where project_id = $1", [northHome.id])
    return { created: created.rows[0].name, renamed: renamed.affectedRows }
  })

  assert.deepEqual(result, { created: "North 2", renamed: 1 })
})

test("org-wide members and division-restricted admins read every division", async (t) => {
  const { db, ownerId, orgWideLead, northAdmin } = await dividedOrg(t)
  const everything = ["Loose", "North", "South"]

  for (const userId of [ownerId, northAdmin.userId]) {
    const seen = await readAll(db, userId)
    assert.deepEqual(seen.projects, everything)
    assert.deepEqual(seen.vendor_bills, ["B-Loose", "B-North", "B-South"])
    assert.deepEqual(seen.budget_lines, ["Loose framing", "North framing", "South framing"])
  }

  // Not an admin: the existing project-membership rule still hides the bills,
  // but nothing about division narrows what org RLS already showed.
  const lead = await readAll(db, orgWideLead.userId)
  assert.deepEqual(lead.projects, everything)
  assert.deepEqual(lead.contracts, ["Loose agreement", "North agreement", "South agreement"])
  assert.deepEqual(lead.vendor_bills, [])
})

test("an assigned-only member reaches only the projects they belong to", async (t) => {
  const { db, assignedSuper } = await dividedOrg(t)

  const seen = await readAll(db, assignedSuper.userId)

  assert.deepEqual(seen.projects, ["South"])
  assert.deepEqual(seen.contracts, ["South agreement"])
  assert.deepEqual(seen.files, ["South.pdf"])
})

test("taking a division away or moving a project out of it narrows access on the next statement", async (t) => {
  const { db, north, south, northLead, northHome, southHome } = await dividedOrg(t)
  const projects = async () => (await readAll(db, northLead.userId)).projects

  await db.query("update projects set division_id = $2 where id = $1", [southHome.id, north.id])
  assert.deepEqual(await projects(), ["North", "South"])

  await db.query("update projects set division_id = $2 where id = $1", [northHome.id, south.id])
  assert.deepEqual(await projects(), ["South"])

  await db.query("delete from membership_divisions where membership_id = $1", [northLead.membershipId])
  assert.deepEqual(await readAll(db, northLead.userId), {
    projects: [],
    contracts: [],
    budgets: [],
    budget_lines: [],
    vendor_bills: [],
    schedule_items: [],
    files: [],
  })
})

test("rows of another org stay invisible whatever the caller's division scope", async (t) => {
  const { db, ownerId, northLead } = await dividedOrg(t)
  const { orgId: otherOrg } = await seedMember(db, { orgId: uuid() })
  const foreign = await insert(db, "projects", { org_id: otherOrg, name: "Foreign" })
  await stockProject(db, otherOrg, foreign)

  for (const userId of [ownerId, northLead.userId]) {
    const seen = await readAll(db, userId)
    assert.ok(!seen.projects.includes("Foreign"))
    assert.ok(!seen.contracts.includes("Foreign agreement"))
  }
})

test("the scope check is built once per statement, not looked up per row", async (t) => {
  const { db, orgId, ownerId, northLead, north, south } = await dividedOrg(t)
  await db.query(
    `insert into projects (org_id, name, division_id)
     select $1, 'Lot ' || n, case when n % 2 = 0 then $2::uuid else $3::uuid end from generate_series(1, 400) n`,
    [orgId, north.id, south.id],
  )
  await db.query(
    `insert into contracts (org_id, project_id, title)
     select p.org_id, p.id, 'Lot agreement ' || n from projects p cross join generate_series(1, 5) n where p.name like 'Lot %'`,
  )
  await db.exec("analyze projects; analyze contracts")

  const contractsVisibleTo = (userId) =>
    asRole(db, { role: "authenticated", userId }, async (tx) => {
      const { rows } = await tx.query("explain (verbose, costs off) select id from contracts")
      const count = await tx.query("select count(*)::int as n from contracts where title like 'Lot agreement %'")
      return { plan: rows.map((row) => row["QUERY PLAN"]).join("\n"), count: count.rows[0].n }
    })

  // The caller's unscoped orgs are an InitPlan and the restricted caller's
  // reachable projects a hashed SubPlan: neither is a per-row function call.
  for (const userId of [ownerId, northLead.userId]) {
    const { plan } = await contractsVisibleTo(userId)
    assert.match(plan, /InitPlan/)
    assert.match(plan, /hashed SubPlan/)
    assert.doesNotMatch(plan, /member_can_reach_project/)
  }

  assert.equal((await contractsVisibleTo(ownerId)).count, 2000)
  assert.equal((await contractsVisibleTo(northLead.userId)).count, 1000)
})

test("a restricted member creates a project in their division, and detaching its lot leaves it reachable", async (t) => {
  const { db, orgId, northLead, north, northHome } = await dividedOrg(t)
  const as = (fn) => asRole(db, { role: "authenticated", userId: northLead.userId }, fn)
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak", division_id: north.id })
  const lot = await insert(db, "lots", {
    org_id: orgId, community_id: community.id, division_id: north.id, lot_number: "12", status: "started", project_id: northHome.id,
  })

  const created = await as((tx) =>
    tx.query(
      "insert into projects (org_id, name, division_id) values ($1, 'New home', $2) returning name",
      [orgId, north.id],
    ),
  )
  assert.deepEqual(created.rows.map((row) => row.name), ["New home"])

  // A project with no division is outside the member's scope: the application
  // must file it under a division the member holds, as createProject now does.
  await assert.rejects(
    as((tx) => tx.query("insert into projects (org_id, name) values ($1, 'Homeless') returning id", [orgId])),
    /row-level security/,
  )

  // Detaching leaves projects.division_id alone; clearing it is what RLS refuses.
  const detached = await as((tx) =>
    tx.query("update lots set project_id = null, status = 'assigned' where id = $1 returning status", [lot.id]),
  )
  assert.deepEqual(detached.rows.map((row) => row.status), ["assigned"])
  await assert.rejects(
    as((tx) => tx.query("update projects set division_id = null where id = $1", [northHome.id])),
    /row-level security/,
  )
  const reachable = await as((tx) => tx.query("select name from projects where id = $1", [northHome.id]))
  assert.deepEqual(reachable.rows.map((row) => row.name), ["North"])
})

test("an assigned-only member reads a project they created once their project_members row exists", async (t) => {
  const { db, orgId, assignedSuper } = await dividedOrg(t)
  // The service client's write: the row first, then the creator's membership.
  const home = await insert(db, "projects", { org_id: orgId, name: "Created" })
  const as = (fn) => asRole(db, { role: "authenticated", userId: assignedSuper.userId }, fn)
  const names = async () => (await as((tx) => tx.query("select name from projects where name = 'Created'"))).rows.length

  assert.equal(await names(), 0)
  await db.query(
    "insert into project_members (org_id, project_id, user_id, role_id, status) select $1, $2, $3, id, 'active' from roles where key = 'pm'",
    [orgId, home.id, assignedSuper.userId],
  )
  assert.equal(await names(), 1)
})
