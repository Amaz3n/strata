// TAX-01 — 1099s (B05): every vendor payment of the year classified (over 1,000
// checks, the year boundary, card payments, a payment recorded twice, refunds
// inside and after the year), filing blocked until each payee can be filed, then
// a reviewed package per paying company, its filing-partner file with full
// taxpayer IDs for filers only, and its handoff, rejection, acceptance and
// correction kept on record.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const ADDRESS = (street) => ({ street1: street, city: "Naples", state: "FL", postal_code: "34102" })

function vendor(kit, org, { name, entityType, w9 = true, address = true }) {
  const id = randomUUID()
  kit.sql(`insert into public.companies(id,org_id,name,company_type,tax_entity_type,is_1099_eligible,w9_received_at,address)
    values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(name)},'subcontractor',${kit.q(entityType)},true,${w9 ? "now()" : "null"},${address ? `${kit.q(JSON.stringify(ADDRESS(`${name.length} Main St`)))}::jsonb` : "null"})`)
  return id
}

// Paid bills as the payables desk leaves them: an approved bill and its payment.
function paid(kit, org, companyId, { cents, at, method = "check", count = 1 }) {
  kit.sql(`with b as (insert into public.vendor_bills(id,org_id,company_id,bill_number,bill_date,due_date,status,total_cents,paid_cents,paid_at,currency)
      select gen_random_uuid(),${kit.q(org.orgId)},${kit.q(companyId)},'T-'||left(gen_random_uuid()::text,8),${kit.q(at.slice(0, 10))},${kit.q(at.slice(0, 10))},'paid',${cents},${cents},${kit.q(at)},'usd' from generate_series(1,${count}) returning id)
    insert into public.payments(org_id,bill_id,amount_cents,method,status,received_at,currency,provider)
      select ${kit.q(org.orgId)},b.id,${cents},${kit.q(method)},'succeeded',${kit.q(at)},'usd','manual' from b`)
  return kit.rows(`select id, bill_id from public.payments where org_id=${kit.q(org.orgId)} and bill_id in (select id from public.vendor_bills where company_id=${kit.q(companyId)}) and received_at=${kit.q(at)} and amount_cents=${cents} order by id`)
}

