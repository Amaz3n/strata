require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  getDefaultProjectPropertyType,
  getProjectPosture,
  normalizeProductTier,
  shouldShowCustomBuildNavigation,
  shouldShowProductionOrgNavigation,
  shouldShowSafetyNavigation,
} = require("../lib/product-tier")
const { ORG } = require("./support/service")
const { terminology, profileTerminology } = require("../lib/terminology")
const { resolveReceivablesPolicy, resolveOrgReceivablesPolicy } = require("../lib/receivables/policy")
const { payApplicationLabels } = require("../lib/financials/pay-application-labels")
const { payApplicationCertificationCopy } = require("../lib/emails/pay-application-email")
const { render } = require("@react-email/components")
const { ProjectPortalInviteEmail } = require("../lib/emails/project-portal-invite-email")
const { InvoiceEmail } = require("../lib/emails/invoice-email")
const { EstimateEmail } = require("../lib/emails/estimate-email")
const { SignatureEmail } = require("../lib/emails/signature-email")
const { PaymentReturnedEmail } = require("../lib/emails/payment-returned-email")
const { RemittanceAdviceEmail } = require("../lib/emails/remittance-advice-email")
const { PROJECT_MODULES, isProjectModuleEnabled } = require("../lib/project-modules")

test("explicit project property type wins over org tier in a mixed org", () => {
  assert.equal(getProjectPosture("residential", "commercial"), "residential")
  assert.equal(getProjectPosture("commercial", "residential"), "commercial")
})

test("org tier supplies only the default when project posture is absent", () => {
  assert.equal(getProjectPosture(null, "commercial"), "commercial")
  assert.equal(getProjectPosture("production", "residential"), "production")
  assert.equal(getProjectPosture(null, "production"), "production")
  assert.equal(getDefaultProjectPropertyType("commercial"), "commercial")
  assert.equal(getDefaultProjectPropertyType("production"), "production")
  assert.equal(normalizeProductTier("unexpected"), "residential")
})

test("terminology remains centralized for every posture", () => {
  assert.equal(terminology("residential").owner, "Client")
  assert.equal(terminology("commercial").owner, "Owner")
  assert.equal(terminology("production").owner, "Buyer")
})

test("module overrides beat posture defaults without gating the route", () => {
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "residential", postures: ["commercial"] }), false)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "production", postures: ["commercial"] }), false)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "residential", postures: ["commercial"], overrides: { safety: true } }), true)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "commercial", postures: ["commercial"], overrides: { safety: false } }), false)
})

test("a mixed org gives each project its own vocabulary and modules", () => {
  const orgTier = "production"
  const home = getProjectPosture("residential", orgTier)
  const lot = getProjectPosture("production", orgTier)

  assert.equal(terminology(home).owner, "Client")
  assert.equal(terminology(home).projects, "Projects")
  assert.equal(terminology(lot).owner, "Buyer")
  assert.equal(terminology(lot).projects, "Homes")

  const inspections = PROJECT_MODULES.find((module) => module.key === "inspections")
  const enabled = (posture) =>
    isProjectModuleEnabled({ moduleKey: "inspections", posture, postures: inspections.postures })
  assert.equal(enabled(home), false)
  assert.equal(enabled(lot), true)
})

test("an org's navigation follows its projects, not only its tier", async () => {
  const { createServiceHarness, id } = require("./support/service")
  const { freshRequire } = require("./support/modules")
  const { orgHasProductionProjects, orgHasActiveNonProductionProjects } =
    freshRequire("lib/services/production-desk-scope.ts")

  const mixed = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, property_type: "production", status: "active" },
        { id: id(2), org_id: ORG, property_type: "residential", status: "active" },
      ],
    },
    permissions: ["org.member"],
  })
  assert.equal(await mixed.run(() => orgHasProductionProjects()), true)
  assert.equal(await mixed.run(() => orgHasActiveNonProductionProjects()), true)

  const productionOnly = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, property_type: "production", status: "active" },
        { id: id(2), org_id: ORG, property_type: "residential", status: "completed" },
        { id: id(3), org_id: id(900099), property_type: "residential", status: "active" },
      ],
    },
    permissions: ["org.member"],
  })
  assert.equal(await productionOnly.run(() => orgHasActiveNonProductionProjects()), false)

  assert.equal(shouldShowCustomBuildNavigation("production", false), false)
  assert.equal(shouldShowCustomBuildNavigation("production", true), true)
  assert.equal(shouldShowCustomBuildNavigation("residential", false), true)
  assert.equal(shouldShowProductionOrgNavigation("residential", true), true)
})

