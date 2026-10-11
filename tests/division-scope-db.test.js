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

/**
 * dividedOrg, with land under it: a community in each division, a lot in each
 * holding that division's home, and the field and search rows hanging off the
 * homes. Lots are inserted without a division: the community supplies it.
 */
async function landedOrg(t) {
  const org = await dividedOrg(t)
  const { db, orgId, north, south, northHome, southHome } = org
  const oak = await insert(db, "communities", { org_id: orgId, name: "Oak", division_id: north.id })
  const pine = await insert(db, "communities", { org_id: orgId, name: "Pine", division_id: south.id })
  const oakLot = await insert(db, "lots", { org_id: orgId, community_id: oak.id, lot_number: "Oak 1", status: "started", project_id: northHome.id })
  const pineLot = await insert(db, "lots", { org_id: orgId, community_id: pine.id, lot_number: "Pine 1", status: "started", project_id: southHome.id })
  for (const [project, number] of [[northHome, 1], [southHome, 2]]) {
    await insert(db, "search_documents", { org_id: orgId, project_id: project.id, entity_type: "project", entity_id: project.id, title: project.name })
    await insert(db, "tasks", { org_id: orgId, project_id: project.id, title: `${project.name} walk` })
    await insert(db, "rfis", { org_id: orgId, project_id: project.id, rfi_number: number, subject: `${project.name} beam`, question: "Size?" })
  }
  await insert(db, "tasks", { org_id: orgId, title: "Personal reminder" })
  return { ...org, oak, pine, oakLot, pineLot }
}

const LAND_READS = {
  communities: "select name from communities order by 1",
  lots: "select lot_number as name from lots order by 1",
  search_documents: "select title as name from search_documents order by 1",
  tasks: "select title as name from tasks order by 1",
  rfis: "select subject as name from rfis order by 1",
}

async function readLand(db, userId) {
  return asRole(db, { role: "authenticated", userId }, async (tx) => {
    const seen = {}
    for (const [table, sql] of Object.entries(LAND_READS)) {
      seen[table] = (await tx.query(sql)).rows.map((row) => row.name)
    }
    return seen
  })
}

async function divisionsOf(db, { communityId, projectId }) {
  const lots = await db.query("select division_id from lots where community_id = $1", [communityId])
  const projects = await db.query("select division_id from projects where id = $1", [projectId])
  return { lots: lots.rows.map((row) => row.division_id), project: projects.rows[0].division_id }
}

test("moving a community moves its lots and homes in the same statement and keeps the home's history", async (t) => {
  const { db, ownerId, north, south, oak, northHome } = await landedOrg(t)
  // The clock moves in milliseconds; keep the moment clear of both writes.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  await tick()
  const { rows: [{ at: beforeMove }] } = await db.query("select clock_timestamp() as at")
  await tick()

  await asRole(db, { role: "authenticated", userId: ownerId }, (tx) =>
    tx.query("update communities set division_id = $2 where id = $1", [oak.id, south.id]),
  )

  assert.deepEqual(await divisionsOf(db, { communityId: oak.id, projectId: northHome.id }), {
    lots: [south.id],
    project: south.id,
  })
  const history = await db.query(
    "select division_id, valid_to is null as open, changed_by from project_division_history where project_id = $1 order by valid_from",
    [northHome.id],
  )
  assert.deepEqual(history.rows, [
    { division_id: north.id, open: false, changed_by: null },
    { division_id: south.id, open: true, changed_by: ownerId },
  ])
  const { rows: [then] } = await db.query(
    "select project_division_at($1, $2) as past, project_division_at($1, clock_timestamp()) as now",
    [northHome.id, beforeMove],
  )
  assert.deepEqual(then, { past: north.id, now: south.id })
})

test("a lot always stands in its community's division", async (t) => {
  const { db, orgId, north, south, oak, pine, oakLot } = await landedOrg(t)
  const divisionOf = async (id) => (await db.query("select division_id from lots where id = $1", [id])).rows[0].division_id

  const misfiled = await insert(db, "lots", { org_id: orgId, community_id: oak.id, division_id: south.id, lot_number: "Oak 2" })
  assert.equal(await divisionOf(misfiled.id), north.id)

  await db.query("update lots set division_id = $2 where id = $1", [oakLot.id, south.id])
  assert.equal(await divisionOf(oakLot.id), north.id)

  await db.query("update lots set community_id = $2 where id = $1", [misfiled.id, pine.id])
  assert.equal(await divisionOf(misfiled.id), south.id)
})

