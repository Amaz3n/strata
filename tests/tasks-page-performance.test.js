const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("the Tasks desk does not reload assignable people after hydration", () => {
  const page = source("app/(app)/tasks/page.tsx")
  const client = source("app/(app)/tasks/tasks-page-client.tsx")
  const tasksTab = source("components/tasks/tasks-tab.tsx")

  assert.match(page, /assignableResources=\{resources\}/)
  assert.match(client, /assignableResources=\{assignableResources\}/)
  assert.doesNotMatch(tasksTab, /listOrgAssignableResourcesAction/)
})

test("the assignable people queries run concurrently", () => {
  const actions = source("app/(app)/tasks/actions.ts")
  const loader = actions.slice(actions.indexOf("export async function listOrgAssignableResourcesAction"))

  assert.match(loader, /Promise\.all\(\[/)
  assert.match(loader, /\.from\("memberships"\)[\s\S]*\.from\("contacts"\)/)
})
