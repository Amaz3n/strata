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
  assert.doesNotMatch(service, /app_users\([^)]*phone/)

  assert.match(aboutLoader, /Promise\.all\(\[/)
  assert.match(aboutLoader, /\.from\("orgs"\)/)
  assert.match(aboutLoader, /\.from\("projects"\)/)
  assert.match(aboutLoader, /\.from\("project_members"\)/)
  assert.doesNotMatch(aboutLoader, /app_users\([^)]*phone/)
  assert.doesNotMatch(
    aboutLoader,
    /fetch(?:Invoices|Rfis|Submittals|Selections|PunchItems|PhotoTimeline|WarrantyRequests)/,
  )
})

test("client portal token validation starts only after request time", () => {
  const layout = source("app/p/[token]/layout.tsx")
  const loader = source("app/p/[token]/load-portal.ts")
  const service = source("lib/services/portal-access.ts")
  const layoutBoundary = layout.indexOf("await connection()")
  const layoutValidation = layout.indexOf("await resolvePortalGate(")
  const pageBoundary = loader.indexOf("await connection()")
  const pageValidation = loader.indexOf("await assertPortalActionAccess(")
  const sharedBoundary = service.indexOf("await connection()", service.indexOf("export async function validatePortalToken"))
  const sharedValidation = service.indexOf(".from(\"portal_access_tokens\")", sharedBoundary)

  assert.notEqual(layoutBoundary, -1)
  assert.notEqual(layoutValidation, -1)
  assert.ok(layoutBoundary < layoutValidation)
  assert.notEqual(pageBoundary, -1)
  assert.notEqual(pageValidation, -1)
  assert.ok(pageBoundary < pageValidation)
  assert.notEqual(sharedBoundary, -1)
  assert.notEqual(sharedValidation, -1)
  assert.ok(sharedBoundary < sharedValidation)
})

test("public invoice data starts only after request time", () => {
  const page = source("app/i/[token]/page.tsx")
  const boundary = page.indexOf("await connection()")
  const invoiceRead = page.indexOf("await getInvoiceByToken(token)")

  assert.notEqual(boundary, -1)
  assert.notEqual(invoiceRead, -1)
  assert.ok(boundary < invoiceRead)
})

test("the portal team view remains server-rendered and date-only safe", () => {
  const component = source("components/portal/tabs/portal-about-tab.tsx")

  assert.doesNotMatch(component, /^["']use client["']/)
  assert.match(component, /parseISO\(value\)/)
  assert.doesNotMatch(component, /new Date\(data\.project\.(?:start_date|end_date)\)/)
})
