require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, text, button, settle } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

const answers = []
const searches = []
stubModule("@/app/(app)/bids/actions", {
  searchProductionBidVendorsAction: async (input) => {
    searches.push(input)
    return answers.shift()
  },
})
stubLeaves(["@/components/ui/button", "@/components/ui/checkbox", "@/components/ui/input"])

const { ProductionBidVendorPicker } = freshRequire("components/bids/production-bid-vendor-picker.tsx")

const debounce = () => new Promise((resolve) => setTimeout(resolve, 280))

test("a failed vendor lookup offers a retry and keeps the vendors already chosen", async () => {
  searches.length = 0
  answers.push(
    { success: false, error: "Directory unavailable" },
    { success: true, data: { items: [{ id: "v2", name: "Roofing Co", detail: "Roofing" }], more: false } },
  )
  const chosen = [{ id: "v1", name: "Framing Co", detail: "Framing" }]
  const changes = []
  const view = mount(ProductionBidVendorPicker, { packageId: "pkg", value: chosen, onChange: (next) => changes.push(next) })

  view.render()
  await debounce()
  await settle()
  const failed = text(view.render())
  assert.match(failed, /Directory unavailable/)
  assert.match(failed, /Framing Co/)
  assert.deepEqual(changes, [])

  button(view.render(), "Retry").props.onClick()
  view.render()
  await debounce()
  await settle()
  const recovered = text(view.render())
  assert.match(recovered, /Roofing Co/)
  assert.match(recovered, /Framing Co/)
  assert.doesNotMatch(recovered, /Directory unavailable/)
  assert.equal(searches.length, 2)
  assert.deepEqual(searches[1], { packageId: "pkg", search: "", page: 1 })
})