test("safety navigation follows the commercial tier or any active commercial job", () => {
  assert.equal(shouldShowSafetyNavigation("commercial", false), true)
  assert.equal(shouldShowSafetyNavigation("residential", true), true)
  assert.equal(shouldShowSafetyNavigation("production", true), true)
  assert.equal(shouldShowSafetyNavigation("residential", false), false)
})

const TRADE = { kind: "trade", specialty: "Electrical" }
const BUILDER = { kind: "builder", specialty: "Electrical" }
const POSTURES = ["residential", "commercial", "production"]
const BUILDER_WORDS = /\b(owners?|clients?|buyers?|projects?|homes?|vendors?|subs?|trade partners?|pipeline)\b/i

function stringsIn(value) {
  if (typeof value === "string") return [value]
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn)
  return []
}

test("a trade company never sees a builder noun, whatever the posture", () => {
  for (const posture of POSTURES) {
    const nouns = terminology(posture, TRADE)
    const shown = [nouns.owner, nouns.owners, nouns.ownerPortal, nouns.project, nouns.projects, nouns.vendor, nouns.vendors, nouns.pipeline]
    for (const noun of shown) assert.doesNotMatch(noun, BUILDER_WORDS, `${posture}: ${noun}`)
    assert.equal(nouns.pipeline, "Opportunities")
    assert.equal(nouns.project, "Job")
    assert.equal(nouns.vendor, "Supplier")
  }
})

test("a builder keeps its own nouns, including the pipeline", () => {
  assert.equal(terminology("residential").pipeline, "Pipeline")
  assert.equal(terminology("commercial", BUILDER).vendor, "Trade partner")
  assert.equal(profileTerminology(BUILDER).project, "Project")
  assert.equal(profileTerminology(BUILDER).owner, "Client")
  assert.equal(profileTerminology(TRADE).project, "Job")
  assert.equal(profileTerminology(TRADE).owner, "Customer")
})

test("a trade's receivables labels and billing documents say Customer and Job", () => {
  const settings = [undefined, { receivables: { customer_kind: "company", customer_certifies: true } }]
  for (const posture of POSTURES) {
    for (const settingsMetadata of settings) {
      const policy = resolveReceivablesPolicy({ posture, profile: TRADE, settingsMetadata })
      const labels = payApplicationLabels({ customerLabel: policy.documentCustomerLabel, projectLabel: policy.documentProjectLabel })
      for (const text of [...stringsIn(policy), ...stringsIn(labels)]) assert.doesNotMatch(text, BUILDER_WORDS, `${posture}: ${text}`)
    }
    const org = resolveOrgReceivablesPolicy({ tier: posture, profile: TRADE })
    for (const text of stringsIn(org)) assert.doesNotMatch(text, BUILDER_WORDS, `${posture} org: ${text}`)
  }
})

test("a builder's pay application keeps the AIA wording", () => {
  const policy = resolveReceivablesPolicy({ posture: "commercial", profile: BUILDER })
  const labels = payApplicationLabels({ customerLabel: policy.documentCustomerLabel, projectLabel: policy.documentProjectLabel })
  assert.equal(labels.to, "To (Owner)")
  assert.equal(labels.project, "Project")
  assert.equal(labels.certificateTitle, "Owner's / Architect's Certificate for Payment")
  assert.equal(payApplicationLabels({}).signatureLine, "Owner / Architect — signature / date")
})

