"use strict"

/**
 * `authorizeEstimateDocumentWrite()` — the gate before any privileged write to
 * a deal's document (save, issue, replace a link). The deal's project is
 * resolved with the service client, so a project hidden from the caller can
 * neither make the document look unlinked nor be skipped; closed and
 * delivered deals refuse document changes outright.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { authorizeEstimateDocumentWrite } = freshRequire("lib/services/estimate-document-authorization.ts")

const DOCUMENT = id(1)
const DEAL = id(2)
const PROJECT = id(3)
const OTHER_PROJECT = id(4)

const MANAGER = ["org.member", "project.manage"]
const DENIED = /Missing permission: project\.manage/

function harness({ document = {}, status = "pricing", project = {}, permissions = MANAGER, projects } = {}) {
  return createServiceHarness({
    tables: {
      estimates: [{ id: DOCUMENT, org_id: ORG, project_id: PROJECT, prospect_id: DEAL, status: "draft", ...document }],
      prospects: [{ id: DEAL, org_id: ORG, status }],
      projects: project ? [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon", ...project }] : [],
    },
    permissions,
    projects,
  })
}

const authorize = (service) => service.run(() => authorizeEstimateDocumentWrite(DOCUMENT))

test("writing a deal's document needs project.manage on the deal's project", async () => {
  assert.equal((await authorize(harness())).projectId, PROJECT)
  await assert.rejects(authorize(harness({ permissions: ["org.member", "project.read"] })), DENIED)
  await assert.rejects(authorize(harness({ projects: [OTHER_PROJECT] })), DENIED)
})

test("a document saved before the deal had a project is authorized against the project it has now", async () => {
  const unlinked = { document: { project_id: null } }
  assert.equal((await authorize(harness(unlinked))).projectId, PROJECT)
  await assert.rejects(authorize(harness({ ...unlinked, projects: [OTHER_PROJECT] })), DENIED)
})

test("closed, delivered or mismatched deals refuse document writes even to a full manager", async () => {
  for (const [options, message] of [
    [{ status: "lost" }, /Reopen this deal/],
    [{ status: "won" }, /Reopen this deal/],
    [{ project: { phase: "delivery" } }, /in delivery/],
    [{ document: { project_id: OTHER_PROJECT } }, /different project/],
  ]) {
    await assert.rejects(authorize(harness(options)), message, JSON.stringify(options))
  }
})

test("a document from another org, or a deal that cannot be read, fails closed", async () => {
  await assert.rejects(authorize(harness({ document: { org_id: id(99) } })), /not found/)
  for (const table of ["prospects", "projects"]) {
    const service = harness()
    service.tamper(table, replies.error())
    await assert.rejects(authorize(service), /Unable to verify the document workspace/, table)
  }
})
