require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, find, findAll, text, button } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("next/link", { __esModule: true, default: "Link" })
stubModule("sonner", { toast: { success: () => {}, error: () => {} } })
stubLeaves([
  "@/components/icons",
  ...["badge", "button", "collapsible", "input", "textarea"].map((name) => `@/components/ui/${name}`),
])

const { OnboardingWorkbench } = freshRequire("components/admin/onboarding-workbench.tsx")

const ORG = { id: "org", name: "Builder", slug: "builder", product_tier: "production" }
const STAGE = {
  definition: { key: "accounting", owner: "both", label: "Accounting", skippable: true, importer: "cost_codes", help: "" },
  state: { status: "pending" },
  gates: [],
}

function workbench(canManage, stages = [STAGE]) {
  const invoked = []
  const action = async () => {
    invoked.push("action")
    return { success: true, data: null }
  }
  const view = mount(OnboardingWorkbench, {
    canManage,
    org: ORG,
    run: { id: "run", status: "active" },
    stages,
    onComplete: action,
    onSkip: action,
    onUpdate: action,
    onMarkLive: action,
  })
  return { view, invoked }
}

test("a read-only operator can open every stage and importer but no control changes the run", async () => {
  const { view, invoked } = workbench(false)
  const tree = view.render()
  assert.match(text(find(tree, (node) => node.props.role === "status")), /Read-only access/)
  assert.equal(find(tree, (node) => node.type === "CollapsibleTrigger").props.disabled, undefined)
  assert.ok(findAll(tree, (node) => node.type === "Link").some((node) => node.props.href.includes("/import/cost_codes")))

  for (const control of findAll(tree, (node) => node.type === "Button" && !node.props.asChild)) {
    assert.equal(control.props.disabled, true, text(control.props.children))
    await control.props.onClick?.()
  }
  for (const form of findAll(tree, (node) => node.type === "form")) await form.props.action(new FormData())
  assert.deepEqual(invoked, [])
})

test("sample reset stays unavailable, even to a permitted operator, until original ownership is provable", () => {
  const { view, invoked } = workbench(true, [])
  const tree = view.render()
  const reset = button(tree, "Reset sample community")
  assert.equal(reset.props.disabled, true)
  assert.equal(reset.props.onClick, undefined)
  assert.ok(findAll(tree, (node) => node.props.role === "status").some((node) => /ownership can be verified/.test(text(node))))
  assert.deepEqual(invoked, [])
})
