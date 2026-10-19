require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")

const reads = []
const list = (name, value) => async () => {
  reads.push(name)
  return value
}
stubModule("next/server", { ...require("next/server"), connection: async () => {} })
stubModule("next/navigation", {
  redirect: (destination) => {
    throw Object.assign(new Error("redirect"), { destination })
  },
})
stubModule("@/lib/services/platform-bugs", {
  requirePlatformBugOwner: async () => {
    throw new Error("Only Arc platform owners can access bug tracking.")
  },
  listPlatformBugs: list("bugs", []),
  listPlatformBugOwners: list("owners", []),
  listPlatformBugContextOptions: list("context", { orgs: [] }),
  listPlatformBugEvents: list("events", []),
  listPlatformBugAiReviews: list("reviews", []),
  listPlatformBugAiFixes: list("fixes", []),
})

// The page's client UI is irrelevant here and slow to load.
stubModule("@/components/platform/platform-bugs-client", { PlatformBugsClient: "PlatformBugsClient" })
stubModule("@/components/layout/page-layout", { PageLayout: "PageLayout" })
stubModule("@/components/layout/page-loading-skeleton", { PageLoadingSkeleton: "PageLoadingSkeleton" })

const PlatformBugsPage = freshRequire("app/(app)/platform/bugs/page.tsx").default

test("someone who is not a platform owner is sent away before any issue is read", async () => {
  const content = PlatformBugsPage().props.children
  await assert.rejects(content.type(content.props), (error) => error.destination === "/unauthorized")
  assert.deepEqual(reads, [])
})
