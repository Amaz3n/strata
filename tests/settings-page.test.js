const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

const ORG = "00000000-0000-4000-8000-000000000101"
const OTHER_ORG = "00000000-0000-4000-8000-000000000102"

/** The member's grants, and every privileged read the panel loader made. */
const session = { permissions: [], reads: [], contractTemplateFailure: null }

function read(name, value = {}) {
  return async () => {
    session.reads.push(name)
    return value
  }
}

stubModule("@/lib/auth/context", {
  requireOrgMembership: async () => ({ orgId: ORG, membership: { role_key: "org_project_manager" } }),
})
stubModule("@/lib/services/context", { requireOrgContext: async () => ({ orgId: ORG }) })
stubModule("@/lib/services/permissions", {
  getCurrentUserPermissions: async () => ({ permissions: session.permissions }),
})
stubModule("@/lib/services/users", { getCurrentUserProfile: read("profile", { id: "user" }) })
stubModule("@/lib/services/stripe-connected-accounts", { getStripeConnectedAccount: read("stripe") })
stubModule("@/lib/services/compliance", {
  getComplianceRules: read("compliance rules"),
  getDefaultComplianceRequirements: read("compliance requirements"),
})
stubModule("@/lib/services/compliance-documents", { listComplianceDocumentTypes: read("document types") })
stubModule("@/lib/services/prequalification", { getPrequalificationTemplate: read("prequalification") })
stubModule("@/lib/services/document-numbering", { getDocumentNumbering: read("numbering") })
stubModule("@/lib/services/payment-rail-setup", { getPaymentRailSettings: read("payment rails") })
stubModule("@/lib/services/books/module", {
  getBooksModuleSettings: read("books"),
  isBooksWorkspaceEnabled: read("books enabled", false),
})
stubModule("@/lib/services/team", { listOrganizationSigners: read("signers", []) })
stubModule("@/app/(app)/settings/actions", {
  getBillingPageDataAction: read("billing", { billing: { plan: "fixture" } }),
  getOrganizationSettingsAction: read("organization"),
  getTeamSettingsDataAction: read("team"),
  getNotificationPreferencesAction: read("notifications"),
  listContractTemplatesAction: async () => {
    session.reads.push("contract templates")
    if (session.contractTemplateFailure) throw session.contractTemplateFailure
    return [{ id: "template", file_name: "agreement.pdf" }]
  },
})

const { loadSettingsPanel } = freshRequire("lib/services/settings-page.ts")

test.beforeEach(() => {
  session.permissions = ["org.member"]
  session.reads = []
  session.contractTemplateFailure = null
})

test("a request for a different organization is refused before anything is read", async () => {
  await assert.rejects(loadSettingsPanel("profile", OTHER_ORG), /Organization changed/)
  assert.deepEqual(session.reads, [])
})

test("payment settings are refused to a member without a payment permission", async () => {
  for (const permissions of [["org.member"], ["bill.approve"]]) {
    session.permissions = permissions
    await assert.rejects(loadSettingsPanel("payments", ORG), /don't have access/)
  }
  assert.deepEqual(session.reads, [])
})

test("any payment permission opens the payment settings", async () => {
  for (const permission of ["payment.release", "payment.approve_run", "payment.manage_rail", "org.admin"]) {
    session.permissions = [permission]
    const panel = await loadSettingsPanel("payments", ORG)
    assert.equal(panel.tab, "payments", permission)
  }
})

test("contract templates are loaded only for members who manage billing", async () => {
  const ordinary = await loadSettingsPanel("organization", ORG)
  assert.deepEqual(ordinary.contractTemplates, { success: true, data: [] })
  assert.equal(session.reads.includes("contract templates"), false)

  for (const permission of ["billing.manage", "org.admin", "*"]) {
    session.permissions = [permission]
    const panel = await loadSettingsPanel("organization", ORG)
    assert.deepEqual(panel.contractTemplates.data, [{ id: "template", file_name: "agreement.pdf" }], permission)
  }
})

test("a failed contract template read leaves the rest of the organization panel usable", async () => {
  session.permissions = ["org.admin"]
  session.contractTemplateFailure = new Error("Template storage unavailable")

  const panel = await loadSettingsPanel("organization", ORG)

  assert.equal(panel.contractTemplates.success, false)
  assert.match(panel.contractTemplates.error, /Template storage unavailable/)
  assert.deepEqual(panel.signers, [])
})
