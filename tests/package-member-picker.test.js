require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, findAll, find, text, button, settle } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

// Remote discovery is a server action: each call waits for the test to answer it.
let requests = []
const discovery = (domain) => (input) =>
  new Promise((resolve) => {
    requests.push({ domain, input, resolve })
  })
stubModule("@/app/(app)/design-studio/actions", {
  discoverCatalogPackageMembersAction: discovery("package"),
  discoverCatalogGroupCategoriesAction: discovery("group"),
})
stubLeaves(["@/components/ui/button", "@/components/ui/checkbox", "@/components/ui/input"])

const { PackageMemberPicker } = freshRequire("components/design-studio/package-member-picker.tsx")

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MISSING = id(99999)

/** `count` available options, 100 per category; option n has id(n). */
function catalog(count) {
  return Array.from({ length: Math.ceil(count / 100) }, (_, c) => ({
    id: id(20000 + c),
    name: `Category ${c}`,
    options: Array.from({ length: Math.min(100, count - c * 100) }, (_, n) => ({
      id: id(c * 100 + n + 1),
      name: `Option ${c * 100 + n + 1}`,
      is_available: true,
    })),
  }))
}

function picker(props) {
  const toggled = []
  const view = mount(PackageMemberPicker, {
    categories: [],
    selectedIds: [],
    disabled: false,
    onToggle: (...args) => toggled.push(args),
    ...props,
  })
  return { view, toggled }
}

const rows = (tree) => findAll(tree, (node) => node.type === "li")
const checkboxes = (tree) => findAll(tree, (node) => node.type === "Checkbox")
const search = (tree, value) => find(tree, (node) => node.type === "Input").props.onChange({ target: { value } })

// --- a catalog loaded with the page -------------------------------------------

test("all 10,000 options are reachable 20 at a time without submitting the form", () => {
  const { view } = picker({ categories: catalog(10000) })
  const seen = new Set()
  for (let page = 1; page <= 500; page++) {
    const tree = view.render()
    assert.equal(rows(tree).length, 20)
    for (const row of rows(tree)) seen.add(text(row))
    const next = button(tree, "Next members")
    assert.equal(next.props.type, "button")
    assert.equal(next.props.disabled, page === 500)
    if (page < 500) next.props.onClick()
  }
  assert.equal(seen.size, 10000)
  assert.match(text(view.render()), /Showing 9981–10000 of 10000/)
  button(view.render(), "Previous members").props.onClick()
  assert.match(text(view.render()), /Showing 9961–9980 of 10000/)
})

test("search and selected review reset paging and still show a selected member that left the catalog", () => {
  const { view } = picker({ categories: catalog(300), selectedIds: [id(1), MISSING] })
  button(view.render(), "Next members").props.onClick()
  search(view.render(), "Category 2")
  assert.match(text(view.render()), /Showing 1–20 of 100/)

  search(view.render(), "")
  button(view.render(), "Review selected members").props.onClick()
  const review = view.render()
  assert.equal(rows(review).length, 2)
  assert.match(text(review), /Member unavailable/)
  assert.deepEqual(view.props.selectedIds, [id(1), MISSING])

  search(review, MISSING)
  assert.equal(rows(view.render()).length, 1)
})

test("an unavailable option cannot be added, a selected obsolete one can be removed, and disabled means inert", () => {
  const categories = catalog(2)
  categories[0].options[0].is_available = false
  const { view, toggled } = picker({ categories, selectedIds: [MISSING] })
  const [obsolete, unavailable] = checkboxes(view.render())
  assert.equal(obsolete.props.disabled, false)
  obsolete.props.onCheckedChange()
  assert.deepEqual(toggled, [[MISSING]])
  assert.equal(unavailable.props.disabled, true)
  unavailable.props.onCheckedChange()
  assert.equal(toggled.length, 1)

  view.props = { ...view.props, disabled: true }
  const tree = view.render()
  checkboxes(tree)[0].props.onCheckedChange()
  button(tree, "Review selected members").props.onClick()
  assert.equal(toggled.length, 1)
  assert.ok(button(view.render(), "Review selected members"), "still on the full list")
})

