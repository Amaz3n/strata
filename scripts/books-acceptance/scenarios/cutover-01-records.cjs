// CUTOVER-01 cutover records that are not Books openings (EP12-04, EP12-05):
//
//   agreement-with-executed-file-is-bound-and-immutable   (needs --storage-env; BLOCKED without it)
//                                         a signed-agreements row binds the executed copy uploaded to Documents by the
//                                         SHA-256 the server computes from its stored bytes, with its signers and date, as a
//                                         signed document on the agreement; a reviewer attaches another the same way; a wrong
//                                         hash is refused; the evidence cannot change or be deleted; a re-import matches
//   executed-copy-hash-is-verified-from-stored-bytes
//                                         the checksum a file row carries is only a lookup hint: a copy whose bytes the
//                                         server cannot read is never bound, by import or review, and the database refuses an
//                                         executed copy without a server-verified hash or whose recorded checksum disagrees
//   agreement-without-file-blocks-closing-until-reviewed
//                                         an imported agreement with no executed copy waits for review: the closing gate
//                                         cannot be completed or waived until a reviewer accepts it with a reason, and a
//                                         reviewed agreement is never reviewed again
//   agreement-evidence-and-history-stay-in-the-reviewers-divisions
//                                         a closing reviewer limited to one division sees and reviews only that division's
//                                         imported agreements, and reads only its evidence and inspection history rows
//   deposits-link-and-reconcile-per-home  opening customer deposits on each home reconcile to the deposits the agreements
//                                         file states; a home that differs and a deposit with no home are reported
//   selections-cutoffs-and-balances-reconcile
//                                         current selections keep the price the buyer was given and the price sheet it came
//                                         from, cutoffs land as imported overrides, a change-order balance amends the
//                                         agreement once, and each home's totals reconcile to the source's
//   concurrent-balance-imports-amend-once two batches committing one home's change-order balance at once amend its agreement
//                                         once; the other row matches it
//   inspection-history-is-read-only-and-the-lifecycle-stays-the-only-path
//                                         past inspections land as read-only history and never as inspections; a new
//                                         inspection still starts in the lifecycle, and a completed one cannot be written
//   each-import-takes-its-owners-permission
//                                         members without the domain permission are refused each importer, the cutover
//                                         reconciliation shows only the sections a viewer may see, and the warranty
//                                         installed base appears in it
//
// SQL writes only fixtures no service creates here: the homes, agreements and buyers exactly as Open WIP's commit writes
// them (CUTOVER-01's resume subcases and LOT-01 prove that commit), a community's option catalog and selection group, a
// projected closing, and, where a subcase proves what happens when the bytes cannot be read, a PDF row with no stored
// object. An executed copy is only ever bound by the hash the server computes from the stored object, so the subcase that
// binds one uploads real PDFs through Documents and runs only with acceptance storage (--storage-env).
const { createHash, randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, monthBounds } = require("./shared.cjs")
const { asMember } = require("./sessions.cjs")
/** One value read as a member, with row-level security in force. */
const memberCount = (kit, actor, statement) => Number(kit.sql(`${asMember(actor)} ${statement}`).split("\n").pop())

const COMMUNITY = "Cypress Landing"
const AGREEMENT_HEADERS = ["community", "lot_number", "block", "signed_date", "sale_price_cents", "deposit_cents", "signers", "executed_file", "executed_sha256"]
const SELECTION_HEADERS = ["community", "lot_number", "block", "option_code", "price_cents", "price_version", "selected_on", "status"]
const CUTOFF_HEADERS = ["community", "lot_number", "block", "group", "cutoff_date", "locked"]
const TOTAL_HEADERS = ["community", "lot_number", "block", "selection_count", "selections_total_cents", "change_order_balance_cents"]
const INSPECTION_HEADERS = ["community", "lot_number", "block", "inspection_type", "inspected_on", "result", "inspector", "reference"]
const WARRANTY_HEADERS = ["community", "lot_number", "block", "address", "buyer_name", "buyer_email", "closing_date", "program", "workmanship_months", "systems_months", "structural_months"]

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const verdict = (text, pattern) => (text === "allowed" ? "allowed" : pattern.test(text) ? "refused" : text)
const dollars = (cents) => (cents === "" || cents === undefined ? "" : (cents / 100).toFixed(2))
const sha256 = (text) => createHash("sha256").update(text).digest("hex")

function sqlRefusal(kit, statement) {
  try { kit.sql(statement); return "allowed" } catch (error) { return /ERROR:\s+([^\n]+)/.exec(error.message)?.[1].trim() ?? error.message }
}

/** A production builder with Cypress Landing, its members and a default warranty program. */
async function cutoverOrg(kit, name, { periods = [] } = {}) {
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const org = kit.organization({ name, productTier: "production", chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" })
  const { createAccountingPeriod } = app("books/period-close")
  for (const period of periods) {
    const bounds = monthBounds(period)
    await kit.as(org.owner, () => createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: bounds.year, fiscalPeriod: bounds.month }))
  }
  org.team = {
    sales: kit.addMember(org, "org_sales_agent"), design: kit.addMember(org, "org_design_studio_coordinator"),
    superintendent: kit.addMember(org, "org_superintendent"), warranty: kit.addMember(org, "org_warranty_manager"),
  }
  await kit.service(() => app("warranty-operations").ensureWarrantyDefaults(org.orgId))
  org.communityId = randomUUID()
  kit.sql(`insert into public.communities(id,org_id,name,time_zone) values(${kit.q(org.communityId)},${kit.q(org.orgId)},${kit.q(COMMUNITY)},'America/New_York')`)
  org.homes = {}
  return org
}

