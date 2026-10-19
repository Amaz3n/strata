require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { projectIdFromDocumentStoragePath } = require("../lib/files/content-policy")

test("an upload path names its project only inside the caller's org upload namespace", () => {
  const cases = [
    ["org/general/documents/uploads/handbook.pdf", "general"],
    ["org/project-1/documents/uploads/plans.pdf", "project-1"],
    ["other/general/documents/uploads/handbook.pdf", null], // another org
    ["org/general/documents/handbook.pdf", null], // outside uploads
    ["org/general/documents/uploads/../private.pdf", null], // traversal
    ["org/general/documents/uploads/", null], // no object
  ]
  for (const [path, expected] of cases) {
    assert.equal(projectIdFromDocumentStoragePath("org", path), expected, path)
  }
})
