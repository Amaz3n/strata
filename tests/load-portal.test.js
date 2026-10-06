const assert = require("node:assert/strict")
const test = require("node:test")

const { PORTAL_COMPANY, portalLink, usePortalDatabase } = require("./support/portal")
const {
  loadClientPortalDocumentsPage,
  loadClientPortalPage,
  loadClientPortalPayApplicationPage,
  loadClientPortalPayApplicationsPage,
  loadClientPortalPhotosPage,
} = require("../app/p/[token]/load-portal.ts")

const PAST = "2020-01-01T00:00:00Z"

function isNotFound(error) {
  return error?.digest === "NEXT_HTTP_ERROR_FALLBACK;404"
}

/** Every table the loader reads, so a refusal can prove no project data was touched. */
function useDatabase(rows) {
  const database = usePortalDatabase({ portal_access_tokens: rows })
  const tablesRead = []
  const from = database.from.bind(database)
  database.from = (table) => {
    tablesRead.push(table)
    return from(table)
  }
  return { tablesRead }
}

function projectDataRead(tablesRead) {
  return tablesRead.filter((table) => table !== "portal_access_tokens")
}

test("an unusable or non-buyer link is a 404 before any project data is read", async () => {
  const revoked = portalLink({ revoked_at: PAST })
  const subcontractor = portalLink({ portal_type: "sub", company_id: PORTAL_COMPANY })
  const vendorAccount = portalLink({ project_id: null })
  const { tablesRead } = useDatabase([revoked.row, subcontractor.row, vendorAccount.row])

  for (const token of ["never-issued", revoked.token, subcontractor.token, vendorAccount.token]) {
    await assert.rejects(loadClientPortalPage(token), isNotFound, token)
  }
  assert.deepEqual(projectDataRead(tablesRead), [])
})

test("a photo-disabled link is a 404 before the portal payload is read", async () => {
  const link = portalLink({ can_view_photos: false })
  const { tablesRead } = useDatabase([link.row])

  await assert.rejects(loadClientPortalPhotosPage(link.token), isNotFound)
  assert.deepEqual(projectDataRead(tablesRead), [])
})

test("a document-disabled link is a 404 before project files are read", async () => {
  const link = portalLink({ can_view_documents: false })
  const { tablesRead } = useDatabase([link.row])

  await assert.rejects(loadClientPortalDocumentsPage(link.token), isNotFound)
  assert.deepEqual(projectDataRead(tablesRead), [])
})

test("an invoice-disabled link cannot list or open pay applications", async () => {
  const link = portalLink({ can_view_invoices: false })
  const { tablesRead } = useDatabase([link.row])

  await assert.rejects(loadClientPortalPayApplicationsPage(link.token), isNotFound)
  await assert.rejects(loadClientPortalPayApplicationPage(link.token, "application"), isNotFound)
  assert.deepEqual(projectDataRead(tablesRead), [])
})
