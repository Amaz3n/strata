require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, text, button, settle } = require("./support/render")
const { freshRequire } = require("./support/modules")

stubLeaves(["@/components/ui/button", "@/components/ui/input", "@/components/ui/label"])

const { SearchPicker } = freshRequire("components/ui/search-picker.tsx")

const debounce = () => new Promise((resolve) => setTimeout(resolve, 280))

test("a lookup failure shows its reason, retries on request and never clears the chosen value", async () => {
  const answers = [
    { success: false, error: "Scope check failed" },
    { success: true, data: { items: [{ id: "h1", name: "Lot 7", detail: "Oak Ridge" }], nextCursor: null, nextPage: null } },
  ]
  const queries = []
  const search = async (query) => {
    queries.push(query)
    return answers.shift()
  }
  const view = mount(SearchPicker, { label: "Home", value: null, onChange: () => {}, search })

  view.render()
  await debounce()
  await settle()
  assert.match(text(view.render()), /Scope check failed/)

  button(view.render(), "Retry").props.onClick()
  view.render()
  await debounce()
  await settle()
  const recovered = view.render()
  assert.match(text(recovered), /Lot 7/)
  assert.doesNotMatch(text(recovered), /Scope check failed/)
  assert.equal(queries.length, 2)

  view.props = { ...view.props, value: { id: "h1", name: "Lot 7", detail: "Oak Ridge" } }
  const chosen = text(view.render())
  assert.match(chosen, /Lot 7/)
  assert.ok(button(view.render(), "Change"))
})