test("a division-restricted member reads only their division's communities, lots, search results and field records", async (t) => {
  const { db, ownerId, northLead } = await landedOrg(t)

  assert.deepEqual(await readLand(db, northLead.userId), {
    communities: ["Oak"],
    lots: ["Oak 1"],
    search_documents: ["North"],
    // A personal task has no project and stays with its ordinary policy.
    tasks: ["North walk", "Personal reminder"],
    rfis: ["North beam"],
  })
  assert.deepEqual(await readLand(db, ownerId), {
    communities: ["Oak", "Pine"],
    lots: ["Oak 1", "Pine 1"],
    search_documents: ["North", "South"],
    tasks: ["North walk", "Personal reminder", "South walk"],
    rfis: ["North beam", "South beam"],
  })
})

test("a home's reach follows its community when the community changes division", async (t) => {
  const { db, north, south, oak, pine, northLead } = await landedOrg(t)

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  const gained = await readLand(db, northLead.userId)
  assert.deepEqual(gained.lots, ["Oak 1", "Pine 1"])
  assert.deepEqual(gained.rfis, ["North beam", "South beam"])

  await db.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])
  await db.query("update communities set division_id = $2 where id = $1", [pine.id, south.id])
  assert.deepEqual(await readLand(db, northLead.userId), {
    communities: [],
    lots: [],
    search_documents: [],
    tasks: ["Personal reminder"],
    rfis: [],
  })
})

test("a division-restricted member cannot pull another division's home onto their lot, or a community out of their division", async (t) => {
  const { db, orgId, north, south, oak, pine, northLead } = await landedOrg(t)
  const as = (fn) => asRole(db, { role: "authenticated", userId: northLead.userId }, fn)
  const emptyLot = await insert(db, "lots", { org_id: orgId, community_id: oak.id, lot_number: "Oak 3" })
  const southSpec = await insert(db, "projects", { org_id: orgId, name: "South spec", division_id: south.id })

  await assert.rejects(
    as((tx) => tx.query("update lots set project_id = $2 where id = $1", [emptyLot.id, southSpec.id])),
    /outside the caller's division access/,
  )
  await assert.rejects(
    as((tx) => tx.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])),
    /row-level security/,
  )
  await assert.rejects(
    // Naming the lot's division does not help: it is stamped from the community.
    as((tx) =>
      tx.query("insert into lots (org_id, community_id, division_id, lot_number) values ($1, $2, $3, 'Pine 9')", [orgId, pine.id, north.id]),
    ),
    /row-level security/,
  )

  const { rows } = await db.query("select division_id from projects where id = $1", [southSpec.id])
  assert.deepEqual(rows, [{ division_id: south.id }])
  assert.deepEqual((await db.query("select division_id from communities where id = $1", [oak.id])).rows, [{ division_id: north.id }])
})

test("community and lot search results follow their division", async (t) => {
  const { db, orgId, north, pine, pineLot, northLead } = await landedOrg(t)
  // Indexed as the outbox indexer writes them: no project, no division named.
  await insert(db, "search_documents", { org_id: orgId, entity_type: "community", entity_id: pine.id, title: "Pine community" })
  await insert(db, "search_documents", { org_id: orgId, entity_type: "lot", entity_id: pineLot.id, title: "Pine lot 1" })
  const found = async () => (await readLand(db, northLead.userId)).search_documents

  assert.deepEqual(await found(), ["North"])

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  assert.deepEqual(await found(), ["North", "Pine community", "Pine lot 1", "South"])
})

test("a home's division history starts when it is recorded and stays readable by the division it left", async (t) => {
  const { db, orgId, north, south, oak, northHome, northLead } = await landedOrg(t)
  const imported = await insert(db, "projects", { org_id: orgId, name: "Imported", division_id: north.id, created_at: "2001-01-01T00:00:00Z" })
  const { rows: [started] } = await db.query(
    "select valid_from > now() - interval '1 minute' as recorded_now from project_division_history where project_id = $1",
    [imported.id],
  )
  assert.deepEqual(started, { recorded_now: true })

  await db.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])

  const seen = await asRole(db, { role: "authenticated", userId: northLead.userId }, (tx) =>
    tx.query("select division_id from project_division_history where project_id = $1 order by valid_from", [northHome.id]),
  )
  assert.deepEqual(seen.rows, [{ division_id: north.id }])
})

