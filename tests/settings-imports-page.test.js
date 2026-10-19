require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const React = require("react")

const { freshRequire, stubModule } = require("./support/modules")

let history = { batches: [], total: 0 }
let permissions = []
stubModule("next/server", { ...require("next/server"), connection: async () => {} })
stubModule("@/lib/services/imports", { listImportBatches: async () => history })
stubModule("@/lib/services/permissions", { getCurrentUserPermissions: async () => ({ permissions }) })

const Link = require("next/link").default
const ImportsPage = freshRequire("app/(app)/settings/imports/page.tsx").default

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement(node)) return []
  return [node, ...elements(node.props.children)]
}

function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(text).join(" ")
  return React.isValidElement(node) ? text(node.props.children) : ""
}

/** The rendered importer list for an actor holding `grants`. */
async function open(grants, batches = { batches: [], total: 0 }) {
  permissions = grants
  history = batches
  const content = ImportsPage().props.children
  return content.type(content.props)
}

test("the importer list offers only what the actor may import, and never Open WIP", async () => {
  const gated = [
    ["plan_library", "plan.write"],
    ["option_catalog", "selections.catalog.manage"],
    ["price_book", "commitment.write"],
    ["communities_lots", "lot.write"],
    ["team", "members.manage"],
  ]
  for (const grants of [["plan.write"], ["selections.catalog.manage"], ["commitment.write"], ["lot.write"], ["members.manage"], ["*"], []]) {
    const hrefs = elements(await open(grants))
      .filter((node) => node.type === Link)
      .map((node) => node.props.href)
    assert.ok(!hrefs.includes("/settings/imports/open_wip"), grants.join(","))
    for (const [importer, grant] of gated) {
      const offered = grants.includes(grant) || grants.includes("*")
      assert.equal(hrefs.includes(`/settings/imports/${importer}`), offered, `${importer} with ${grants.join(",") || "nothing"}`)
    }
  }
})

test("a capped recent history never reports an older importer as never run", async () => {
  const copy = text(await open(["*"], { batches: [{ id: "batch", importer: "team", status: "committed" }], total: 80 }))
  assert.ok(copy.includes("No batch in recent history"))
  assert.ok(copy.includes("Open an importer to browse its full history"))
  assert.ok(!copy.includes("Never run"))
})
