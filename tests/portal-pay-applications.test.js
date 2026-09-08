require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { buildClientPortalNav } = require("../components/portal/shell/portal-nav-items")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath))
}

const ACTIONS = "app/p/[token]/pay-applications/actions.ts"

test("the owner portal has a pay-application register, a detail route and its actions", () => {
  assert.ok(exists("app/p/[token]/pay-applications/page.tsx"))
  assert.ok(exists("app/p/[token]/pay-applications/[id]/page.tsx"))
  assert.ok(exists(ACTIONS))

  const register = source("app/p/[token]/pay-applications/page.tsx")
  const detail = source("app/p/[token]/pay-applications/[id]/page.tsx")

  // Both pages go through the shared loaders, which run the gate. Neither may
  // reach the service on its own.
  assert.match(register, /loadClientPortalPayApplicationsPage/)
  assert.match(detail, /loadClientPortalPayApplicationPage/)
  assert.doesNotMatch(register, /listPayApplicationsForPortal/)
  assert.doesNotMatch(detail, /getPayApplicationForPortal/)

  // The email's deep link lands on the detail route.
  assert.match(
    source("lib/services/pay-applications.ts"),
    /buttonUrl: `\$\{base\}\/pay-applications\/\$\{payApplicationId\}`/,
  )
})

test("the portal loaders gate on the invoice permission before reading", () => {
  const loader = source("app/p/[token]/load-portal.ts")

  for (const fn of ["loadClientPortalPayApplicationsPage", "loadClientPortalPayApplicationPage"]) {
    const body = loader.slice(loader.indexOf(`export async function ${fn}`))
    const gate = body.indexOf("if (!access.permissions.can_view_invoices) notFound()")
    assert.ok(gate > -1, `${fn} must check can_view_invoices`)
    assert.ok(gate < body.indexOf("ForPortal({"), `${fn} must gate before it reads`)
    // One read each: the summary carries every figure the pages render.
    assert.doesNotMatch(body.slice(0, body.indexOf("\n}")), /Promise\.all/)
  }
})