/** A home on its lot with its buyer and agreement, as Open WIP's house commit writes them. */
function importedHome(kit, org, { lot, buyer, saleCents, saleDate }, { divisionId = null } = {}) {
  const q = kit.q, ids = { projectId: randomUUID(), lotId: randomUUID(), contactId: randomUUID(), contractId: randomUUID() }
  kit.sql(`begin;
insert into public.contacts(id,org_id,full_name,email,contact_type,metadata) values(${q(ids.contactId)},${q(org.orgId)},${q(buyer)},${q(`${buyer.toLowerCase().replace(/[^a-z]/g, ".")}@acceptance.example.test`)},'client','{"imported_open_wip":true}');
insert into public.projects(id,org_id,name,status,property_type,client_id,created_by,division_id,metadata) values(${q(ids.projectId)},${q(org.orgId)},${q(`${COMMUNITY} — Lot ${lot}`)},'active','production',${q(ids.contactId)},${q(org.owner.userId)},${divisionId ? q(divisionId) : "null"},${q(JSON.stringify({ wip_cutover: { as_of_date: "2026-10-01" }, imported_open_wip: true }))}::jsonb);
insert into public.lots(id,org_id,community_id,lot_number,status,project_id) values(${q(ids.lotId)},${q(org.orgId)},${q(org.communityId)},${q(lot)},'started',${q(ids.projectId)});
insert into public.contracts(id,org_id,project_id,number,title,status,signed_at,contract_type,total_cents,currency,effective_date,snapshot) values(${q(ids.contractId)},${q(org.orgId)},${q(ids.projectId)},${q(`WIP-CYP-${lot}`)},${q(`Imported purchase agreement — Lot ${lot}`)},'active',${q(`${saleDate}T00:00:00Z`)},'purchase_agreement',${saleCents},'usd',${q(saleDate)},'{"imported_open_wip":true,"as_of_date":"2026-10-01","agreement_total_only":true}'::jsonb);
commit;`)
  org.homes[lot] = ids
  return ids
}

/** A PDF uploaded through Documents to acceptance storage, so the server can read and hash its bytes. */
async function storedPdf(kit, org, projectId, name, bytes) {
  const file = await kit.as(org.owner, () => app("files").createFileFromUpload({ file: new File([bytes], name, { type: "application/pdf" }), projectId, category: "contracts" }))
  return { id: file.id, checksum: sha256(bytes) }
}