test("a home on a lot cannot be filed under a division its lot is not in", async (t) => {
  const { db, south, oak, northHome } = await landedOrg(t)

  await assert.rejects(
    db.query("update projects set division_id = $2 where id = $1", [northHome.id, south.id]),
    /stands in its community's division/,
  )

  await db.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])
  const { rows } = await db.query("select division_id from projects where id = $1", [northHome.id])
  assert.deepEqual(rows, [{ division_id: south.id }])
})

test("a lot moved to another community takes its home into that community's division", async (t) => {
  const { db, south, pine, oakLot, northHome } = await landedOrg(t)

  await db.query("update lots set community_id = $2 where id = $1", [oakLot.id, pine.id])

  const { rows } = await db.query("select division_id from projects where id = $1", [northHome.id])
  assert.deepEqual(rows, [{ division_id: south.id }])
})

test("the closing backlog counts a home closed this year for the division it closed in", async (t) => {
  const { db, orgId, ownerId, north, south, oak, oakLot, northHome } = await landedOrg(t)
  await insert(db, "contracts", {
    org_id: orgId, project_id: northHome.id, title: "Purchase agreement", contract_type: "purchase_agreement", status: "active", total_cents: 41_000_000,
  })
  // A closing is recorded closed only with its invoice and a completed gate.
  const invoice = await insert(db, "invoices", { org_id: orgId, project_id: northHome.id, total_cents: 41_000_000 })
  const closing = await insert(db, "closings", { org_id: orgId, project_id: northHome.id, lot_id: oakLot.id, community_id: oak.id, status: "scheduled", scheduled_date: new Date().toISOString().slice(0, 10) })
  await insert(db, "closing_checklist_items", {
    org_id: orgId, closing_id: closing.id, title: "Final walk", is_gate: true, status: "complete", completed_by: ownerId, completed_at: new Date().toISOString(),
  })
  await db.query(
    "update closings set status = 'closed', actual_date = current_date, closing_invoice_id = $2, settlement = '{\"finalPriceCents\": 41000000}' where id = $1",
    [closing.id, invoice.id],
  )
  await db.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])
  // The move happened after the closing day: shift it past today's end.
  await db.query("update project_division_history set valid_to = valid_to + interval '2 days' where project_id = $1 and valid_to is not null", [northHome.id])
  await db.query("update project_division_history set valid_from = valid_from + interval '2 days' where project_id = $1 and valid_to is null", [northHome.id])

  const report = (divisionId) =>
    asRole(db, { role: "authenticated", userId: ownerId }, async (tx) =>
      (await tx.query(
        "select community_name, division_id, closed_units_ytd::int as closed, closed_value_ytd_cents::int as value, backlog_units::int as backlog from get_sales_backlog_report($1, $2)",
        [orgId, divisionId],
      )).rows.filter((row) => row.community_name === "Oak"),
    )

  assert.deepEqual(await report(north.id), [{ community_name: "Oak", division_id: south.id, closed: 1, value: 41_000_000, backlog: 0 }])
  assert.deepEqual(await report(south.id), [{ community_name: "Oak", division_id: south.id, closed: 0, value: 0, backlog: 0 }])
  assert.deepEqual(await report(null), [{ community_name: "Oak", division_id: south.id, closed: 1, value: 41_000_000, backlog: 0 }])
})

/** landedOrg, with a lead in each community, an unattributed walk-in, and a seller limited to North. */
async function salesOrg(t) {
  const org = await landedOrg(t)
  const { db, orgId, north, oak, pine } = org
  const leads = {}
  for (const [name, community] of [["Oak lead", oak], ["Pine lead", pine], ["Walk-in", null]]) {
    leads[name] = await insert(db, "prospects", { org_id: orgId, name, community_id: community?.id ?? null })
    // Indexed as the outbox indexer writes it: no project, no division named.
    await insert(db, "search_documents", { org_id: orgId, entity_type: "prospect", entity_id: leads[name].id, title: name })
  }
  const seller = await member(db, orgId, { role: "org_sales_agent", divisionScope: "assigned", divisions: [north.id] })
  return { ...org, leads, seller }
}

