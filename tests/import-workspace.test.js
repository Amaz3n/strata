require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, find, findAll, text, button } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

const pushes = []
stubModule("next/link", { __esModule: true, default: "Link" })
stubModule("next/navigation", {
  useRouter: () => ({ push: (href) => pushes.push(href), refresh: () => pushes.push("refresh") }),
})
stubModule("@tanstack/react-virtual", {
  useVirtualizer: ({ count }) => ({
    getTotalSize: () => count * 42,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 42, size: 42 })),
  }),
})
stubModule("sonner", { toast: { success: () => {}, error: () => {} } })
stubLeaves([
  "@/components/icons",
  ...["badge", "button", "dialog", "input", "select", "switch", "tabs"].map((name) => `@/components/ui/${name}`),
])

const { QueuePagination } = require("@/components/layout/queue-pagination")
const { ImportWorkspace } = freshRequire("components/admin/import-workspace.tsx")

const BATCH = "00000000-0000-4000-8000-000000000001"

function workspace(overrides = {}) {
  const invoked = []
  const action = (name) => async () => {
    invoked.push(name)
    return { success: true, data: {} }
  }
  const view = mount(ImportWorkspace, {
    canManage: false,
    orgId: "org",
    importer: "plan_library",
    label: "Plan library",
    description: "",
    columns: [],
    workspaceHref: "/settings/imports/plan_library",
    backHref: "/settings/imports",
    batches: [],
    batchPagination: { page: 3, limit: 25, total: 60 },
    detail: {
      batch: { id: BATCH, status: "staged", row_count: 10000, valid_count: 9993, warning_count: 0, error_count: 7, update_existing: false },
      rows: [{ id: "row", row_number: 1, parsed: {}, status: "error", issues: [], action: null }],
      total: 7,
      page: 2,
      limit: 2,
      status: "error",
    },
    previewAction: action("preview"),
    stageAction: action("stage"),
    patchAction: action("patch"),
    updateExistingAction: action("updateExisting"),
    commitAction: action("commit"),
    discardAction: action("discard"),
    ...overrides,
  })
  return { view, invoked }
}

const params = (href) => new URL(href, "https://arc.test").searchParams

test("a read-only reviewer can inspect and filter a batch but cannot edit, commit, discard or switch modes", async () => {
  const { view, invoked } = workspace()
  const tree = view.render()
  assert.match(text(find(tree, (node) => node.props.role === "status")), /Read-only access/)
  assert.match(text(tree), /Read only/)
  assert.equal(button(tree, "Edit"), undefined)

  const commit = find(tree, (node) => node.type === "Button" && /Commit/.test(text(node.props.children)))
  for (const control of [button(tree, "Discard"), commit, find(tree, (node) => node.type === "Button" && /Stage & validate/.test(text(node.props.children)))]) {
    assert.equal(control.props.disabled, true)
    await control.props.onClick?.()
  }
  const updateMode = find(tree, (node) => node.type === "Switch")
  assert.equal(updateMode.props.disabled, true)
  await updateMode.props.onCheckedChange(true)
  assert.deepEqual(invoked, [])

  const filters = findAll(tree, (node) => node.type === "button")
  assert.ok(filters.length > 0 && filters.every((node) => !node.props.disabled), "status filters stay usable")
})

test("row pages keep the selected batch, status and history page; a new status filter starts at page one", () => {
  const { view } = workspace()
  const tree = view.render()
  const rowPager = find(tree, (node) => node.type === QueuePagination && node.props.pageParam === "rowPage")
  const links = findAll(rowPager, (node) => node.type === "Link")
  assert.ok(links.length > 0)
  for (const link of links) {
    const search = params(link.props.href)
    assert.equal(search.get("batch"), BATCH)
    assert.equal(search.get("rowStatus"), "error")
    assert.equal(search.get("batchPage"), "3")
  }

  pushes.length = 0
  find(tree, (node) => node.type === "button" && node.props["aria-pressed"] === false).props.onClick()
  const select = find(tree, (node) => node.type === "Select" && node.props.value === "error")
  assert.deepEqual(
    findAll(select, (node) => node.type === "SelectItem").map((node) => node.props.value),
    ["all", "pending", "valid", "warning", "error", "skipped", "committed"],
  )
  select.props.onValueChange("skipped")
  const [all, skipped] = pushes.map(params)
  assert.deepEqual([all.get("rowStatus"), all.get("rowPage"), all.get("batch")], ["all", "1", BATCH])
  assert.deepEqual([skipped.get("rowStatus"), skipped.get("rowPage")], ["skipped", "1"])
})
