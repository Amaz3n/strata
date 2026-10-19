const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")
const { recordingService } = require("./support/mobile")

// The project workbench's punch actions (their own suite).
const saved = []
stubModule(
  "app/(app)/projects/[id]/actions.ts",
  recordingService(saved, {
    createProjectPunchItemAction: { success: true, data: { id: "punch-a" } },
    updateProjectPunchItemAction: { success: true, data: { id: "punch-a" } },
  }),
)

const { saveWorkspacePunch } = freshRequire("lib/mobile/workspace-punch.ts")

beforeEach(() => {
  saved.length = 0
})

test("a new punch item cannot carry an assignment, and form strings become typed values", async () => {
  await saveWorkspacePunch("project-a", {
    title: "Repair door",
    due_date: "",
    verification_required: "false",
    assigned_company_id: "other-org",
  })

  const [[name, projectId, input]] = saved
  assert.equal(name, "createProjectPunchItemAction")
  assert.equal(projectId, "project-a")
  assert.equal(input.assigned_company_id, undefined)
  assert.equal(input.verification_required, false)
  assert.equal(input.due_date, null)
})

test("an unknown workflow state or an unreadable date saves nothing", async () => {
  await assert.rejects(saveWorkspacePunch("project-a", { title: "Repair door", status: "invalid" }, "punch-a"))
  await assert.rejects(saveWorkspacePunch("project-a", { title: "Repair door", due_date: "tomorrow" }))
  assert.deepEqual(saved, [])
})