test("both portal actions re-assert the token before acting", () => {
  const actions = source(ACTIONS)

  assert.match(
    actions,
    /assertPortalActionAccess\(token, \{\s*portalType: "client",\s*requireProject: true,\s*permission: "can_certify_pay_applications",\s*\}\)/,
  )

  for (const fn of ["certifyPayApplicationPortalAction", "returnPayApplicationPortalAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`))
    const assertion = body.indexOf("resolvePortalActor(token, payApplicationId)")
    assert.ok(assertion > -1, `${fn} must resolve the actor through the token gate`)
    assert.ok(
      assertion < body.indexOf("WithActor("),
      `${fn} must re-assert the token before it calls the service`,
    )
  }

  // Thrown errors are redacted to a digest in production.
  assert.match(actions, /Promise<ActionResult<\{ invoiceId: string \}>>/)
  assert.match(actions, /Promise<ActionResult<\{ revision: number \}>>/)
  assert.match(actions, /return runAction\(async \(\) => \{/)
})

test("the owner can only reduce a certificate through explained line deferrals", () => {
  const actions = source(ACTIONS)
  const dialog = source("components/portal/pay-applications/portal-pay-application-actions.tsx")

  // The browser never submits a free-form certified total. It submits bounded
  // SOV-line deferrals and the service derives the certified amount.
  assert.doesNotMatch(actions, /certifiedAmountCents/)
  assert.doesNotMatch(dialog, /certifiedAmountCents/)

  const schema = actions.slice(actions.indexOf("const certifySchema"), actions.indexOf("const returnSchema"))
  assert.match(schema, /signerName/)
  assert.match(schema, /signatureText/)
  assert.match(schema, /consentAccepted/)
  assert.match(schema, /prime_sov_line_id/)
  assert.match(schema, /deferred_cents: z\.number\(\)\.int\(\)\.positive\(\)\.safe\(\)/)
  assert.match(schema, /reason: z\.string\(\)\.trim\(\)\.min\(3\)/)

  assert.match(dialog, /PayApplicationDeferralEditor/)
  assert.match(dialog, /certificate\.deferrals/)
  assert.match(dialog, /electronic signature/i)
})

test("the return dialog warns that the invoice is voided", () => {
  const dialog = source("components/portal/pay-applications/portal-pay-application-actions.tsx")
  assert.match(dialog, /Returning voids the/)
  assert.match(dialog, /variant="destructive"/)
})

test("the nav offers pay applications only when the project has them", () => {
  const permissions = { can_view_invoices: true }
  const counts = { actions: 0, payApplicationsAwaitingCertificate: 2 }
  const base = { permissions, counts, hasInvoices: true, has3dModel: false }

  const without = buildClientPortalNav({ ...base, hasPayApplications: false })
  assert.equal(
    without.find((item) => item.segment === "pay-applications"),
    undefined,
  )

  const withApps = buildClientPortalNav({ ...base, hasPayApplications: true })
  const item = withApps.find((item) => item.segment === "pay-applications")
  assert.ok(item, "the tab must appear once an application exists")
  assert.equal(item.count, 2, "the badge must say how many await a certificate")

  // A link that cannot see invoices cannot see applications either.
  const unpermitted = buildClientPortalNav({
    ...base,
    permissions: { can_view_invoices: false },
    hasPayApplications: true,
  })
  assert.equal(
    unpermitted.find((item) => item.segment === "pay-applications"),
    undefined,
  )
})

test("the shell context reads the pay-application facts in its existing Promise.all", () => {
  const service = source("lib/services/portal-access.ts")
  const start = service.indexOf("export async function loadClientPortalShellContext")
  const end = service.indexOf("export async function loadSubPortalSharedFiles")
  assert.ok(start > -1 && end > start)
  const body = service.slice(start, end)

  // One await for every read the chrome needs. A second one would be a
  // sequential round trip on every navigation.
  assert.equal(body.match(/await Promise\.all/g).length, 1)
  assert.equal((body.match(/\bawait\b/g) || []).length, 1)

  const batch = body.slice(body.indexOf("await Promise.all(["), body.indexOf("])"))
  assert.match(batch, /\.from\("pay_applications"\)/)
  assert.match(batch, /POSTED_PAY_APPLICATION_STATUSES/)

  // The badge mirrors `awaiting_certificate`: sent to the owner, not certified,
  // and only where the posture actually wants a certificate.
  assert.match(body, /readSentToOwner\(row\.metadata\) !== null/)
  assert.match(body, /!readCertification\(row\.metadata\)/)
  assert.match(body, /approvalMode === "required_review"/)
  assert.match(body, /hasPayApplications: payApplications\.length > 0/)
})

test("the approvals page can show what its badge counts", () => {
  const service = source("lib/services/portal-access.ts")
  assert.match(service, /payApplicationsAwaitingCertificate: awaitingCertificate/)
  assert.match(service, /\(decisionCount\.count \?\? 0\) \+\n\s*awaitingCertificate/)

  const page = source("app/p/[token]/actions/page.tsx")
  assert.match(page, /loadClientPortalActionsPage/)
  assert.match(page, /payApplications=\{payApplications\}/)

  const tab = source("components/portal/tabs/portal-actions-tab.tsx")
  assert.match(tab, /payApplications\.length > 0/)
  assert.match(tab, /pay-applications\/\$\{application\.id\}/)
})

test("the continuation sheet scrolls inside itself and collapses on a phone", () => {
  const document = source("components/portal/pay-applications/portal-pay-application-document.tsx")
  assert.match(document, /overflow-x-auto/)
  assert.match(document, /sm:hidden/)
  assert.match(document, /hidden overflow-x-auto sm:block/)

  // The nine G702 lines, in the order the certificate prints them, every one
  // read straight off the summary.
  const summary = document.slice(document.indexOf("function g702Lines"), document.indexOf("export function PayApplicationG702Summary"))
  const lines = [...summary.matchAll(/label: "([^"]+)", cents: ([\w.]+)/g)]
  assert.equal(lines.length, 9)
  for (const [, label, expression] of lines) {
    assert.match(expression, /^application\./, `${label} must come from the summary`)
  }
  const labels = lines.map((match) => match[1])
  assert.deepEqual(labels, [
    "Original contract sum",
    "Net change by change orders",
    "Contract sum to date",
    "Total completed and stored to date",
    "Retainage",
    "Total earned less retainage",
    "Less previous certificates for payment",
    "Current payment due",
    "Balance to finish, plus retainage",
  ])
})

test("the register and detail money is tabular and the PDF comes from the shared file route", () => {
  const register = source("components/portal/pay-applications/portal-pay-application-register.tsx")
  const detail = source("app/p/[token]/pay-applications/[id]/page.tsx")

  assert.match(register, /text-right font-semibold tabular-nums/)
  assert.match(register, /No pay applications yet/)
  assert.match(detail, /\/api\/portal\/files\/\$\{token\}\/\$\{application\.pdf_file_id\}/)

  // Actions only exist where the owner may act.
  assert.match(detail, /application\.awaiting_certificate && access\.permissions\.can_certify_pay_applications \?/)
})

test("nothing re-reads figures the portal summary already carries", () => {
  const service = source("lib/services/portal-access.ts")
  const loader = source("app/p/[token]/load-portal.ts")
  const detail = source("app/p/[token]/pay-applications/[id]/page.tsx")
  const document = source("components/portal/pay-applications/portal-pay-application-document.tsx")

  // The summary gained the four figures this helper used to fetch, so the
  // helper and its parallel read are gone rather than left as a second
  // implementation of the same nine lines.
  for (const [name, text] of [
    ["portal-access", service],
    ["load-portal", loader],
    ["detail page", detail],
    ["document", document],
  ]) {
    assert.doesNotMatch(text, /G702Basis/, `${name} must not reference the deleted basis read`)
    assert.doesNotMatch(text, /\bbasis\b/, `${name} must not carry a basis prop`)
  }

  assert.match(
    source("lib/services/pay-applications.ts"),
    /original_contract_sum_cents: app\.original_contract_sum_cents/,
  )
})
