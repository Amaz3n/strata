"use strict"

/**
 * `assertProspectWriteAccess()` — the gate every deal edit passes: an unlinked
 * deal needs sales.manage or pipeline.write, a deal
 * linked to a project needs project.manage on THAT project (resolved with the
 * service client, so a project hidden by RLS cannot make the deal look
 * unlinked), closed and delivered deals are read-only, and only a lost deal
 * can be reopened.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { assertProspectWriteAccess } = freshRequire("lib/services/prospect-write-access.ts")

const DEAL = id(1)
const PROJECT = id(2)
const OTHER_PROJECT = id(3)

function harness({ status = "new", project = null, permissions = ["project.manage", "sales.manage"], projects } = {}) {
  return createServiceHarness({
    tables: {
      prospects: [{ id: DEAL, org_id: ORG, status }],
      projects: project ? [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon", ...project }] : [],
    },
    permissions,
    projects,
  })
}

const check = (service, options) =>
  service.run(() => assertProspectWriteAccess({ supabase: service.client, orgId: ORG, userId: ACTOR }, DEAL, options))

test("an unlinked deal takes a desk write key, not a project grant", async () => {
  await check(harness({ permissions: ["sales.manage"] }))
  await check(harness({ permissions: ["pipeline.write"] }))
  await assert.rejects(check(harness({ permissions: ["project.manage"] })), /sales\.manage or pipeline\.write/)
})

test("a linked deal needs project.manage on its own project, even when that project is hidden", async () => {
  await check(harness({ project: {} }))
  const denied = /Missing permission: project\.manage/
  await assert.rejects(check(harness({ project: {}, permissions: ["project.read"] })), denied)
  await assert.rejects(check(harness({ project: {}, projects: [OTHER_PROJECT] })), denied)
})

test("won and delivered deals are read-only; lost deals must be reopened first", async () => {
  for (const [status, project, message] of [
    ["won", null, /in delivery/],
    ["pricing", { phase: "delivery" }, /in delivery/],
    ["lost", null, /Reopen the deal/],
  ]) {
    await assert.rejects(check(harness({ status, project })), message, status)
  }
})

test("only a lost deal can be reopened", async () => {
  await check(harness({ status: "lost" }), { reopen: true })
  await assert.rejects(check(harness({ status: "new" }), { reopen: true }), /Only lost deals/)
})

test("a missing deal or a failed lookup fails closed", async () => {
  const missing = harness()
  missing.db.prospects = []
  await assert.rejects(check(missing), /Prospect not found/)

  for (const table of ["prospects", "projects"]) {
    const service = harness()
    service.tamper(table, replies.error())
    await assert.rejects(check(service), /verify deal access/, table)
  }
})
