require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubLeaves, mount, find, text, settle } = require("./support/render")
const { freshRequire, stubModule } = require("./support/modules")

let people = []
let revokeReply = null
const calls = []
const toasts = []
stubModule("@/app/(app)/sharing/actions", {
  loadOrgExternalAccessAction: async () => {
    calls.push("load")
    return { people, truncated: false }
  },
  revokeOrgExternalPersonAction: async (input) => {
    calls.push({ revoke: input })
    return revokeReply
  },
})
stubModule("sonner", { toast: { success: (message) => toasts.push(message), error: (message) => toasts.push(message) } })
stubLeaves([
  "@/components/ui/badge",
  "@/components/ui/button",
  "@/components/ui/input",
  "@/components/ui/alert-dialog",
  "@/components/ui/collapsible",
  "@/components/settings/settings-section",
  "@/components/icons",
])

const { ExternalAccessPanel } = freshRequire("components/sharing/external-access-directory.tsx")

function person(statuses) {
  return {
    key: "person",
    name: "Trade partner",
    access_mode: "account",
    last_accessed_at: null,
    projects: statuses.map((status, index) => ({
      token_id: status,
      status,
      portal_type: "sub",
      project_name: `Home ${index + 1}`,
    })),
  }
}

/** The directory, loaded with `listed`. */
async function directory(listed) {
  people = listed
  calls.length = 0
  toasts.length = 0
  const view = mount(ExternalAccessPanel, {})
  view.render()
  await settle()
  return view
}

const removeButton = (tree) => find(tree, (node) => node.type === "Button" && node.props.title === "Remove listed access")

test("a person can be removed while any of their listed access is still live", async () => {
  for (const status of ["active", "paused", "expired", "revoked"]) {
    const view = await directory([person([status])])
    assert.equal(removeButton(view.render()).props.disabled, status === "revoked", status)
  }
})

test("removal revokes only the live records, says other access may remain, and reloads the list", async () => {
  for (const [reply, message] of [
    [{ success: true, data: 2 }, "Removed 2 access records for Trade partner"],
    [{ success: false, error: "Second link could not be removed" }, "Second link could not be removed"],
  ]) {
    revokeReply = reply
    const view = await directory([person(["active", "paused", "revoked"])])
    removeButton(view.render()).props.onClick()
    const dialog = view.render()
    const description = text(find(dialog, (node) => node.type === "AlertDialogDescription"))
    assert.match(description, /Other access may remain/)
    assert.doesNotMatch(description, /Arc account is cut off/)

    find(dialog, (node) => node.type === "AlertDialogAction").props.onClick({ preventDefault() {} })
    await settle()
    assert.deepEqual(calls, ["load", { revoke: { token_ids: ["active", "paused"] } }, "load"], message)
    assert.deepEqual(toasts, [message])
    const after = view.render()
    assert.equal(find(after, (node) => node.type === "AlertDialog").props.open, false, "the dialog closes")
  }
})