test("at the 100-member limit an option can replace its category's choice but cannot open a new category", () => {
  const selected = Array.from({ length: 100 }, (_, n) => id(n * 100 + 1))
  const { view, toggled } = picker({ categories: catalog(10100), selectedIds: selected })
  search(view.render(), "Category 100")
  const newCategory = checkboxes(view.render())[0]
  assert.equal(newCategory.props.disabled, true)
  newCategory.props.onCheckedChange()
  assert.equal(toggled.length, 0)

  search(view.render(), "Option 2")
  const replacement = checkboxes(view.render())[0]
  assert.equal(replacement.props.disabled, false)
  replacement.props.onCheckedChange()
  assert.deepEqual(toggled, [[id(2)]])
})

// --- remote discovery (no bootstrap catalog) ----------------------------------

const SCOPE = { expectedOrgId: id(1), expectedActorId: id(2), communityId: null }

function remote(selectedIds = [], domain = "package") {
  requests = []
  if (domain === "package") return picker({ discoveryScope: SCOPE, selectedIds })
  const { CatalogMemberPicker } = require("@/components/design-studio/catalog-member-picker")
  const toggled = []
  const view = mount(CatalogMemberPicker, {
    scope: SCOPE,
    domain,
    selectedIds,
    disabled: false,
    onToggle: (...args) => toggled.push(args),
  })
  return { view, toggled }
}

/** A page of discovered members; `answer(n, items)` resolves request n with it. */
const member = (n, category = 200) => ({
  id: id(n),
  name: `Remote option ${n}`,
  categoryId: id(category),
  categoryKey: id(category),
  categoryName: `Remote category ${category}`,
  available: true,
})
const gone = (n) => ({ ...member(n), name: null, categoryName: null, categoryId: null, categoryKey: null, available: false })
const answer = (n, items, nextCursor = null) => requests[n].resolve({ success: true, data: { items, nextCursor } })
const refuse = (n, error) => requests[n].resolve({ success: false, error })

test("remote paging needs no bootstrap catalog and resolves selected members outside the current page", async () => {
  const { view, toggled } = remote([id(9999)])
  assert.equal(rows(view.render()).length, 0)
  assert.equal(requests.length, 2, "one page and one selection lookup")

  answer(0, Array.from({ length: 20 }, (_, n) => member(n + 1)), id(20))
  answer(1, [gone(9999)])
  await settle()
  let tree = view.render()
  assert.equal(rows(tree).length, 20)
  checkboxes(tree)[0].props.onCheckedChange()
  assert.equal(toggled[0][0], id(1))
  assert.equal(toggled[0][1].length, 21, "the page plus the selected member travel with the toggle")

  button(tree, "Review selected members").props.onClick()
  tree = view.render()
  assert.equal(rows(tree).length, 1)
  assert.match(text(tree), /Member unavailable/)
  checkboxes(tree)[0].props.onCheckedChange()
  assert.equal(toggled[1][0], id(9999))

  button(tree, "Show all options").props.onClick()
  button(view.render(), "Next members").props.onClick()
  assert.equal(rows(view.render()).length, 0, "the next page is loading")
  assert.equal(requests[2].input.cursor, id(20))
  assert.deepEqual(requests[3].input.selectedIds, [id(9999)])

  answer(2, [member(21)])
  answer(3, [gone(9999)])
  await settle()
  tree = view.render()
  assert.equal(rows(tree).length, 1)
  assert.equal(button(tree, "Next members").props.disabled, true)
  button(tree, "Previous members").props.onClick()
  view.render()
  assert.equal(requests[4].input.cursor, null)
})

test("a newer query or selection discards stale replies, and a failure keeps the selection with a retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { view } = remote([id(90)])
  search(view.render(), "updated")
  view.render()
  t.mock.timers.tick(250)
  view.render()
  assert.equal(requests[2].input.query, "updated")

  answer(0, [member(1)])
  answer(1, [member(90)])
  await settle()
  assert.equal(rows(view.render()).length, 0, "the old query's reply is ignored")

  refuse(2, "Access changed")
  answer(3, [member(90)])
  await settle()
  const failed = view.render()
  assert.match(text(failed), /Access changed/)
  assert.deepEqual(view.props.selectedIds, [id(90)])
  button(failed, "Retry member discovery").props.onClick()
  view.render()
  assert.equal(requests.length, 6)

  answer(4, [member(2)])
  answer(5, [member(90)])
  await settle()
  assert.equal(rows(view.render()).length, 1)

  view.props = { ...view.props, selectedIds: [id(91)] }
  assert.equal(rows(view.render()).length, 0)
  assert.deepEqual(requests[7].input.selectedIds, [id(91)])
})