async function leadsSeenBy(db, userId) {
  return asRole(db, { role: "authenticated", userId }, async (tx) => ({
    prospects: (await tx.query("select name from prospects order by 1")).rows.map((row) => row.name),
    search: (await tx.query("select title from search_documents where entity_type = 'prospect' order by 1")).rows.map((row) => row.title),
  }))
}

test("a division-limited seller reads their division's leads and unattributed ones, never another division's", async (t) => {
  const { db, orgId, ownerId, seller, leads, oak, pine } = await salesOrg(t)

  assert.deepEqual(await leadsSeenBy(db, seller.userId), {
    prospects: ["Oak lead", "Walk-in"],
    search: ["Oak lead", "Walk-in"],
  })
  assert.deepEqual(await leadsSeenBy(db, ownerId), {
    prospects: ["Oak lead", "Pine lead", "Walk-in"],
    search: ["Oak lead", "Pine lead", "Walk-in"],
  })

  const as = (fn) => asRole(db, { role: "authenticated", userId: seller.userId }, fn)
  const renamed = await as((tx) => tx.query("update prospects set name = 'Mine' where id = $1", [leads["Pine lead"].id]))
  assert.equal(renamed.affectedRows, 0)
  await assert.rejects(
    as((tx) => tx.query("update prospects set community_id = $2 where id = $1", [leads["Oak lead"].id, pine.id])),
    /row-level security/,
  )

  // Their own division's work goes on as before.
  const worked = await as(async (tx) => ({
    added: (await tx.query("insert into prospects (org_id, name, community_id) values ($1, 'Oak 2', $2) returning name", [orgId, oak.id])).rows[0].name,
    walkIn: (await tx.query("insert into prospects (org_id, name) values ($1, 'Walk-in 2') returning name", [orgId])).rows[0].name,
    updated: (await tx.query("update prospects set notes = 'Wants a corner lot' where id = $1", [leads["Oak lead"].id])).affectedRows,
  }))
  assert.deepEqual(worked, { added: "Oak 2", walkIn: "Walk-in 2", updated: 1 })
})

test("a lead's search result follows its community, and the community's division", async (t) => {
  const { db, north, south, oak, pine, seller, leads } = await salesOrg(t)
  const searched = async () => (await leadsSeenBy(db, seller.userId)).search

  await db.query("update prospects set community_id = $2 where id = $1", [leads["Oak lead"].id, pine.id])
  assert.deepEqual(await searched(), ["Walk-in"])

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  assert.deepEqual(await searched(), ["Oak lead", "Pine lead", "Walk-in"])

  await db.query("update communities set division_id = $2 where id = $1", [oak.id, south.id])
  await db.query("update communities set division_id = $2 where id = $1", [pine.id, south.id])
  assert.deepEqual(await searched(), ["Walk-in"])
})

test("start packages and project records indexed without a project stay in their division", async (t) => {
  const { db, orgId, north, oak, pine, oakLot, pineLot, southHome, northLead } = await landedOrg(t)
  const oakStart = await insert(db, "start_packages", { org_id: orgId, lot_id: oakLot.id, community_id: oak.id })
  const pineStart = await insert(db, "start_packages", { org_id: orgId, lot_id: pineLot.id, community_id: pine.id })
  const meeting = await insert(db, "meetings", { org_id: orgId, project_id: southHome.id, meeting_number: 1, title: "South OAC" })
  for (const [type, id, title] of [["start_package", oakStart.id, "Oak start"], ["start_package", pineStart.id, "Pine start"], ["meeting", meeting.id, "South OAC"]]) {
    await insert(db, "search_documents", { org_id: orgId, entity_type: type, entity_id: id, title })
  }
  const seen = () =>
    asRole(db, { role: "authenticated", userId: northLead.userId }, async (tx) => ({
      starts: (await tx.query("select community_id from start_packages order by 1")).rows.map((row) => row.community_id),
      search: (await tx.query("select title from search_documents where entity_type <> 'project' order by 1")).rows.map((row) => row.title),
    }))

  assert.deepEqual(await seen(), { starts: [oak.id], search: ["Oak start"] })

  // The lot carries its package's division, and the home its meeting's.
  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  assert.deepEqual(await seen(), { starts: [oak.id, pine.id].sort(), search: ["Oak start", "Pine start", "South OAC"] })
})

