const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("the client portal documents page uses its files-only read model", () => {
  const page = source("app/p/[token]/documents/page.tsx")
  const loader = source("app/p/[token]/load-portal.ts")
  const service = source("lib/services/portal-access.ts")
  const documentsLoader = service.slice(
    service.indexOf("async function loadClientPortalDocumentsDataWithClient"),
    service.indexOf("export async function loadClientPortalData"),
  )

  assert.match(page, /loadClientPortalDocumentsPage/)
  assert.doesNotMatch(page, /loadClientPortalPage\(/)
  assert.match(loader, /if \(!access\.permissions\.can_view_documents\) notFound\(\)/)
  assert.ok(
    loader.indexOf("if (!access.permissions.can_view_documents) notFound()") <
      loader.indexOf("const data = await loadClientPortalDocumentsData"),
  )

  assert.match(documentsLoader, /\.from\("files"\)/)
  assert.match(documentsLoader, /\.eq\("share_with_clients", true\)/)
  assert.match(documentsLoader, /\.limit\(50\)/)
  assert.doesNotMatch(documentsLoader, /fetch(?:Invoices|Rfis|Submittals|PhotoTimeline)/)
})

test("the documents view accepts only the data it renders", () => {
  const component = source("components/portal/tabs/portal-documents-tab.tsx")

  assert.match(component, /ClientPortalDocumentsData/)
  assert.doesNotMatch(component, /ClientPortalData/)
})
