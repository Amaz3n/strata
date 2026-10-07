// DIM-01 — reporting dimensions on posted lines: which each document carries,
// that they name only the company's own records and never an ambiguous one, and
// that they stay as posted through later changes and reversals.
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")
const { jobOrg, createBill, editBill, incrementalJob, projectionJob, glId } = require("./status-01.cjs").helpers

// One job fully tagged: a division, a community with one lot, one fixed-price
// contract, and the bill's cost code.
async function taggedJob(kit, name, input) {
  const org = await jobOrg(kit, name, ["2026-07"])
  const { q } = kit
  org.divisionId = randomUUID(); org.communityId = randomUUID(); org.lotId = randomUUID(); org.contractId = randomUUID()
  kit.sql(`begin;
insert into public.divisions(id,org_id,name) values(${q(org.divisionId)},${q(org.orgId)},'South division');
insert into public.communities(id,org_id,name) values(${q(org.communityId)},${q(org.orgId)},'Cedar Ridge');
insert into public.lots(id,org_id,community_id,lot_number,project_id) values(${q(org.lotId)},${q(org.orgId)},${q(org.communityId)},'14',${q(org.projectId)});
update public.projects set division_id=${q(org.divisionId)} where id=${q(org.projectId)};
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(org.contractId)},${q(org.orgId)},${q(org.projectId)},'Fixed-price construction contract','active',${input.contractCents},'usd','fixed',0,'2026-07-01');
commit;`)
  return org
}

function projectInvoice(kit, org, number, cents, issueDate) {
  const { q } = kit
  kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(org.projectId)},'invoice_number',${q(number)},
  'title','Progress billing','issue_date',${q(issueDate)},'due_date',${q(issueDate)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())}),
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  return kit.rows(`select id from public.invoices where org_id=${q(org.orgId)} and invoice_number=${q(number)}`)[0].id
}

// The dimension keys on each posted line of a source, by account code; the
// classification stamp is evidence beside the posting and left out.
function lineKeys(kit, org, sourceId) {
  const rows = kit.rows(`select a.code, l.dimensions from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${kit.q(org.orgId)} and e.source_id=${kit.q(sourceId)} and e.status='posted' order by a.code`)
  return Object.fromEntries(rows.map((row) => [row.code, Object.keys(row.dimensions ?? {}).filter((key) => key !== "books_account_classification").sort()]))
}

async function matrixOnLines(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 matrix", input)
  const bill = await createBill(kit, org, input.billDate, input.cents)
  const invoice = projectInvoice(kit, org, "DIM-1", input.cents, input.billDate)
  await incrementalJob(kit, org)
  const payment = await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${input.paymentDate}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice, amount_cents: input.cents }] }))
  await kit.drainOutbox(org.orgId)
  await incrementalJob(kit, org)
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice)}`)[0].id
  check.equal("each document carries the dimensions the matrix lists", expected.expected, {
    vendorBill: lineKeys(kit, org, bill), invoice: lineKeys(kit, org, invoice), invoicePayment: lineKeys(kit, org, paymentId),
  })
  return { orgId: org.orgId, payment }
}

// A line naming another company's record is refused with its cure; the same
// journal naming the company's own record posts.
async function foreignDimension(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 foreign", input)
  const other = await taggedJob(kit, "DIM-01 other company", input)
  const journal = (costCodeId) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: input.journalDate, memo: "Reclassify framing overrun",
    lines: [{ accountCode: "6900", debitCents: input.cents, creditCents: 0, projectId: org.projectId, dimensions: { cost_code_id: costCodeId } }, { accountCode: "3010", debitCents: 0, creditCents: input.cents }] }))
  const attempt = async (costCodeId) => { try { await journal(costCodeId); return "posted" } catch (error) { return /not in this company/.test(error.message) ? "refused: not in this company" : `refused: ${error.message.slice(0, 160)}` } }
  check.equal("another company's cost code is refused; the company's own posts", expected.expected, { foreign: await attempt(other.costCodeId), missing: await attempt(randomUUID()), own: await attempt(org.costCodeId) })
  return { orgId: org.orgId }
}

// A project sits on at most one lot, so its lot tag is never a guess: the
// database refuses a second lot for the same project.
async function oneLotPerProject(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 one lot", input)
  let refusal = "accepted"
  try { kit.sql(`insert into public.lots(org_id,community_id,lot_number,project_id) values(${kit.q(org.orgId)},${kit.q(org.communityId)},'15',${kit.q(org.projectId)})`) }
  catch (error) { refusal = /lots_project_unique/.test(error.message) ? "refused: lots_project_unique" : `refused: ${error.message.slice(0, 120)}` }
  check.equal("a second lot for the project is refused", expected.expected, { secondLot: refusal })
  return { orgId: org.orgId }
}

// Renaming the community and moving the job to another division relabel nothing
// already posted (account renames: BILL-01 account-rename-preserves-posted-history); a real revision reverses the posted
// entry with its original dimensions and re-posts with today's.
async function laterChangesAndReversal(kit, expected, check) {
  const input = expected.inputs
  const org = await taggedJob(kit, "DIM-01 later changes", input)
  const bill = await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  const { q } = kit
  const postedLines = () => kit.rows(`select a.code, l.dimensions - 'books_account_classification' dims from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${q(org.orgId)} and e.source_id=${q(bill)} and e.status='posted' order by a.code, l.line_no`)
  const before = postedLines()
  kit.sql(`begin;
update public.communities set name='Cedar Ridge North' where id=${q(org.communityId)};
insert into public.divisions(org_id,name) values(${q(org.orgId)},'North division');
update public.projects set division_id=(select id from public.divisions where org_id=${q(org.orgId)} and name='North division') where id=${q(org.projectId)};
commit;`)
  await incrementalJob(kit, org)
  await projectionJob(kit, org)
  const unchanged = JSON.stringify(postedLines()) === JSON.stringify(before)
  await editBill(kit, org, bill, { actual_lines: [{ description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, "5020") }] })
  await incrementalJob(kit, org)
  const original = kit.rows(`select id from public.journal_entries where org_id=${q(org.orgId)} and source_id=${q(bill)} and status='reversed'`)[0]?.id
  const reversalDims = kit.rows(`select l.dimensions - 'books_account_classification' dims from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
    where e.org_id=${q(org.orgId)} and e.reversal_of_entry_id=${q(original)} order by l.line_no`).map((row) => row.dims)
  const originalDims = kit.rows(`select l.dimensions - 'books_account_classification' dims from public.journal_lines l where l.entry_id=${q(original)} order by l.line_no`).map((row) => row.dims)
  const replacementDivisions = kit.rows(`select distinct l.dimensions->>'division_name' division from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.org_id=${q(org.orgId)} and e.source_id=${q(bill)} and e.status='posted'`).map((row) => row.division)
  check.equal("later renames and moves relabel nothing; a revision reverses with the original dimensions and re-posts with today's", expected.expected, {
    postedLinesUnchanged: unchanged,
    reversalMatchesOriginal: originalDims.length > 0 && JSON.stringify(reversalDims) === JSON.stringify(originalDims),
    originalDivision: [...new Set(originalDims.map((dims) => dims.division_name))],
    replacementDivision: replacementDivisions,
  })
  return { orgId: org.orgId, bill }
}

module.exports = {
  id: "DIM-01",
  subcases: {
    "matrix-on-lines": matrixOnLines,
    "foreign-dimension-refused": foreignDimension,
    "one-lot-per-project": oneLotPerProject,
    "later-changes-and-reversal": laterChangesAndReversal,
  },
}