/**
 * One row in each division for a sample of the tables that hang off a home, a
 * lead, a lot or a community. `row(side, n)` builds a row for the North or
 * South side; `n` keeps per-project numbers unique. `label` names the column
 * the test reads back and writes to.
 */
async function wallOrg(t) {
  const org = await salesOrg(t)
  const { db, orgId, northHome, southHome, oak, pine, oakLot, pineLot, leads } = org
  const contractOf = async (project) =>
    (await db.query("select id from contracts where project_id = $1 limit 1", [project.id])).rows[0].id
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Ada Buyer" })
  const sides = {
    North: { home: northHome, contract: await contractOf(northHome), community: oak, lot: oakLot, lead: leads["Oak lead"] },
    South: { home: southHome, contract: await contractOf(southHome), community: pine, lot: pineLot, lead: leads["Pine lead"] },
  }
  const tables = {
    meetings: { label: "title", row: (s, n) => ({ project_id: s.home.id, meeting_number: n, title: `${s.name} ${n}` }) },
    inspections: {
      label: "title",
      row: (s, n) => ({ project_id: s.home.id, inspection_number: n, kind: "quality", title: `${s.name} ${n}` }),
    },
    warranty_requests: { label: "title", row: (s, n) => ({ project_id: s.home.id, request_number: n, title: `${s.name} ${n}` }) },
    pay_applications: {
      label: "application_number",
      row: (s, n) => ({ project_id: s.home.id, contract_id: s.contract, application_number: s.name === "North" ? n : 10 + n, period_end: "2026-09-30" }),
    },
    estimates: { label: "title", row: (s, n) => ({ project_id: s.home.id, title: `${s.name} ${n}` }) },
    lot_reservations: {
      label: "notes",
      // Released, so a lot may carry several.
      row: (s, n) => ({ community_id: s.community.id, lot_id: s.lot.id, buyer_contact_id: buyer.id, status: "released", notes: `${s.name} ${n}` }),
    },
    prospect_contacts: { label: "full_name", row: (s, n) => ({ prospect_id: s.lead.id, full_name: `${s.name} ${n}` }) },
    community_phases: { label: "name", row: (s, n) => ({ community_id: s.community.id, phase_number: n, name: `${s.name} ${n}` }) },
  }
  for (const [name, side] of Object.entries(sides)) side.name = name
  for (const [table, { row }] of Object.entries(tables)) {
    for (const side of Object.values(sides)) await insert(db, table, { org_id: orgId, ...row(side, 1) })
  }
  return { ...org, sides, tables }
}