/** A PDF's file row whose checksum claims `bytes` but with no stored object behind it: what a forged direct upload leaves. */
function unreadablePdf(kit, org, projectId, name, bytes) {
  const id = randomUUID(), checksum = sha256(bytes)
  kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type,size_bytes,checksum,category,source,uploaded_by) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(name)},${kit.q(`${org.orgId}/${projectId}/documents/uploads/${id}.pdf`)},'application/pdf',${Buffer.byteLength(bytes)},${kit.q(checksum)},'contracts','upload',${kit.q(org.owner.userId)})`)
  return { id, checksum }
}

const imports = () => app("imports")
const stage = (kit, actor, importer, headers, rows, context) => kit.as(actor, () => imports().stageImportBatch({ importer, csvText: seed.csv(headers, rows), sourceFilename: `${importer}.csv`, context }, { expectedImporter: importer }))
const commit = (kit, actor, importer, batchId) => kit.as(actor, () => imports().commitImportBatch(batchId, { expectedImporter: importer }))
const skipRow = (kit, actor, importer, batchId, rowNumber) => {
  const rowId = kit.rows(`select id from public.import_rows where batch_id=${kit.q(batchId)} and row_number=${rowNumber}`)[0].id
  return kit.as(actor, () => imports().patchImportRow({ batchId, rowId, patch: {}, skip: true }, { expectedImporter: importer }))
}
const issues = (kit, batchId) => kit.rows(`select row_number, status, issues from public.import_rows where batch_id=${kit.q(batchId)} order by row_number`)
  .map((row) => [row.row_number, row.status, row.issues.map((issue) => issue.code).sort()])
const agreementRow = (lot, over = {}) => ({ community: COMMUNITY, lot_number: lot, block: "", signed_date: "", sale_price_cents: "", deposit_cents: "", signers: "", executed_file: "", executed_sha256: "", ...over })
const evidenceOf = (kit, contractId) => {
  const row = kit.rows(`select e.status, e.file_sha256, e.signers, e.signed_on::text signed_on, e.source_deposit_cents, e.review_reason, (e.reviewed_by is not null) reviewed, (e.file_sha256_verified_at is not null) verified,
      d.status document_status, d.document_type, d.source_entity_type, (d.executed_file_id = e.file_id) document_binds_file, (d.source_entity_id = e.contract_id) document_binds_agreement
    from public.imported_agreement_evidence e left join public.documents d on d.id=e.document_id where e.contract_id=${kit.q(contractId)}`)[0]
  return { ...row, source_deposit_cents: row.source_deposit_cents === null ? null : Number(row.source_deposit_cents) }
}
const executed = (kit, org, projectId) => kit.as(org.owner, () => app("community-sales").hasExecutedPurchaseAgreement(projectId))

async function agreementWithExecutedFileIsBoundAndImmutable(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 executed agreements")
  const [first, second] = inputs.homes.map((home) => importedHome(kit, org, home))
  const before = { firstExecuted: await executed(kit, org, first.projectId), status: evidenceOf(kit, first.contractId).status }
  const good = await storedPdf(kit, org, first.projectId, inputs.file.name, inputs.file.bytes)
  // The second home's PDF is in Documents under the name the row gives, but its bytes differ from the hash the source recorded.
  const rescan = await storedPdf(kit, org, second.projectId, inputs.wrongHash.name, inputs.wrongHash.bytesOnFile)
  const rows = [
    agreementRow(inputs.homes[0].lot, { signed_date: inputs.homes[0].saleDate, sale_price_cents: dollars(inputs.homes[0].saleCents), deposit_cents: dollars(inputs.depositCents), signers: inputs.signers, executed_file: inputs.file.name, executed_sha256: good.checksum.toUpperCase() }),
    agreementRow(inputs.homes[1].lot, { signers: inputs.signers, executed_file: inputs.wrongHash.name, executed_sha256: sha256(inputs.wrongHash.bytesRecorded) }),
  ]
  const batch = await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, rows)
  const staged = issues(kit, batch.id)
  const refusedWithError = verdict(await refusal(() => commit(kit, org.owner, "agreements", batch.id)), /fixed or explicitly skipped/)
  await skipRow(kit, org.owner, "agreements", batch.id, 2)
  const committed = await commit(kit, org.owner, "agreements", batch.id)
  const evidence = evidenceOf(kit, first.contractId)
  // A reviewer attaches the rescan the second home actually has; the server hashes its bytes.
  const review = app("cutover/agreements")
  const secondEvidenceId = kit.rows(`select id from public.imported_agreement_evidence where contract_id=${kit.q(second.contractId)}`)[0].id
  await kit.as(org.owner, () => review.attachExecutedAgreement({ evidenceId: secondEvidenceId, fileId: rescan.id, signers: inputs.attachSigners, signedOn: inputs.homes[1].saleDate }))
  const attached = evidenceOf(kit, second.contractId)
  const q = kit.q
  const immutability = {
    changeHash: sqlRefusal(kit, `update public.imported_agreement_evidence set file_sha256=${q(sha256("forged"))} where contract_id=${q(first.contractId)}`),
    reopen: sqlRefusal(kit, `update public.imported_agreement_evidence set status='evidence_missing' where contract_id=${q(first.contractId)}`),
    delete: sqlRefusal(kit, `delete from public.imported_agreement_evidence where contract_id=${q(first.contractId)}`),
    memberWrite: sqlRefusal(kit, `${asMember(org.owner)} update public.imported_agreement_evidence set review_reason='member edit of the record' where contract_id=${q(first.contractId)}`),
  }
  const again = await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, [rows[0]])
  const againIssues = issues(kit, again.id)
  const againCommit = await commit(kit, org.owner, "agreements", again.id)
  check.equal("the executed copy is bound by the SHA-256 of its stored bytes with its signers and date, never changes, and a re-import matches it", expected, {
    before, staged, refusedWithError, actions: committed.report.actions,
    evidence: { ...evidence, file_sha256_matches_upload: evidence.file_sha256 === good.checksum, file_sha256: undefined },
    attached: { status: attached.status, verified: attached.verified, file_sha256_matches_stored_bytes: attached.file_sha256 === rescan.checksum, signers: attached.signers, reviewed: attached.reviewed, document_binds_file: attached.document_binds_file },
    firstExecuted: await executed(kit, org, first.projectId),
    immutability: Object.fromEntries(Object.entries(immutability).map(([key, value]) => [key, /immutable|cannot be deleted|permission denied/.test(value) ? "refused" : value])),
    reimport: { issues: againIssues, actions: againCommit.report.actions },
    documents: Number(kit.rows(`select count(*) n from public.documents where project_id=${q(first.projectId)} and metadata->>'imported_agreement'='true'`)[0].n),
  })
  return { orgId: org.orgId }
}

async function executedCopyHashIsVerifiedFromStoredBytes(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 verified hash")
  const home = importedHome(kit, org, inputs.home)
  // The row's checksum claims these bytes; nothing is stored behind it.
  const claimed = unreadablePdf(kit, org, home.projectId, inputs.file.name, inputs.file.claimedBytes)
  const batch = await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, [agreementRow(inputs.home.lot, { signers: inputs.signers, executed_file: inputs.file.name, executed_sha256: claimed.checksum })])
  const staged = issues(kit, batch.id)
  const unread = /could not be read from storage to verify its SHA-256/
  const importBind = verdict(await refusal(() => commit(kit, org.owner, "agreements", batch.id)), unread)
  const evidenceId = kit.rows(`select id from public.imported_agreement_evidence where contract_id=${kit.q(home.contractId)}`)[0].id
  const review = app("cutover/agreements")
  const reviewBind = verdict(await refusal(() => kit.as(org.owner, () => review.attachExecutedAgreement({ evidenceId, fileId: claimed.id, signers: [{ name: inputs.home.buyer, email: null }], signedOn: inputs.home.saleDate }))), unread)
  // Below the service: a signed document on the agreement, then the evidence written directly.
  const q = kit.q, documentId = randomUUID()
  kit.sql(`insert into public.documents(id,org_id,project_id,document_type,title,status,source_file_id,executed_file_id,source_entity_type,source_entity_id,created_by) values(${q(documentId)},${q(org.orgId)},${q(home.projectId)},'contract','Executed purchase agreement','signed',${q(claimed.id)},${q(claimed.id)},'contract',${q(home.contractId)},${q(org.owner.userId)})`)
  const bind = (hash, verified) => sqlRefusal(kit, `update public.imported_agreement_evidence set status='executed_file', document_id=${q(documentId)}, file_id=${q(claimed.id)}, file_sha256=${q(hash)}, file_sha256_verified_at=${verified ? "now()" : "null"}, signers=${q(JSON.stringify([{ name: inputs.home.buyer, email: null }]))}::jsonb, signed_on=${q(inputs.home.saleDate)} where id=${q(evidenceId)}`)
  const database = { browserChecksumOnly: bind(claimed.checksum, false), checksumDisagreesWithBytes: bind(sha256(inputs.file.storedBytes), true) }
  check.equal("an executed copy is bound only by the hash the server computes from its stored bytes, never by the checksum its file row carries", expected, {
    staged, importBind, reviewBind,
    evidence: evidenceOf(kit, home.contractId).status,
    executed: await executed(kit, org, home.projectId),
    importedDocuments: Number(kit.rows(`select count(*) n from public.documents where project_id=${q(home.projectId)} and metadata->>'imported_agreement'='true'`)[0].n),
    database: {
      browserChecksumOnly: /computed from its stored bytes/.test(database.browserChecksumOnly) ? "refused: no server-verified hash" : database.browserChecksumOnly,
      checksumDisagreesWithBytes: /recorded checksum must match its bytes/.test(database.checksumDisagreesWithBytes) ? "refused: recorded checksum disagrees" : database.checksumDisagreesWithBytes,
    },
  })
  return { orgId: org.orgId }
}

async function agreementWithoutFileBlocksClosingUntilReviewed(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 agreement review")
  const [accepted, waiting] = inputs.homes.map((home) => importedHome(kit, org, home))
  const batch = await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, inputs.homes.map((home) => agreementRow(home.lot, { deposit_cents: dollars(home.depositCents) })))
  const staged = issues(kit, batch.id)
  const committed = await commit(kit, org.owner, "agreements", batch.id)
  const closingId = randomUUID()
  kit.sql(`insert into public.closings(id,org_id,project_id,lot_id,community_id,status,buyer_contact_id) values(${kit.q(closingId)},${kit.q(org.orgId)},${kit.q(accepted.projectId)},${kit.q(accepted.lotId)},${kit.q(org.communityId)},'projected',${kit.q(accepted.contactId)})`)
  const closings = app("closings")
  await kit.as(org.owner, () => closings.scheduleClosing({ closingId, scheduledDate: inputs.closingDate }))
  const gate = kit.rows(`select id from public.closing_checklist_items where closing_id=${kit.q(closingId)} and key='agreement_executed'`)[0].id
  const complete = () => kit.as(org.owner, () => closings.updateClosingChecklistItem({ itemId: gate, status: "complete" }))
  const blocked = {
    executed: await executed(kit, org, accepted.projectId),
    complete: verdict(await refusal(complete), /no executed copy on file/),
    waive: verdict(await refusal(() => kit.as(org.owner, () => closings.updateClosingChecklistItem({ itemId: gate, status: "waived", notes: "Buyer signed on paper at the sales office" }))), /no executed copy on file/),
  }
  const review = app("cutover/agreements")
  const queue = await kit.as(org.owner, () => review.listAgreementEvidenceQueue())
  const evidenceId = (contractId) => kit.rows(`select id from public.imported_agreement_evidence where contract_id=${kit.q(contractId)}`)[0].id
  const refusals = {
    salesAgent: verdict(await refusal(() => kit.as(org.team.sales, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(accepted.contractId), reason: inputs.reason }))), /^Missing permission: closing\.manage$/),
    shortReason: verdict(await refusal(() => kit.as(org.owner, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(accepted.contractId), reason: "ok" }))), /at least 10 characters/),
  }
  await kit.as(org.owner, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(accepted.contractId), reason: inputs.reason }))
  const afterAccept = { executed: await executed(kit, org, accepted.projectId), complete: verdict(await refusal(complete), /no executed copy on file/) }
  const reviewedAgain = verdict(await refusal(() => kit.as(org.owner, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(accepted.contractId), reason: inputs.reason }))), /already been reviewed/)
  const strip = (row) => ({ status: row.status, signers: row.signers, signed_on: row.signed_on, source_deposit_cents: row.source_deposit_cents, review_reason: row.review_reason, reviewed: row.reviewed, document_status: row.document_status })
  check.equal("an agreement without its executed copy blocks the closing gate until a reviewer accepts it with a reason", expected, {
    staged, actions: committed.report.actions, blocked,
    queue: { total: queue.total, homes: queue.items.map((item) => item.home).sort(), deposits: queue.items.map((item) => item.sourceDepositCents).sort((a, b) => a - b) },
    refusals, afterAccept,
    acceptedEvidence: strip(evidenceOf(kit, accepted.contractId)), waitingEvidence: strip(evidenceOf(kit, waiting.contractId)), reviewedAgain,
    queueAfter: (await kit.as(org.owner, () => review.listAgreementEvidenceQueue())).items.map((item) => item.home),
  })
  return { orgId: org.orgId }
}

async function agreementEvidenceAndHistoryStayInTheReviewersDivisions(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 division scope")
  const divisions = {}
  for (const division of inputs.divisions) divisions[division.name] = (await kit.as(org.owner, () => app("divisions").createDivision(division))).id
  const homes = inputs.homes.map((home) => importedHome(kit, org, home, { divisionId: divisions[home.division] }))
  await commit(kit, org.owner, "agreements", (await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, inputs.homes.map((home) => agreementRow(home.lot)))).id)
  const history = inputs.homes.map((home) => ({ community: COMMUNITY, block: "", lot_number: home.lot, inspection_type: "Foundation", inspected_on: inputs.inspectedOn, result: "pass", inspector: "", reference: "" }))
  await commit(kit, org.owner, "inspection_history", (await stage(kit, org.owner, "inspection_history", INSPECTION_HEADERS, history)).id)
  // A bookkeeper (closing.manage) and a superintendent (inspection.write), each assigned to one division only.
  const limited = (role) => {
    const actor = kit.addMember(org, role)
    kit.sql(`update public.memberships set division_scope='assigned' where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};