test("the pay application certification email names the job for a trade and the project for a builder", () => {
  const input = { orgName: "Volt Electric", applicationNumber: 3, revision: 1, includesWaiver: true }
  const trade = payApplicationCertificationCopy({ ...input, projectName: null, projectNoun: "Job" })
  for (const text of stringsIn(trade)) assert.doesNotMatch(text, BUILDER_WORDS, text)
  assert.equal(trade.subject, "Pay Application #3 (revision 1) & signed waiver — Job")
  assert.equal(trade.intro, "Volt Electric has submitted Pay Application #3 (revision 1) for the job.")

  const builder = payApplicationCertificationCopy({ ...input, projectName: null, projectNoun: "Project" })
  assert.equal(builder.subject, "Pay Application #3 (revision 1) & signed waiver — Project")
  assert.equal(builder.intro, "Volt Electric has submitted Pay Application #3 (revision 1) for the project.")
  assert.equal(builder.waiverNote, "Your contractor’s signed waiver is included in this packet.")
  assert.equal(trade.waiverNote, "Volt Electric’s signed waiver is included in this packet.")
})

const visibleText = (html) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").replace(/[\u200b-\u200f]/g, "").replace(/\s+/g, " ").replace(/ ([:.,])/g, "$1")

async function renderedEmails(projectLabel) {
  const shared = { orgName: "Volt Electric", projectName: "Panel upgrade", projectLabel }
  return Promise.all([
    render(ProjectPortalInviteEmail({ ...shared, portalType: "client", portalLink: "https://arc.test/p/t" })),
    render(InvoiceEmail({ ...shared, invoiceNumber: "INV-7", amount: "$100.00" })),
    render(EstimateEmail({ ...shared, estimateTitle: "Panel quote", reviewLink: "https://arc.test/e/t" })),
    render(SignatureEmail({ ...shared, documentTitle: "Change order 2", signingLink: "https://arc.test/d/t" })),
    render(PaymentReturnedEmail({ ...shared, kind: "vendor_returned", actionUrl: "https://arc.test/payables" })),
    render(RemittanceAdviceEmail({ ...shared, billNumber: "B-1", invoiceTotalCents: 10000, retainageHeldCents: 0, amountPaidCents: 10000, methodLabel: "ACH", method: "ach", reference: null })),
  ]).then((all) => all.map(visibleText))
}

test("every email a trade company can send names the job, never the project or the builder", async () => {
  for (const text of await renderedEmails(profileTerminology(TRADE).project)) {
    assert.doesNotMatch(text, /\b(owners?|clients?|projects?|builders?|trade partners?)\b/i, text.slice(0, 200))
  }
})

test("a builder's emails keep the project wording", async () => {
  const [invite, invoice, estimate] = await renderedEmails(profileTerminology(BUILDER).project)
  assert.match(invite, /You have project access/)
  assert.match(invite, /Builder: Volt Electric/)
  assert.match(invite, /Open Project in Arc/)
  assert.match(invite, /open secure project link/)
  assert.match(invoice, /Project: Panel upgrade/)
  assert.match(estimate, /Project: Panel upgrade/)
})

test("a trade's pay application documents and its certification email read Customer and Job", () => {
  const input = { orgName: "Volt Electric", applicationNumber: 3, revision: 0, includesWaiver: true, projectName: "Panel upgrade", projectNoun: "Job" }
  const copy = payApplicationCertificationCopy(input)
  const policy = resolveReceivablesPolicy({ posture: "commercial", profile: TRADE })
  const labels = payApplicationLabels({ customerLabel: policy.documentCustomerLabel, projectLabel: policy.documentProjectLabel })
  for (const text of [...stringsIn(copy), ...stringsIn(labels)]) assert.doesNotMatch(text, BUILDER_WORDS, text)
})
