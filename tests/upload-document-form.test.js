const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")

// Boundaries: the browser transfer queue (IndexedDB + storage) and the
// organization upload server action.
const queued = []
const orgUploads = []
stubModule("lib/files/active-transfer-queue.ts", {
  getActiveDocumentTransferQueue: () => ({
    async enqueue(file, options) {
      queued.push({ file, options })
      return { id: "project-file", file_name: file.name }
    },
  }),
})
stubModule("app/(app)/documents/actions.ts", {
  async uploadFileAction(form) {
    orgUploads.push(form)
    return { success: true, data: { id: "org-file" } }
  },
})

const { uploadDocumentForm } = freshRequire("lib/files/upload-document-form.ts")

function projectForm(fields = {}) {
  const form = new FormData()
  form.set("file", new File(["content"], "report.pdf", { type: "application/pdf" }))
  form.set("projectId", "project")
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

beforeEach(() => {
  queued.length = 0
  orgUploads.length = 0
})

test("a project upload carries every form field through the transfer queue", async () => {
  const result = await uploadDocumentForm(
    projectForm({
      folderPath: "/Contracts",
      category: "contracts",
      visibility: "private",
      description: "Signed copy",
      tags: " one, two , ,three",
      shareWithClients: "true",
      shareWithSubs: "false",
    }),
  )

  assert.deepEqual(result, { success: true, data: { id: "project-file", file_name: "report.pdf" } })
  assert.deepEqual(queued[0].options, {
    projectId: "project",
    folderPath: "/Contracts",
    category: "contracts",
    visibility: "private",
    description: "Signed copy",
    tags: ["one", "two", "three"],
    shareWithClients: true,
    shareWithSubs: false,
  })
  assert.equal(orgUploads.length, 0)
})

test("an absent folder keeps the category default; an empty one selects the root", async () => {
  await uploadDocumentForm(projectForm())
  await uploadDocumentForm(projectForm({ folderPath: "" }))

  const [absent, root] = queued.map((entry) => entry.options)
  assert.equal(absent.folderPath, undefined)
  assert.equal(root.folderPath, "")
  assert.equal(absent.visibility, "public")
  assert.equal(absent.shareWithClients, undefined)
  assert.deepEqual(absent.tags, [])
})

test("an upload without a project goes through the organization action unchanged", async () => {
  const form = projectForm()
  form.delete("projectId")

  assert.deepEqual(await uploadDocumentForm(form), { success: true, data: { id: "org-file" } })
  assert.equal(orgUploads[0], form)
  assert.equal(queued.length, 0)
})

test("a missing file or an unknown category fails the action without uploading", async () => {
  const noFile = new FormData()
  noFile.set("file", "not a file")

  assert.deepEqual(await uploadDocumentForm(noFile), { success: false, error: "No file provided" })
  assert.equal((await uploadDocumentForm(projectForm({ category: "invalid" }))).success, false)
  assert.equal(queued.length + orgUploads.length, 0)
})