test("remote review reaches all 100 selected members and allows same-category replacement at the limit", async () => {
  const selected = Array.from({ length: 100 }, (_, n) => id(1000 + n))
  const { view, toggled } = remote(selected)
  view.render()
  answer(0, [member(2000, 300), member(2001, 999)])
  answer(1, selected.map((_, n) => member(1000 + n, 300 + n)))
  await settle()
  const tree = view.render()
  const [replacement, newCategory] = checkboxes(tree)
  assert.equal(replacement.props.disabled, false)
  assert.equal(newCategory.props.disabled, true)
  replacement.props.onCheckedChange()
  newCategory.props.onCheckedChange()
  assert.deepEqual(toggled.map(([toggledId]) => toggledId), [id(2000)])

  button(tree, "Review selected members").props.onClick()
  const seen = new Set()
  for (let page = 0; page < 5; page++) {
    const current = view.render()
    assert.equal(rows(current).length, 20)
    for (const row of rows(current)) seen.add(text(row))
    const next = button(current, "Next members")
    assert.equal(next.props.disabled, page === 4)
    if (page < 4) next.props.onClick()
  }
  assert.equal(seen.size, 100)
})

test("a change of actor discards the old actor's results, and a disabled picker changes nothing", async () => {
  const { view, toggled } = remote()
  view.render()
  view.props = { ...view.props, discoveryScope: { ...SCOPE, expectedActorId: id(3) } }
  view.render()
  assert.equal(requests[2].input.expectedActorId, id(3))
  answer(0, [member(1)])
  answer(1, [])
  await settle()
  assert.equal(rows(view.render()).length, 0)

  answer(2, [member(2)])
  answer(3, [])
  await settle()
  view.props = { ...view.props, disabled: true }
  const tree = view.render()
  checkboxes(tree)[0].props.onCheckedChange()
  search(tree, "ignored")
  button(tree, "Review selected members").props.onClick()
  const after = view.render()
  assert.equal(toggled.length, 0)
  assert.equal(requests.length, 4)
  assert.equal(find(after, (node) => node.type === "Input").props.value, "")
  assert.ok(button(after, "Review selected members"))
})

test("the rule-category browser pages all 100 references and replaces within a family", async () => {
  const selected = Array.from({ length: 100 }, (_, n) => id(1000 + n))
  const { view, toggled } = remote(selected, "group")
  view.render()
  assert.ok(requests.every((request) => request.domain === "group"))
  answer(0, [
    { ...member(2000, 300), categoryId: id(2000) },
    { ...member(2001, 999), categoryId: id(2001) },
  ])
  answer(1, selected.map((_, n) => ({ ...member(1000 + n, 300 + n), categoryId: id(1000 + n) })))
  await settle()
  const tree = view.render()
  const [replacement, newFamily] = checkboxes(tree)
  assert.equal(replacement.props.disabled, false)
  assert.equal(newFamily.props.disabled, true)
  replacement.props.onCheckedChange()
  assert.equal(toggled[0][0], id(2000))

  button(tree, "Review selected categories").props.onClick()
  const seen = new Set()
  for (let page = 0; page < 5; page++) {
    const current = view.render()
    assert.equal(rows(current).length, 20)
    for (const row of rows(current)) seen.add(text(row))
    if (page < 4) button(current, "Next categories").props.onClick()
  }
  assert.equal(seen.size, 100)
})

test("the rule-category browser retries a failure and keeps an unavailable selected reference removable", async () => {
  const { view, toggled } = remote([id(99)], "group")
  view.render()
  view.props = { ...view.props, scope: { ...SCOPE, expectedActorId: id(3) } }
  view.render()
  answer(0, [member(1)])
  answer(1, [member(99)])
  await settle()
  assert.equal(rows(view.render()).length, 0)

  refuse(2, "Category access changed")
  answer(3, [gone(99)])
  await settle()
  const failed = view.render()
  assert.match(text(failed), /Category access changed/)
  button(failed, "Retry category discovery").props.onClick()
  view.render()
  answer(4, [])
  answer(5, [gone(99)])
  await settle()
  button(view.render(), "Review selected categories").props.onClick()
  const review = view.render()
  assert.match(text(review), /Category unavailable/)
  checkboxes(review)[0].props.onCheckedChange()
  assert.equal(toggled[0][0], id(99))
})
