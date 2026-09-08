require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { resolveWaiverForm, mapPayablesWaiverKind } = require("../lib/lien-waivers/forms")
const { resolveWaiverJurisdiction } = require("../lib/lien-waivers/jurisdiction")

const KINDS = ["conditional_progress", "unconditional_progress", "conditional_final", "unconditional_final"]

const FIELDS = {
  claimantName: "Gulf Coast Framing LLC",
  customerName: "Naples Custom Builders",
  ownerName: "Marina Vasquez",
  propertyDescription: "412 Bayshore Dr, Naples, FL 34102",
  jobLocation: "412 Bayshore Dr, Naples, FL 34102",
  amountCents: 4_250_000,
  throughDate: "2026-08-31",
  checkPayee: "Gulf Coast Framing LLC",
  invoiceNumber: "INV-1042",
}

test("every statutory state returns a cited statutory form for all four kinds", () => {
  const citations = {
    FL: "Fla. Stat.",
    CA: "Cal. Civ. Code",
    TX: "Tex. Prop. Code",
  }
  for (const [state, prefix] of Object.entries(citations)) {
    for (const kind of KINDS) {
      const form = resolveWaiverForm({ jurisdiction: state, kind, fields: FIELDS })
      assert.equal(form.jurisdiction, state, `${state}/${kind} jurisdiction`)
      assert.equal(form.statutory, true, `${state}/${kind} should be statutory`)
      assert.ok(form.statutoryCitation, `${state}/${kind} needs a citation`)
      assert.ok(
        form.statutoryCitation.startsWith(prefix),
        `${state}/${kind} citation "${form.statutoryCitation}" should cite ${prefix}`,
      )
      assert.ok(form.title.length > 0)
      assert.ok(form.body.length > 0, `${state}/${kind} body should not be empty`)
      assert.ok(form.signatureBlocks.length > 0)
      // § 53.284 and the Florida and California forms are all signed, none notarized.
      assert.equal(form.requiresNotary, false, `${state}/${kind} should not require a notary`)
    }
  }
})

test("Florida cites progress/final forms and the check-payment condition separately", () => {
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [kind, resolveWaiverForm({ jurisdiction: "FL", kind, fields: FIELDS }).statutoryCitation]),
  )
  assert.deepEqual(byKind, {
    unconditional_progress: "Fla. Stat. § 713.20(4)",
    unconditional_final: "Fla. Stat. § 713.20(5)",
    conditional_progress: "Fla. Stat. § 713.20(4), (7)",
    conditional_final: "Fla. Stat. § 713.20(5), (7)",
  })
})

test("the four California citations are the prescribed sections 8132, 8134, 8136 and 8138", () => {
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [kind, resolveWaiverForm({ jurisdiction: "CA", kind, fields: FIELDS }).statutoryCitation]),
  )
  assert.deepEqual(byKind, {
    conditional_progress: "Cal. Civ. Code § 8132",
    unconditional_progress: "Cal. Civ. Code § 8134",
    conditional_final: "Cal. Civ. Code § 8136",
    unconditional_final: "Cal. Civ. Code § 8138",
  })
})

test("the four Texas citations are subsections (b) through (e) of section 53.284", () => {
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [kind, resolveWaiverForm({ jurisdiction: "TX", kind, fields: FIELDS }).statutoryCitation]),
  )
  assert.deepEqual(byKind, {
    conditional_progress: "Tex. Prop. Code § 53.284(b)",
    unconditional_progress: "Tex. Prop. Code § 53.284(c)",
    conditional_final: "Tex. Prop. Code § 53.284(d)",
    unconditional_final: "Tex. Prop. Code § 53.284(e)",
  })
})

test("an unknown or missing jurisdiction falls back to the generic, non-statutory form", () => {
  for (const jurisdiction of [null, "", "GA", "zz"]) {
    const form = resolveWaiverForm({ jurisdiction, kind: "conditional_progress", fields: FIELDS })
    assert.equal(form.statutory, false, `${String(jurisdiction)} should not be statutory`)
    assert.equal(form.statutoryCitation, null)
    assert.equal(form.jurisdiction, "")
    assert.equal(form.noticeBanner, null)
    assert.ok(form.body.join(" ").includes("$42,500.00"))
  }
})