insert into public.membership_divisions(membership_id, division_id) select id, ${kit.q(divisions[inputs.reviewerDivision])} from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)};`)
    return actor
  }
  const reviewer = limited("org_bookkeeper"), superintendent = limited("org_superintendent")
  const review = app("cutover/agreements")
  const evidenceId = (home) => kit.rows(`select id from public.imported_agreement_evidence where contract_id=${kit.q(home.contractId)}`)[0].id
  const [outside, inside] = inputs.homes[0].division === inputs.reviewerDivision ? [homes[1], homes[0]] : [homes[0], homes[1]]
  const queue = await kit.as(reviewer, () => review.listAgreementEvidenceQueue())
  const outsideAccept = await refusal(() => kit.as(reviewer, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(outside), reason: inputs.reason })))
  const insideAccept = await refusal(() => kit.as(reviewer, () => review.acceptAgreementWithoutExecutedCopy({ evidenceId: evidenceId(inside), reason: inputs.reason })))
  const reads = (actor) => ({
    evidence: memberCount(kit, actor, `select count(*) from public.imported_agreement_evidence where org_id=${kit.q(org.orgId)}`),
    history: memberCount(kit, actor, `select count(*) from public.imported_inspection_records where org_id=${kit.q(org.orgId)}`),
  })
  const reconcile = (actor) => kit.as(actor, () => app("cutover/reconciliation").getCutoverReconciliation())
  const [report, fieldReport] = [await reconcile(reviewer), await reconcile(superintendent)]
  check.equal("members limited to one division see, review and read only that division's imported agreements and inspection history", expected, {
    queue: queue.items.map((item) => item.home),
    outsideAccept: outsideAccept.replace(/^Missing permission: /, "refused: missing "), insideAccept,
    statuses: Object.fromEntries(inputs.homes.map((home, index) => [home.lot, evidenceOf(kit, homes[index].contractId).status])),
    reads: { reviewer: reads(reviewer), superintendent: reads(superintendent), owner: reads(org.owner) },
    reconciliation: { imported: report.agreements.imported, accepted: report.agreements.accepted, evidenceMissing: report.agreements.evidenceMissing, unlinkedOpeningDeposits: report.agreements.unlinkedOpeningDeposits, inspectionHomes: fieldReport.inspections.homes },
  })
  return { orgId: org.orgId }
}

async function depositsLinkAndReconcilePerHome(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 deposits", { periods: ["2026-09", "2026-10"] })
  const homes = inputs.homes.map((home) => importedHome(kit, org, home))
  const gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
  const deposit = (home, index, cents, projectId) => ({ accountCode: "2300", subledgerType: "deposit", description: `Earnest money ${home.lot}`, debitCents: 0, creditCents: cents, ...(projectId ? { projectId } : {}),
    details: { customer_id: org.homes[home.lot] ? org.homes[home.lot].contactId : homes[0].contactId, document_number: `DEP-${home.lot}-${index}`, document_date: inputs.depositDate } })
  const lines = []
  inputs.homes.forEach((home, h) => home.arcDeposits.forEach((cents, index) => lines.push(deposit(home, index, cents, homes[h].projectId))))
  lines.push(deposit({ lot: "X" }, 0, inputs.unlinkedDepositCents, null))
  const total = lines.reduce((sum, line) => sum + line.creditCents, 0)
  lines.push({ accountCode: "1000", subledgerType: "bank", description: "Deposits held in operating", debitCents: total, creditCents: 0, details: { existing_entity_id: (await kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Operating", accountType: "depository", glAccountId: gl("1000") }))).bankAccountId } })
  const openings = app("books/opening-balances")
  const batch = await kit.as(org.owner, () => openings.createOpeningBalanceBatch({ cutoverDate: "2026-09-30", sourceFilename: "deposits-2026-09-30.json", sourceContent: JSON.stringify(lines), lines }))
  await kit.as(org.owner, () => openings.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "owner" }))
  await kit.as(org.reviewer, () => openings.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "accountant" }))
  await kit.as(org.owner, () => openings.postOpeningBalanceBatch(batch.batchId))
  const agreements = await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, inputs.homes.map((home) => agreementRow(home.lot, { deposit_cents: dollars(home.statedDepositCents) })))
  await commit(kit, org.owner, "agreements", agreements.id)
  const report = await kit.as(org.owner, () => app("cutover/reconciliation").getCutoverReconciliation())
  const section = report.agreements
  check.equal("each home's opening deposits reconcile to the agreements file; the home that differs and the deposit with no home are reported", expected, {
    depositsByHome: Object.fromEntries(kit.rows(`select l.lot_number, coalesce(sum(i.total_cents - i.balance_due_cents),0)::bigint n from public.lots l left join public.invoices i on i.project_id=l.project_id and i.metadata->>'invoice_kind'='earnest_deposit' where l.org_id=${kit.q(org.orgId)} group by 1 order by 1`).map((row) => [row.lot_number, Number(row.n)])),
    reconciliation: { homes: section.homes, matched: section.matched, sourceTotals: section.sourceTotals, arcTotals: section.arcTotals, unlinkedOpeningDeposits: section.unlinkedOpeningDeposits,
      mismatches: section.mismatches.map((item) => [item.home.replace(/^.*Lot /, ""), item.source.deposits_cents, item.arc.deposits_cents]) },
  })
  return { orgId: org.orgId }
}

/** The community's option catalog, one option repriced since, and its one design-studio selection group. */
function seedCatalog(kit, org, inputs) {
  const q = kit.q, group = randomUUID()
  const statements = ["begin;", `insert into public.selection_groups(id,org_id,community_id,name,schedule_task_key,sort_order) values(${q(group)},${q(org.orgId)},${q(org.communityId)},${q(inputs.group)},'drywall',1);`]
  org.options = {}
  for (const option of inputs.options) {
    const category = randomUUID(), id = randomUUID()
    org.options[option.sku] = { id, category }
    statements.push(`insert into public.selection_categories(id,org_id,name) values(${q(category)},${q(org.orgId)},${q(option.category)});`,
      `insert into public.selection_group_categories(org_id,group_id,category_id) values(${q(org.orgId)},${q(group)},${q(category)});`,
      `insert into public.selection_options(id,org_id,category_id,name,sku,price_cents,cost_cents,option_scope,is_available) values(${q(id)},${q(org.orgId)},${q(category)},${q(option.name)},${q(option.sku)},${option.priceCents},${option.costCents},'design_studio',true);`)
  }
  // A price rise after a buyer chose the option is the catalog's next revision; the buyer keeps the price they were given.
  for (const option of inputs.options) if (option.repricedCents) statements.push(`update public.selection_options set price_cents=${option.repricedCents} where id=${q(org.options[option.sku].id)};`)
  statements.push("commit;")
  kit.sql(statements.join("\n"))
}

async function selectionsCutoffsAndBalancesReconcile(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 selections")
  seedCatalog(kit, org, inputs)
  const homes = inputs.homes.map((home) => importedHome(kit, org, home))
  const selectionRows = [
    ...inputs.selections.map((row) => ({ community: COMMUNITY, block: "", lot_number: row.lot, option_code: row.sku, price_cents: dollars(row.priceCents), price_version: row.priceVersion, selected_on: row.selectedOn, status: row.status ?? "" })),
    { community: COMMUNITY, block: "", lot_number: inputs.homes[0].lot, option_code: "NOPE-1", price_cents: "10.00", price_version: "", selected_on: "2026-08-01", status: "" },
  ]
  const selections = await stage(kit, org.team.design, "selections", SELECTION_HEADERS, selectionRows, { file_kind: "selections" })
  const selectionIssues = issues(kit, selections.id)
  await skipRow(kit, org.team.design, "selections", selections.id, selectionRows.length)
  const selectionsCommitted = await commit(kit, org.team.design, "selections", selections.id)
  const cutoffs = await stage(kit, org.team.design, "selections", CUTOFF_HEADERS, inputs.cutoffs.map((row) => ({ community: COMMUNITY, block: "", lot_number: row.lot, group: inputs.group, cutoff_date: row.date, locked: row.locked ? "yes" : "no" })), { file_kind: "cutoffs" })
  await commit(kit, org.team.design, "selections", cutoffs.id)
  const totalsCsv = inputs.totals.map((row) => ({ community: COMMUNITY, block: "", lot_number: row.lot, selection_count: String(row.count), selections_total_cents: dollars(row.totalCents), change_order_balance_cents: dollars(row.balanceCents) }))
  // The design coordinator may record selections but not amend an agreement's price.
  const designTotals = await stage(kit, org.team.design, "selections", TOTAL_HEADERS, totalsCsv, { file_kind: "totals" })
  const designAmends = verdict(await refusal(() => commit(kit, org.team.design, "selections", designTotals.id)), /^Missing permission: sales\.manage$/)
  const totals = await stage(kit, org.owner, "selections", TOTAL_HEADERS, totalsCsv, { file_kind: "totals" })
  await commit(kit, org.owner, "selections", totals.id)
  const again = await stage(kit, org.team.design, "selections", SELECTION_HEADERS, selectionRows.slice(0, -1), { file_kind: "selections" })
  const againCommit = await commit(kit, org.team.design, "selections", again.id)
  const q = kit.q
  const report = await kit.as(org.owner, () => app("cutover/reconciliation").getCutoverReconciliation())
  check.equal("selections keep the buyer's price and its sheet, cutoffs land as imported overrides, the balance amends the agreement once and totals reconcile per home", expected, {
    selectionIssues, selectionActions: selectionsCommitted.report.actions,
    selections: kit.rows(`select l.lot_number lot, o.sku, s.status, s.price_cents_snapshot price, s.cost_cents_snapshot cost, s.selected_option_revision revision, s.selected_at::date::text selected_on, (s.locked_at is not null) locked, s.metadata->'imported_cutover'->>'price_version' price_version
      from public.project_selections s join public.lots l on l.project_id=s.project_id join public.selection_options o on o.id=s.selected_option_id where s.org_id=${q(org.orgId)} order by 1,2`),
    cutoffs: kit.rows(`select l.lot_number lot, g.cutoff_date::text cutoff, g.cutoff_source source, g.status from public.project_selection_groups g join public.lots l on l.project_id=g.project_id where g.org_id=${q(org.orgId)} order by 1`),
    designAmends,
    amendments: kit.rows(`select l.lot_number lot, v.kind, v.price_delta_cents::bigint delta, v.authorized_total_cents::bigint total from public.purchase_agreement_versions v join public.lots l on l.project_id=v.project_id where v.org_id=${q(org.orgId)} order by 1, v.version_number`).map((row) => ({ ...row, delta: Number(row.delta), total: Number(row.total) })),
    reimport: againCommit.report.actions,
    reconciliation: { homes: report.selections.homes, matched: report.selections.matched, sourceTotals: report.selections.sourceTotals, arcTotals: report.selections.arcTotals,
      mismatches: report.selections.mismatches.map((item) => [item.home.replace(/^.*Lot /, ""), item.differences]) },
    homes: homes.length,
  })
  return { orgId: org.orgId }
}

async function concurrentBalanceImportsAmendOnce(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 concurrent balances")
  const home = importedHome(kit, org, inputs.home)
  const row = { community: COMMUNITY, block: "", lot_number: inputs.home.lot, selection_count: "0", selections_total_cents: "0.00", change_order_balance_cents: dollars(inputs.balanceCents) }
  const first = await stage(kit, org.owner, "selections", TOTAL_HEADERS, [row], { file_kind: "totals" })
  const second = await stage(kit, org.owner, "selections", TOTAL_HEADERS, [row], { file_kind: "totals" })
  // Two commits started in one tick are two API sessions racing for the same home's balance.
  const outcomes = await Promise.all([first, second].map((batch) => commit(kit, org.owner, "selections", batch.id).then((result) => result.report.actions, (error) => error.message)))
  const q = kit.q
  const duplicate = sqlRefusal(kit, `insert into public.change_orders(org_id,project_id,contract_id,title,status,total_cents,currency,metadata) values(${q(org.orgId)},${q(home.projectId)},${q(home.contractId)},'Second imported balance','draft',100,'usd','{"imported_cutover_balance":{}}'::jsonb)`)
  check.equal("two batches committing one home's change-order balance at once amend its agreement once", expected, {
    outcomes: outcomes.map((outcome) => JSON.stringify(outcome)).sort(),
    balances: Number(kit.rows(`select count(*) n from public.change_orders where project_id=${q(home.projectId)} and metadata ? 'imported_cutover_balance'`)[0].n),
    agreement: kit.rows(`select kind, price_delta_cents::bigint delta, authorized_total_cents::bigint total from public.purchase_agreement_versions where project_id=${q(home.projectId)} order by version_number`).map((version) => ({ kind: version.kind, delta: Number(version.delta), total: Number(version.total) })),
    duplicate: /change_orders_one_imported_cutover_balance/.test(duplicate) ? "refused: one imported balance per home" : duplicate,
  })
  return { orgId: org.orgId }
}

async function inspectionHistoryIsReadOnlyAndTheLifecycleStaysTheOnlyPath(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 inspection history")
  const home = importedHome(kit, org, inputs.home)
  const rows = [...inputs.history, inputs.future].map((row) => ({ community: COMMUNITY, block: "", lot_number: inputs.home.lot, inspection_type: row.type, inspected_on: row.on, result: row.result, inspector: row.inspector ?? "", reference: row.reference ?? "" }))
  const sup = org.team.superintendent
  const batch = await stage(kit, sup, "inspection_history", INSPECTION_HEADERS, rows)
  const staged = issues(kit, batch.id)
  await skipRow(kit, sup, "inspection_history", batch.id, rows.length)
  const committed = await commit(kit, sup, "inspection_history", batch.id)
  const q = kit.q
  const immutability = {
    edit: sqlRefusal(kit, `update public.imported_inspection_records set result='pass' where project_id=${q(home.projectId)} and result='fail'`),
    delete: sqlRefusal(kit, `delete from public.imported_inspection_records where project_id=${q(home.projectId)}`),
    memberInsert: sqlRefusal(kit, `${asMember(sup)} insert into public.imported_inspection_records(org_id,project_id,inspection_type,inspected_on,result,source_batch_id,source_row_id) values(${q(org.orgId)},${q(home.projectId)},'Final','2026-09-01','pass',${q(batch.id)},${q(randomUUID())})`),
  }
  const lifecycleRows = () => ({
    inspections: Number(kit.rows(`select count(*) n from public.inspections where project_id=${q(home.projectId)}`)[0].n),
    obligations: Number(kit.rows(`select count(*) n from public.inspection_obligations where project_id=${q(home.projectId)}`)[0].n),
  })
  const afterImport = lifecycleRows()
  // A new inspection starts in the lifecycle; a completed one cannot be written past it.
  const inspections = app("inspections")
  const template = await kit.as(sup, () => inspections.createChecklistTemplate({ name: "Framing re-check", kind: "quality", items: [{ section: "Structure", prompt: "Headers per plan", response_type: "pass_fail" }] }))
  const created = await kit.as(sup, () => inspections.createInspection({ project_id: home.projectId, template_id: template.id, kind: "quality", title: "Framing re-inspection" }))
  const forgedCompletion = sqlRefusal(kit, `insert into public.inspections(org_id,project_id,inspection_number,kind,title,status,result) values(${q(org.orgId)},${q(home.projectId)},99,'quality','Framing (from the old system)','completed','pass')`)
  const again = await stage(kit, sup, "inspection_history", INSPECTION_HEADERS, rows.slice(0, -1))
  const againCommit = await commit(kit, sup, "inspection_history", again.id)
  const report = await kit.as(sup, () => app("cutover/reconciliation").getCutoverReconciliation())
  check.equal("past inspections land as read-only history beside the lifecycle, which stays the only way an inspection is made", expected, {
    staged, actions: committed.report.actions,
    history: kit.rows(`select inspection_type type, inspected_on::text "on", result, inspector from public.imported_inspection_records where project_id=${q(home.projectId)} order by inspected_on, inspection_type, result`),
    immutability: Object.fromEntries(Object.entries(immutability).map(([key, value]) => [key, /read-only record|permission denied/.test(value) ? "refused" : value])),
    afterImport, newInspection: { status: created.status, number: created.inspection_number ?? null }, forgedCompletion: /atomic receipt/.test(forgedCompletion) ? "refused" : forgedCompletion,
    afterNewInspection: lifecycleRows(), reimport: againCommit.report.actions,
    reconciliation: { homes: report.inspections.homes, matched: report.inspections.matched, sourceTotals: report.inspections.sourceTotals, arcTotals: report.inspections.arcTotals },
  })
  return { orgId: org.orgId }
}

async function eachImportTakesItsOwnersPermission(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await cutoverOrg(kit, "CUTOVER-01 permissions")
  importedHome(kit, org, inputs.home)
  const lot = inputs.home.lot
  const attempts = {
    agreementsBySales: [org.team.sales, "agreements", AGREEMENT_HEADERS, [agreementRow(lot)], undefined],
    agreementsByWarranty: [org.team.warranty, "agreements", AGREEMENT_HEADERS, [agreementRow(lot)], undefined],
    selectionsBySuperintendent: [org.team.superintendent, "selections", TOTAL_HEADERS, [{ community: COMMUNITY, block: "", lot_number: lot, selection_count: "0", selections_total_cents: "0", change_order_balance_cents: "0" }], { file_kind: "totals" }],
    inspectionsByDesign: [org.team.design, "inspection_history", INSPECTION_HEADERS, [{ community: COMMUNITY, block: "", lot_number: lot, inspection_type: "Framing", inspected_on: "2026-09-01", result: "pass", inspector: "", reference: "" }], undefined],
    inspectionsBySales: [org.team.sales, "inspection_history", INSPECTION_HEADERS, [{ community: COMMUNITY, block: "", lot_number: lot, inspection_type: "Framing", inspected_on: "2026-09-01", result: "pass", inspector: "", reference: "" }], undefined],
  }
  const refused = {}
  for (const [key, [actor, importer, headers, rows, context]] of Object.entries(attempts)) {
    const message = await refusal(() => stage(kit, actor, importer, headers, rows, context))
    refused[key] = /^Missing permission: /.test(message) ? message.slice("Missing permission: ".length) : message
  }
  const allowed = {
    agreementsByOwner: (await stage(kit, org.owner, "agreements", AGREEMENT_HEADERS, [agreementRow(lot)])).status,
    inspectionsBySuperintendent: (await stage(kit, org.team.superintendent, "inspection_history", INSPECTION_HEADERS, attempts.inspectionsByDesign[3])).status,
    selectionsByDesign: (await stage(kit, org.team.design, "selections", TOTAL_HEADERS, attempts.selectionsBySuperintendent[3], { file_kind: "totals" })).status,
  }
  // The installed base the warranty manager imports appears in the cutover reconciliation.
  const warrantyRows = inputs.warrantyHomes.map((home) => ({ community: COMMUNITY, lot_number: home.lot, block: "", address: `${home.lot} Cypress Way`, buyer_name: home.buyer, buyer_email: "", closing_date: home.closed, program: "", workmanship_months: "12", systems_months: "24", structural_months: "120" }))
  const warranty = await stage(kit, org.team.warranty, "warranty_homes", WARRANTY_HEADERS, warrantyRows)
  await commit(kit, org.team.warranty, "warranty_homes", warranty.id)
  const sections = async (actor) => {
    const report = await kit.as(actor, () => app("cutover/reconciliation").getCutoverReconciliation())
    return Object.fromEntries(Object.entries(report).map(([key, value]) => [key, value !== null]))
  }
  const ownerReport = await kit.as(org.owner, () => app("cutover/reconciliation").getCutoverReconciliation())
  check.equal("each importer takes its owners' permission, and the reconciliation shows each viewer only its sections, the warranty installed base among them", expected, {
    refused, allowed,
    sections: { owner: await sections(org.owner), sales: await sections(org.team.sales), superintendent: await sections(org.team.superintendent), warranty: await sections(org.team.warranty) },
    warrantyInCutover: ownerReport.warranty,
  })
  return { orgId: org.orgId }
}

module.exports = {
  subcases: {
    "agreement-with-executed-file-is-bound-and-immutable": agreementWithExecutedFileIsBoundAndImmutable,
    "executed-copy-hash-is-verified-from-stored-bytes": executedCopyHashIsVerifiedFromStoredBytes,
    "agreement-without-file-blocks-closing-until-reviewed": agreementWithoutFileBlocksClosingUntilReviewed,
    "agreement-evidence-and-history-stay-in-the-reviewers-divisions": agreementEvidenceAndHistoryStayInTheReviewersDivisions,
    "deposits-link-and-reconcile-per-home": depositsLinkAndReconcilePerHome,
    "selections-cutoffs-and-balances-reconcile": selectionsCutoffsAndBalancesReconcile,
    "concurrent-balance-imports-amend-once": concurrentBalanceImportsAmendOnce,
    "inspection-history-is-read-only-and-the-lifecycle-stays-the-only-path": inspectionHistoryIsReadOnlyAndTheLifecycleStaysTheOnlyPath,
    "each-import-takes-its-owners-permission": eachImportTakesItsOwnersPermission,
  },
}
