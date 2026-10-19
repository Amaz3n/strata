require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")

const ResetForm = () => null
stubModule("@/components/auth/auth-reset-page", { __esModule: true, default: ResetForm })
stubModule("next/navigation", {
  redirect: (destination) => {
    throw Object.assign(new Error("redirect"), { destination })
  },
})

const ResetPage = freshRequire("app/(auth)/auth/reset/page.tsx").default

/** What the page does for this query: a redirect URL, or the element it renders. */
async function open(query) {
  const props = { searchParams: Promise.resolve(query) }
  const route = ResetPage(props).props.children
  try {
    return { rendered: await route.type(route.props) }
  } catch (error) {
    if (!error.destination) throw error
    return { redirect: new URL(error.destination, "https://arc.test") }
  }
}

test("a reset code is exchanged on the server and always returns to the reset form", async () => {
  const { redirect } = await open({ code: "one-time", next: "//external.example" })
  assert.equal(redirect.pathname, "/auth/confirm")
  assert.equal(redirect.searchParams.get("code"), "one-time")
  assert.equal(redirect.searchParams.get("next"), "/auth/reset")
})

test("a token hash defaults to a recovery type and passes an explicit one on for validation", async () => {
  for (const type of [undefined, "recovery", "invalid"]) {
    const { redirect } = await open({ token_hash: "hash", type })
    assert.equal(redirect.pathname, "/auth/confirm")
    assert.equal(redirect.searchParams.get("token_hash"), "hash")
    assert.equal(redirect.searchParams.get("type"), type ?? "recovery")
    assert.equal(redirect.searchParams.get("next"), "/auth/reset")
  }
})

test("external resets and already-confirmed sessions render the reset form", async () => {
  for (const query of [{}, { external_token: "external", code: "ignored" }]) {
    const { rendered } = await open(query)
    assert.equal(rendered.type, ResetForm, JSON.stringify(query))
  }
})