test("fields are substituted into the body, not left as blanks", () => {
  for (const jurisdiction of ["FL", "CA", "TX", null]) {
    for (const kind of ["conditional_progress", "unconditional_progress"]) {
      const body = resolveWaiverForm({ jurisdiction, kind, fields: FIELDS }).body.join("\n")
      assert.ok(body.includes("$42,500.00"), `${String(jurisdiction)}/${kind} should carry the amount`)
      assert.ok(body.includes("August 31, 2026"), `${String(jurisdiction)}/${kind} should carry the through date`)
      assert.ok(body.includes("Gulf Coast Framing LLC") || body.includes("Naples Custom Builders"))
      assert.ok(!body.includes("(insert"), "no statutory insert markers should survive substitution")
    }
  }
})

test("the final forms name the claimant, customer and property without a through date blank", () => {
  const form = resolveWaiverForm({ jurisdiction: "FL", kind: "unconditional_final", fields: FIELDS })
  const body = form.body.join("\n")
  assert.ok(body.includes("Naples Custom Builders"))
  assert.ok(body.includes("412 Bayshore Dr, Naples, FL 34102"))
  assert.ok(body.includes("$42,500.00"))
  assert.ok(!body.includes("________"), "no unfilled blanks should remain")
})

test("California and Texas notices are present and upper-case", () => {
  const caConditional = resolveWaiverForm({ jurisdiction: "CA", kind: "conditional_progress", fields: FIELDS })
  const caUnconditional = resolveWaiverForm({ jurisdiction: "CA", kind: "unconditional_final", fields: FIELDS })
  const txUnconditional = resolveWaiverForm({ jurisdiction: "TX", kind: "unconditional_progress", fields: FIELDS })
  const txUnconditionalFinal = resolveWaiverForm({ jurisdiction: "TX", kind: "unconditional_final", fields: FIELDS })

  for (const form of [caConditional, caUnconditional, txUnconditional, txUnconditionalFinal]) {
    assert.ok(form.noticeBanner, `${form.jurisdiction} notice should be present`)
    assert.equal(form.noticeBanner, form.noticeBanner.toUpperCase(), "the statutory warning stays all-caps")
  }
  assert.ok(caConditional.noticeBanner.includes("EFFECTIVE ON RECEIPT OF PAYMENT"))
  assert.ok(caUnconditional.noticeBanner.includes("EVEN IF YOU HAVE NOT BEEN PAID"))
  assert.ok(txUnconditional.noticeBanner.includes("WAIVES RIGHTS UNCONDITIONALLY"))
  assert.ok(txUnconditionalFinal.noticeBanner.includes("ENFORCEABLE AGAINST YOU"))
  // Texas's conditional forms carry no notice paragraph; inventing one would be a defect.
  assert.equal(resolveWaiverForm({ jurisdiction: "TX", kind: "conditional_progress", fields: FIELDS }).noticeBanner, null)
})

test("Arc's payables waiver types map onto the statutory kinds", () => {
  assert.equal(mapPayablesWaiverKind("conditional", false), "conditional_progress")
  assert.equal(mapPayablesWaiverKind("conditional", true), "conditional_progress")
  assert.equal(mapPayablesWaiverKind("unconditional", false), "unconditional_progress")
  assert.equal(mapPayablesWaiverKind("unconditional", true), "unconditional_progress")
  // Retainage still held means the release cannot be final AND unconditional.
  assert.equal(mapPayablesWaiverKind("final", true), "conditional_final")
  assert.equal(mapPayablesWaiverKind("final", false), "conditional_final")
})

test("the property's state outranks the org's policy default", () => {
  assert.equal(
    resolveWaiverJurisdiction({ projectLocation: { state: "GA" }, policyDefault: "FL" }),
    "GA",
    "a Florida builder's Georgia job is a Georgia waiver",
  )
  assert.equal(
    resolveWaiverJurisdiction({ projectLocation: "900 Peachtree St, Atlanta, GA 30309", policyDefault: "FL" }),
    "GA",
  )
  assert.equal(resolveWaiverJurisdiction({ projectLocation: null, policyDefault: "FL" }), "FL")
  assert.equal(resolveWaiverJurisdiction({ projectLocation: { city: "Naples" }, policyDefault: "Texas" }), "TX")
  assert.equal(resolveWaiverJurisdiction({ projectLocation: null, policyDefault: null }), null)
})

test("the resolved jurisdiction drives the form that gets printed", () => {
  const jurisdiction = resolveWaiverJurisdiction({ projectLocation: { state: "CA" }, policyDefault: "FL" })
  const form = resolveWaiverForm({ jurisdiction, kind: "conditional_progress", fields: FIELDS })
  assert.equal(form.statutoryCitation, "Cal. Civ. Code § 8132")
})
