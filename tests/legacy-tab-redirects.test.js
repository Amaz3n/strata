// Old URLs that live in emails, bookmarks and other people's notes. Each
// compatibility page must land on the current workspace, and anything it does
// not recognise must land somewhere safe rather than 404.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")

stubModule("next/navigation", {
  redirect: (destination) => {
    throw Object.assign(new Error("redirect"), { destination })
  },
})

const ID = "00000000-0000-4000-8000-000000000001"
const page = (file) => freshRequire(`app/(app)/${file}/page.tsx`).default

/** Where `render` redirects to. */
async function destination(render) {
  try {
    await render()
  } catch (error) {
    if (typeof error.destination === "string") return error.destination
    throw error
  }
  assert.fail("the page rendered instead of redirecting")
}

const UNKNOWN_TABS = [undefined, "", "unknown", "constructor", "__proto__", "toString"]

function tabRedirects(file, tab) {
  const render = page(file)
  return destination(() => render({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({ tab }) }))
}

test("company tabs land on the directory account, or its overview when unknown", async () => {
  for (const tab of ["compliance", "prequalification", "transactions", "commitments", "contacts"]) {
    assert.equal(await tabRedirects("companies/[id]", tab), `/directory/${ID}/${tab}`)
  }
  for (const tab of [...UNKNOWN_TABS, ["compliance", "contacts"]]) {
    assert.equal(await tabRedirects("companies/[id]", tab), `/directory/${ID}`, JSON.stringify(tab))
  }
})

test("financials tabs land on their current workspace, or billing when unknown", async () => {
  for (const [tab, route] of [
    ["budget", "financials/budget"],
    ["receivables", "financials/billing"],
    ["billing", "financials/billing"],
    ["payables", "financials/payables"],
    ["cost-plus", "financials/cost-inbox"],
    ["inbox", "financials/cost-inbox"],
    ["review", "financials/cost-inbox"],
    ["trust-center", "reports/reconciliation"],
  ]) {
    assert.equal(await tabRedirects("projects/[id]/financials", tab), `/projects/${ID}/${route}`, tab)
  }
  for (const tab of [...UNKNOWN_TABS, ["budget", "payables"]]) {
    assert.equal(await tabRedirects("projects/[id]/financials", tab), `/projects/${ID}/financials/billing`, JSON.stringify(tab))
  }
})

test("retired Books pages land on their replacements", async () => {
  for (const [alias, expected] of [
    ["accountant", "/books/exports"],
    ["chart", "/settings/accounting/chart-of-accounts"],
    ["cutover", "/settings/accounting/setup"],
    ["opening-balances", "/settings/accounting/opening-balances"],
    ["statements", "/reports?collection=statements"],
  ]) {
    assert.equal(await destination(page(`books/${alias}`)), expected, alias)
  }
})
