// AUTH-01 — who can do what in Books (B15.3). The owner, an accountant, a Books
// reviewer, a project lead and a member of another organization try the Books
// paths: statements, the 1099 report and packages, companies, cost allocations,
// journals, preparing and approving a 1099 package (maker and checker), adding a
// company and the 1099 filing file. Every refusal happens on the server, and
// nobody without tax-filing rights ever receives a full taxpayer ID.
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")

const TINS = ["123456781", "487654324", "555443333", "444556666", "112223334"]

function member(kit, org, role) {
  const userId = randomUUID(), email = `${userId}@acceptance.example.test`
  kit.sql(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
      values(${kit.q(userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${kit.q(email)},'',now(),now(),'{}','{}','','','','','','','','');
    insert into public.app_users(id,email,full_name) values(${kit.q(userId)},${kit.q(email)},${kit.q(role)});
    insert into public.memberships(org_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(userId)},id,'active' from public.roles where key=${kit.q(role)};`)
  return { userId, orgId: org.orgId, productTier: "residential", role, email }
}

async function roleMatrix(kit, expected, check) {
  const tax = require("./tax-01.cjs").helpers
  const org = await tax.builder(kit, "AUTH-01 roles")
  const vendors = await tax.yearOfPayments(kit, org, require("../expected/TAX-01.json").subcases["package-review-and-handoff"].inputs)
  kit.sql(`update public.companies set w9_received_at=now() where id=${kit.q(vendors.roofing)}`)
  await kit.as(org.owner, () => app("books/tax-register").storeCompanyTaxIdentity({ companyId: vendors.roofing, tin: "444556666" }))
  const primary = kit.rows(`select public.books_primary_entity(${kit.q(org.orgId)}) id`)[0].id
  await kit.as(org.owner, () => app("books/vendor-1099-packages").setPayerTaxIdentity({ legalEntityId: primary, tin: "112223334", address: tax.ADDRESS("100 Builder Way") }))
  const foreignOrg = await tax.builder(kit, "AUTH-01 another builder")
  const actors = { owner: org.owner, accountant: org.reviewer, booksReviewer: org.reader, projectLead: member(kit, org, "org_project_lead"), foreign: foreignOrg.owner }

  const seen = Object.fromEntries(Object.keys(actors).map((name) => [name, []]))
  const outcome = async (name, work) => {
    try { seen[name].push(JSON.stringify(await kit.as(actors[name], work) ?? null)); return "allowed" }
    catch (error) {
      const message = String(error?.message ?? error)
      if (/permission|not authorized|access denied|forbidden|not found|someone other than|outside|no access|cannot/i.test(message)) return "refused"
      return `error: ${message.slice(0, 160)}`
    }
  }
  const packages = app("books/vendor-1099-packages")
  const reads = {
    statements: () => app("books/statement-detail").getStatementsForPeriod({ startDate: "2026-01-01", endDate: "2026-01-31", comparison: "none", legalEntityId: null }),
    vendor1099Report: () => app("reports/vendor-1099").getVendor1099Report({ year: 2026 }),
    packages: () => packages.getVendor1099Packages(2026),
    companies: () => app("books/legal-entities").getLegalEntityWorkspace(),
    costAllocations: () => app("books/cost-allocations").getCostAllocationRegister(),
  }
  const matrix = {}
  for (const name of Object.keys(actors)) {
    matrix[name] = {}
    for (const [op, work] of Object.entries(reads)) matrix[name][op] = await outcome(name, work)
    matrix[name].journal = await outcome(name, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-01-20", memo: `Reclass by ${name}`,
      lines: [{ accountCode: "6900", debitCents: 100, creditCents: 0 }, { accountCode: "6010", debitCents: 0, creditCents: 100 }] }))
  }
  // Maker and checker: the accountant prepares, cannot approve, and the owner approves.
  for (const name of ["projectLead", "booksReviewer", "accountant"]) matrix[name].preparePackage = await outcome(name, () => packages.prepare1099Package({ taxYear: 2026, idempotencyKey: `auth-${randomUUID()}` }))
  const draft = kit.rows(`select id from public.books_1099_packages where org_id=${kit.q(org.orgId)} and status='prepared'`)[0].id
  for (const name of ["projectLead", "booksReviewer", "foreign", "accountant", "owner"]) matrix[name].approvePackage = await outcome(name, () => packages.approve1099Package({ id: draft, notes: `Reviewed by ${name} against payables` }))
  for (const name of Object.keys(actors)) matrix[name].filingFile = await outcome(name, () => packages.build1099FilingFile(draft))
  for (const name of ["projectLead", "booksReviewer", "accountant", "owner"]) matrix[name].addCompany = await outcome(name, () => app("books/legal-entities").createLegalEntity({ name: `Land company by ${name}`, legalName: null }))

  const leaked = (text) => TINS.some((tin) => text.includes(tin))
  const all = Object.values(seen).flat()
  check.equal("each role reaches exactly what it should; maker and checker are different people; only filers receive full taxpayer IDs; another organization sees none of this one", expected.expected, {
    matrix,
    fullTinOnlyInFilingFiles: all.filter(leaked).every((text) => text.includes("Recipient TIN")) && !seen.booksReviewer.some(leaked) && !seen.projectLead.some(leaked),
    foreignSeesNothingOfOurs: !seen.foreign.some((text) => text.includes(org.orgId) || text.includes("Cedar Framing") || text.includes("Pat Rivera")),
  })
  return { orgId: org.orgId, foreignOrgId: foreignOrg.orgId }
}

module.exports = {
  id: "AUTH-01",
  subcases: { "role-matrix": roleMatrix },
}
