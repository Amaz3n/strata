const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("the client portal team page uses its narrow read model", () => {
  const page = source("app/p/[token]/about/page.tsx")
  const loader = source("app/p/[token]/load-portal.ts")
  const service = source("lib/services/portal-access.ts")
  const aboutLoader = service.slice(
    service.indexOf("async function loadClientPortalAboutDataWithClient"),
    service.indexOf("export async function loadClientPortalData"),
  )

  assert.match(page, /loadClientPortalAboutPage/)
  assert.doesNotMatch(page, /loadClientPortalPage\(/)
  assert.match(loader, /loadClientPortalAboutData\(/)

  assert.match(aboutLoader, /Promise\.all\(\[/)
  assert.match(aboutLoader, /\.from\("orgs"\)/)
  assert.match(aboutLoader, /\.from\("projects"\)/)
  assert.match(aboutLoader, /\.from\("project_members"\)/)
  assert.doesNotMatch(
    aboutLoader,
    /fetch(?:Invoices|Rfis|Submittals|Selections|PunchItems|PhotoTimeline|WarrantyRequests)/,
  )
})

test("the portal team view remains server-rendered and date-only safe", () => {
  const component = source("components/portal/tabs/portal-about-tab.tsx")

  assert.doesNotMatch(component, /^["']use client["']/)
  assert.match(component, /parseISO\(value\)/)
  assert.doesNotMatch(component, /new Date\(data\.project\.(?:start_date|end_date)\)/)
})