test("every record under a home, a lead, a lot or a community stays in its division", async (t) => {
  const { db, orgId, ownerId, northLead, seller, sides, tables } = await wallOrg(t)
  // The lead manages the homes; deal records are the seller's to write.
  const actorFor = (table) => (table === "prospect_contacts" ? seller : northLead)
  const read = (userId, table) =>
    asRole(db, { role: "authenticated", userId }, async (tx) =>
      (await tx.query(`select ${tables[table].label}::text as label from ${table} order by 1`)).rows.map((row) => row.label),
    )
  const labelOf = (table, side) => String(tables[table].row(sides[side], 1)[tables[table].label])

  for (const table of Object.keys(tables)) {
    const north = labelOf(table, "North")
    const south = labelOf(table, "South")
    const as = (fn) => asRole(db, { role: "authenticated", userId: actorFor(table).userId }, fn)

    assert.deepEqual(await read(actorFor(table).userId, table), [north], `${table}: limited read`)
    assert.deepEqual(await read(ownerId, table), [north, south].sort(), `${table}: all-division read`)

    const { label } = tables[table]
    const touched = await as(async (tx) => ({
      north: (await tx.query(`update ${table} set ${label} = ${label} where org_id = $1 and ${label}::text = $2`, [orgId, north])).affectedRows,
      south: (await tx.query(`update ${table} set ${label} = ${label} where org_id = $1 and ${label}::text = $2`, [orgId, south])).affectedRows,
    }))
    assert.deepEqual(touched, { north: 1, south: 0 }, `${table}: limited update`)

    const insertAs = (side) => {
      const row = { org_id: orgId, ...tables[table].row(sides[side], 2) }
      const columns = Object.keys(row)
      return as((tx) =>
        tx.query(
          `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(row),
        ),
      )
    }
    await insertAs("North")
    // Some tables refuse in a lifecycle trigger before RLS is asked.
    await assert.rejects(insertAs("South"), /row-level security|division access/, `${table}: limited insert`)
  }
})

/**
 * wallOrg, with rows under the walled records: each child names its parent
 * only by id. `parent(side)` builds a side's parent; `row(parentId, n)` its child.
 */
async function childOrg(t) {
  const org = await wallOrg(t)
  const { db, orgId, sides } = org
  const idOf = async (table, project) =>
    (await db.query(`select id from ${table} where project_id = $1 limit 1`, [project.id])).rows[0].id
  const companies = [
    await insert(db, "companies", { org_id: orgId, name: "Framing Co" }),
    await insert(db, "companies", { org_id: orgId, name: "Concrete Co" }),
  ]
  for (const side of Object.values(sides)) {
    const sovLines = []
    for (const lineNumber of [1, 2]) {
      sovLines.push(await insert(db, "prime_sov_lines", {
        org_id: orgId, project_id: side.home.id, contract_id: side.contract, line_number: lineNumber, description: `Line ${lineNumber}`,
      }))
    }
    side.parents = {
      pay_application_lines: { parentId: await idOf("pay_applications", side.home), sovLines },
      estimate_items: { parentId: await idOf("estimates", side.home) },
      meeting_attendees: { parentId: await idOf("meetings", side.home) },
      invoice_lines: { parentId: (await insert(db, "invoices", { org_id: orgId, project_id: side.home.id })).id },
      closing_checklist_items: {
        parentId: (await insert(db, "closings", {
          org_id: orgId, project_id: side.home.id, lot_id: side.lot.id, community_id: side.community.id, status: "scheduled", scheduled_date: "2026-12-01",
        })).id,
      },
      bid_invites: { parentId: (await insert(db, "bid_packages", { org_id: orgId, project_id: side.home.id, title: `${side.name} framing` })).id },
    }
  }
  const children = {
    pay_application_lines: {
      label: "scheduled_value_cents",
      row: (s, p, n) => ({
        pay_application_id: p.parentId, prime_sov_line_id: p.sovLines[n - 1].id,
        scheduled_value_cents: (s.name === "North" ? 100 : 200) + n, previous_billed_cents: 0, balance_to_finish_cents: 0,
      }),
    },
    estimate_items: { label: "description", row: (s, p, n) => ({ estimate_id: p.parentId, description: `${s.name} ${n}` }) },
    bid_invites: {
      label: "invite_email",
      row: (s, p, n) => ({ bid_package_id: p.parentId, company_id: companies[n - 1].id, invite_email: `${s.name.toLowerCase()}${n}@trades.test` }),
    },
    meeting_attendees: { label: "display_name", row: (s, p, n) => ({ meeting_id: p.parentId, display_name: `${s.name} ${n}` }) },
    closing_checklist_items: { label: "title", row: (s, p, n) => ({ closing_id: p.parentId, title: `${s.name} ${n}` }) },
    // Written only by the service role: the wall is on what members read.
    invoice_lines: { label: "description", readOnly: true, row: (s, p, n) => ({ invoice_id: p.parentId, description: `${s.name} ${n}` }) },
  }
  for (const [table, { row }] of Object.entries(children)) {
    for (const side of Object.values(sides)) await insert(db, table, { org_id: orgId, ...row(side, side.parents[table], 1) })
  }
  return { ...org, children }
}

test("the rows under a walled record stay in its division", async (t) => {
  const { db, orgId, ownerId, northLead, sides, children } = await childOrg(t)
  const labelOf = (table, side, n = 1) => String(children[table].row(sides[side], sides[side].parents[table], n)[children[table].label])
  const read = (userId, table) =>
    asRole(db, { role: "authenticated", userId }, async (tx) =>
      (await tx.query(`select ${children[table].label}::text as label from ${table} order by 1`)).rows.map((row) => row.label),
    )

  for (const [table, { label, readOnly }] of Object.entries(children)) {
    const north = labelOf(table, "North")
    const south = labelOf(table, "South")
    const as = (fn) => asRole(db, { role: "authenticated", userId: northLead.userId }, fn)
    const where = `org_id = $1 and ${label}::text = $2`

    assert.deepEqual(await read(northLead.userId, table), [north], `${table}: limited read`)
    assert.deepEqual(await read(ownerId, table), [north, south].sort(), `${table}: all-division read`)
    if (readOnly) continue

    const insertUnder = (side) => {
      const row = { org_id: orgId, ...children[table].row(sides.North, sides[side].parents[table], 2) }
      const columns = Object.keys(row)
      return as((tx) =>
        tx.query(`insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row)),
      )
    }
    await assert.rejects(insertUnder("South"), /row-level security/, `${table}: insert under a South parent`)
    await insertUnder("North")

    const touched = await as(async (tx) => ({
      updatedNorth: (await tx.query(`update ${table} set ${label} = ${label} where ${where}`, [orgId, north])).affectedRows,
      updatedSouth: (await tx.query(`update ${table} set ${label} = ${label} where ${where}`, [orgId, south])).affectedRows,
      deletedSouth: (await tx.query(`delete from ${table} where ${where}`, [orgId, south])).affectedRows,
      deletedNorth: (await tx.query(`delete from ${table} where ${where}`, [orgId, north])).affectedRows,
    }))
    assert.deepEqual(touched, { updatedNorth: 1, updatedSouth: 0, deletedSouth: 0, deletedNorth: 1 }, `${table}: limited writes`)
    assert.deepEqual(await read(ownerId, table), [labelOf(table, "North", 2), south].sort(), `${table}: South untouched`)
  }
})

