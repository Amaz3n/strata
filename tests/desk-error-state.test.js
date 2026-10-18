require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, find, text, button } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("next/link", { __esModule: true, default: "Link" })
stubLeaves(["@/components/ui/button"])

const { DeskErrorState } = freshRequire("components/layout/desk-error-state.tsx")
const { permissionDeniedDigest } = freshRequire("lib/permission-denied.ts")
const { actionError } = freshRequire("lib/action-result.ts")

function denial(keys) {
  return Object.assign(new Error(`Missing permission: ${keys.join(" or ")}`), {
    code: "AUTH_FORBIDDEN",
    digest: permissionDeniedDigest(keys),
  })
}

const props = (error, retry = () => {}) => ({ error, retry, subject: "The Starts desk", backHref: "/starts", backLabel: "Back to Starts" })

test("a refused desk names the missing permission and who can grant it, and offers no retry", () => {
  const tree = mount(DeskErrorState, props(denial(["schedule.read", "project.read"]))).render()
  const screen = text(tree)
  assert.match(screen, /needs one of these permissions/)
  assert.match(screen, /schedule\.read/)
  assert.match(screen, /project\.read/)
  assert.match(screen, /organization admin can grant it/)
  assert.equal(button(tree, "Try again"), undefined)
  assert.equal(find(tree, (node) => node.type === "Link").props.href, "/starts")
})

test("a failed load retries through Next's retry, shows the reference and never the private message", () => {
  let retries = 0
  const error = Object.assign(new Error("relation house_plans private detail"), { digest: "1234567" })
  const tree = mount(DeskErrorState, props(error, () => retries++)).render()
  button(tree, "Try again").props.onClick()
  assert.equal(retries, 1)
  assert.match(text(tree), /could not be loaded/)
  assert.match(text(tree), /Reference 1234567/)
  assert.doesNotMatch(text(tree), /private detail/)
})

test("a refused server action names the permission instead of a bare refusal", () => {
  assert.deepEqual(actionError(denial(["settings.manage"])), {
    success: false,
    error: "Missing permission: settings.manage. An org admin can grant it in Settings → Team.",
  })
})