async function builder(kit, name, password) {
  const org = await greenfieldOrg(kit, { name, periods: ["2026-01"], password })
  // A Books member who reads but does not file taxes.
  org.reader = { userId: randomUUID(), orgId: org.orgId, productTier: "residential", role: "org_books_reviewer" }
  kit.sql(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
      values(${kit.q(org.reader.userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${kit.q(`${org.reader.userId}@acceptance.example.test`)},'',now(),now(),'{}','{}','','','','','','','','');
    insert into public.app_users(id,email,full_name) values(${kit.q(org.reader.userId)},${kit.q(`${org.reader.userId}@acceptance.example.test`)},'Books reader');
    insert into public.memberships(org_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(org.reader.userId)},id,'active' from public.roles where key='org_books_reviewer';`)
  return org
}

// The year's payments, by vendor, independent of the report.
async function yearOfPayments(kit, org, input) {
  const tax = app("books/tax-register")
  const framing = vendor(kit, org, { name: "Cedar Framing LLC", entityType: "llc" })
  const rivera = vendor(kit, org, { name: "Pat Rivera", entityType: "individual" })
  const painting = vendor(kit, org, { name: "Gulf Painting LLC", entityType: "llc" })
  const roofing = vendor(kit, org, { name: "Summit Roofing LLC", entityType: "llc", w9: false })
  for (const [id, tin] of [[framing, "123456781"], [rivera, "987654324"], [painting, "555443333"]]) await kit.as(org.owner, () => tax.storeCompanyTaxIdentity({ companyId: id, tin }))
  paid(kit, org, framing, { cents: input.checkCents, at: "2026-03-15T15:00:00Z", count: input.checks })
  paid(kit, org, framing, { cents: input.boundaryCents, at: "2025-12-31T15:00:00Z" })
  paid(kit, org, framing, { cents: input.boundaryCents, at: "2027-01-02T15:00:00Z" })
  paid(kit, org, framing, { cents: input.cardCents, at: "2026-05-01T15:00:00Z", method: "credit_card" })
  const [ach] = paid(kit, org, framing, { cents: input.achCents, at: "2026-06-01T15:00:00Z", method: "ach" })
  kit.sql(`insert into public.payment_allocations(org_id,payment_id,bill_id,amount_cents) values(${kit.q(org.orgId)},${kit.q(ach.id)},${kit.q(ach.bill_id)},${input.achCents})`)
  const [refunded] = paid(kit, org, framing, { cents: input.refundedPaymentCents, at: "2026-07-01T15:00:00Z" })
  const reverse = (payment, cents, at) => kit.sql(`insert into public.payment_reversals(org_id,payment_id,bill_id,amount_cents,reversal_type,status,occurred_at) values(${kit.q(org.orgId)},${kit.q(payment.id)},${kit.q(payment.bill_id)},${cents},'refund','succeeded',${kit.q(at)})`)
  reverse(refunded, input.refundCents, "2026-07-20T15:00:00Z")
  const [late] = paid(kit, org, framing, { cents: input.lateRefundedPaymentCents, at: "2026-12-01T15:00:00Z" })
  reverse(late, input.lateRefundCents, "2027-01-15T15:00:00Z")
  paid(kit, org, rivera, { cents: input.riveraCents, at: "2026-09-01T15:00:00Z" })
  paid(kit, org, painting, { cents: input.paintingCents, at: "2026-10-01T15:00:00Z" })
  paid(kit, org, roofing, { cents: input.roofingCents, at: "2026-11-01T15:00:00Z" })
  return { framing, rivera, painting, roofing }
}

const byName = (report) => Object.fromEntries(report.rows.map((row) => [row.vendor_name, { paid: row.total_paid_cents, reportable: row.meets_threshold, blocked: row.blocking_reasons }]))

async function annualClassification(kit, expected, check) {
  const input = expected.inputs
  const org = await builder(kit, "TAX-01 classification")
  await yearOfPayments(kit, org, input)
  const report = await kit.as(org.owner, () => app("reports/vendor-1099").getVendor1099Report({ year: 2026 }))
  const prior = await kit.as(org.owner, () => app("reports/vendor-1099").getVendor1099Report({ year: 2025 }))
  check.equal("each vendor's reportable payments for 2026, the threshold from the year's policy, and what blocks filing", expected.expected, {
    threshold: report.threshold_cents, vendors: byName(report), total: report.total_paid_cents,
    priorYear: { threshold: prior.threshold_cents, framing: byName(prior)["Cedar Framing LLC"].paid },
    readerSeesLastFourOnly: (await kit.as(org.reader, () => app("reports/vendor-1099").getVendor1099Report({ year: 2026 }))).rows.every((row) => !row.tax_id_last4 || /^\d{4}$/.test(row.tax_id_last4)),
  })
  return { orgId: org.orgId }
}

async function packageAndHandoff(kit, expected, check) {
  const input = expected.inputs
  const org = await builder(kit, "TAX-01 package")
  const vendors = await yearOfPayments(kit, org, input)
  const packages = app("books/vendor-1099-packages")
  const prepare = (extra = {}) => kit.as(org.owner, () => packages.prepare1099Package({ taxYear: 2026, idempotencyKey: `tax01-${randomUUID()}`, ...extra }))
  const blocked = await refusal(() => prepare())
  const primary = kit.rows(`select public.books_primary_entity(${kit.q(org.orgId)}) id`)[0].id
  await kit.as(org.owner, () => packages.setPayerTaxIdentity({ legalEntityId: primary, tin: "11-2223334", address: ADDRESS("100 Builder Way") }))
  // Summit Roofing sends its W-9.
  kit.sql(`update public.companies set w9_received_at=now() where id=${kit.q(vendors.roofing)}`)
  await kit.as(org.owner, () => app("books/tax-register").storeCompanyTaxIdentity({ companyId: vendors.roofing, tin: "444556666" }))
  const first = await prepare()
  const selfApproval = await refusal(() => kit.as(org.owner, () => packages.approve1099Package({ id: first.id, notes: "Matched to the payables register" })))
  paid(kit, org, vendors.rivera, { cents: input.latePaymentCents, at: "2026-12-20T15:00:00Z" })
  const stale = await refusal(() => kit.as(org.reviewer, () => packages.approve1099Package({ id: first.id, notes: "Matched to the payables register" })))
  await kit.as(org.owner, () => packages.withdraw1099Package({ id: first.id, reason: "A December payment arrived after preparation" }))
  const second = await prepare()
  await kit.as(org.reviewer, () => packages.approve1099Package({ id: second.id, notes: "Matched to the payables register" }))
  const readerFile = await refusal(() => kit.as(org.reader, () => packages.build1099FilingFile(second.id)))
  const readerView = await kit.as(org.reader, () => packages.getVendor1099Packages(2026))
  // The partner is down: the reviewed file is still there to download, and nothing says it was filed.
  const file = await kit.as(org.owner, () => packages.build1099FilingFile(second.id))
  const statusBeforeHandoff = kit.rows(`select status from public.books_1099_packages where id=${kit.q(second.id)}`)[0].status
  const lines = file.content.trimEnd().split("\n")
  await kit.as(org.owner, () => packages.record1099Submission({ id: second.id, partner: "Filing partner sandbox", reference: "SANDBOX-001" }))
  await kit.as(org.owner, () => packages.record1099Outcome({ id: second.id, outcome: "rejected", notes: "Recipient name mismatch for Pat Rivera" }))
  await kit.as(org.owner, () => packages.record1099Submission({ id: second.id, partner: "Filing partner sandbox", reference: "SANDBOX-002" }))
  await kit.as(org.owner, () => packages.record1099Outcome({ id: second.id, outcome: "accepted", notes: "Accepted by the partner" }))
  // A missed check is found: a corrected package replaces the accepted one.
  paid(kit, org, vendors.painting, { cents: input.missedPaintingCents, at: "2026-12-28T15:00:00Z" })
  const correction = await prepare({ supersedesId: second.id })
  await kit.as(org.reviewer, () => packages.approve1099Package({ id: correction.id, notes: "Corrected for the missed December check" }))
  const history = kit.rows(`select id, status, partner_reference, outcome_notes, reviewed_by::text reviewer, payee_count, total_cents from public.books_1099_packages where org_id=${kit.q(org.orgId)} order by prepared_at`)
  const corrected = await kit.as(org.owner, () => packages.build1099FilingFile(correction.id))
  check.equal("blocked until every payee can be filed; reviewed by someone else against current payments; the file for filers only; handoff, rejection, acceptance and correction on record", expected.expected, {
    blocked: input.blockingReasons.map((reason) => blocked.includes(reason)),
    selfApprovalRefused: /someone other than/.test(selfApproval), staleRefused: /changed after this package was prepared/.test(stale),
    readerFileRefused: readerFile !== "allowed", readerSeesNoFullTin: !JSON.stringify(readerView).match(/\b\d{9}\b/),
    file: { header: lines[0], rows: lines.length - 1, rivera: lines.find((line) => line.includes("Pat Rivera")).split(",").slice(6, 8).concat(lines.find((line) => line.includes("Pat Rivera")).split(",")[13]), payerTin: lines[1].split(",")[0] },
    statusBeforeHandoff,
    history: history.map((row) => ({ status: row.status, reference: row.partner_reference, outcome: row.outcome_notes, reviewed: row.reviewer === org.reviewer.userId, payees: row.payee_count, total: Number(row.total_cents) })),
    correctedFileRows: corrected.content.trimEnd().split("\n").length - 1,
  })
  return { orgId: org.orgId, packages: history.map((row) => row.id) }
}

module.exports = {
  helpers: { builder, yearOfPayments, ADDRESS },
  id: "TAX-01",
  subcases: {
    "annual-classification": annualClassification,
    "package-review-and-handoff": packageAndHandoff,
  },
}