test("a record filed on a lead is found only by its lead's division", async (t) => {
  const { db, orgId, ownerId, north, pine, seller, leads } = await salesOrg(t)
  for (const name of ["Oak lead", "Pine lead", "Walk-in"]) {
    const estimate = await insert(db, "estimates", { org_id: orgId, prospect_id: leads[name].id, title: `${name} estimate` })
    // Indexed as the outbox indexer writes it: no project, no division named.
    await insert(db, "search_documents", { org_id: orgId, entity_type: "estimate", entity_id: estimate.id, title: `${name} estimate` })
  }
  const found = (userId) =>
    asRole(db, { role: "authenticated", userId }, async (tx) =>
      (await tx.query("select title from search_documents where entity_type = 'estimate' order by 1")).rows.map((row) => row.title),
    )

  assert.deepEqual(await found(seller.userId), ["Oak lead estimate", "Walk-in estimate"])
  assert.deepEqual(await found(ownerId), ["Oak lead estimate", "Pine lead estimate", "Walk-in estimate"])

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  assert.deepEqual(await found(seller.userId), ["Oak lead estimate", "Pine lead estimate", "Walk-in estimate"])

  await db.query("update prospects set community_id = null where id = $1", [leads["Oak lead"].id])
  await db.query("update communities set division_id = null where id = $1", [pine.id])
  assert.deepEqual(await found(seller.userId), ["Oak lead estimate", "Pine lead estimate", "Walk-in estimate"])
})

test("a bid package bid for a community is found only by that community's division", async (t) => {
  const { db, orgId, ownerId, north, south, oak, pine, seller } = await salesOrg(t)
  for (const community of [oak, pine]) {
    const pkg = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: `${community.name} framing`, status: "draft" })
    // Indexed as the outbox indexer writes it: no project, no division named.
    await insert(db, "search_documents", { org_id: orgId, entity_type: "bid_package", entity_id: pkg.id, title: `${community.name} framing` })
  }
  const found = (userId) =>
    asRole(db, { role: "authenticated", userId }, async (tx) =>
      (await tx.query("select title from search_documents where entity_type = 'bid_package' order by 1")).rows.map((row) => row.title),
    )

  assert.deepEqual(await found(seller.userId), ["Oak framing"])
  assert.deepEqual(await found(ownerId), ["Oak framing", "Pine framing"])

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, north.id])
  assert.deepEqual(await found(seller.userId), ["Oak framing", "Pine framing"])

  await db.query("update communities set division_id = $2 where id = $1", [pine.id, south.id])
  await db.query("update bid_packages set community_id = $2 where community_id = $1", [oak.id, pine.id])
  assert.deepEqual(await found(seller.userId), [])
})
