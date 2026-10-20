// TRADE-NET-01 — builder on Arc, sub on Arc (TR06-01 .. TR06-03). A builder organization invites the seeded
// electrical company's owner to two of its jobs through the sub portal (the builder's own access-token service);
// the owner claims both with the invited, verified email, sees them under Builder connections, links the first to
// a new trade job (the builder becomes the customer) and the second to an existing job, and from then on the
// sub's invoices submitted in the builder's portal are receivables on the trade's billing book, one per invoice,
// following the builder's approval, partial and final payments and rejection; the builder pausing the portal
// access pauses the link; nobody on the trade side can edit a mirrored invoice. The plan says "pay app"; the sub
// portal takes invoices only, so the scenario covers invoices.
//
// The outbox worker is the product's process-outbox handler (kit.drainOutbox) running the
// sync_connected_receivable jobs that the vendor_bills trigger queued in the trade organization; the sync
// service is also called directly to prove a rerun changes nothing.
//
//   builder-invites-the-owner-who-claims-it            the invitations, the claim, the verified identity, Builder connections; company membership alone grants nothing
//   linking-creates-a-job-with-the-builder-as-customer create mode: the job, its terms, the builder as customer, the connection; once only
//   builder-connections-lists-the-linked-jobs          DEFECT_OPEN: the list of linked jobs for the owner's invitations fails to load (ambiguous embed)
//   linking-an-existing-job-keeps-its-terms            link mode: the job keeps its terms and takes the builder as its customer
//   sub-invoice-is-one-issued-receivable               the portal invoice mirrors as one issued invoice, never emailed; a rerun changes nothing
//   builder-approval-and-partial-payment-record-once   approval is mirrored; a partial payment is recorded once, however often the sync reruns
//   builder-final-payment-closes-the-receivable        the balance paid closes it with each payment once
//   rejected-bills-void-or-never-mirror                a rejected mirror is voided; a bill rejected before it mirrored never appears
//   mirrored-invoices-refuse-user-edits                every user-driven change to a mirror is refused with the builder's name
//   pausing-the-builder-access-pauses-the-link         pause, resume and revoke follow the builder's access, revoke is terminal
//   resuming-a-link-catches-up-on-the-builders-changes DEFECT_OPEN: a resumed link does not reconcile what the builder did while it was paused
//   mirror-equals-the-bill-on-a-job-that-holds-retainage  DEFECT_OPEN: a link-created job's retainage changes the mirror's total, and the next sync voids it and cannot reissue
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")
const { asTrade, claimInvitation, builderOrg, addBuilderJob, glId, installRequestScope } = require("./trade-network.cjs")

const A = (path) => require(`../../../${path}`)
const DAY = 86_400_000
const today = () => new Date().toISOString().slice(0, 10)
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 200)}` } }

const BUILDER = "TRADE-NET-01 builder"
const MARINA = { name: "Marina Way residence", address: "500 Marina Way, Stuart, FL 34994" }
const HARBOR = { name: "Harbor Avenue addition", address: "88 Harbor Avenue, Stuart, FL 34994" }

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, (async () => {
    installRequestScope()
    if (process.env.RESEND_API_KEY) throw Error("Acceptance scenarios never send email; unset RESEND_API_KEY")
    const t = await tradeCompany(kit)
    const owner = t.actors.owner
    const builder = await builderOrg(kit, { name: BUILDER, trade: { name: t.name, owner }, books: true, subcontractCents: 5_000_000 })
    const marina = { projectId: builder.projectId, commitmentId: builder.commitmentId, address: MARINA.address }
    const harbor = addBuilderJob(kit, builder, { name: HARBOR.name, address: HARBOR.address, subcontractCents: 3_000_000 })
    const portal = app("portal-access")
    const invite = (job) => kit.as(builder.owner, () => portal.createPortalAccessToken({ projectId: job.projectId, portalType: "sub", contactId: builder.contactId, companyId: builder.companyId }))
    marina.token = await invite(marina)
    harbor.token = await invite(harbor)
    return { t, owner, builder, marina, harbor, stages: {} }
  })())
  return WORLDS.get(kit)
}
const stage = (kit, name, build) => world(kit).then((w) => (w.stages[name] ??= build(w)))
const trade = (kit, w, work, actor = w.owner) => asTrade(kit, actor, work)
const workspace = (kit, w, actor) => trade(kit, w, () => A("lib/services/external-portal-auth").getTradeBuilderWorkspace(), actor)

const moneyBook = (kit, w, projectId) => kit.as(w.owner, () => A("lib/services/billing-book").getProjectBillingSummary(projectId))
const summaryOf = (summary) => ({ open: summary.bands.open, overdue: summary.bands.overdue, paid: summary.bands.paid, void: summary.bands.void, drafts: summary.bands.drafts, billedCents: summary.billedCents, collectedCents: summary.collectedCents, outstandingCents: summary.outstandingCents })

/** The sub's invoice as the builder's portal takes it. */
const submitBill = (kit, w, job, { number, cents, description }) =>
  A("lib/services/vendor-bills").createVendorBillFromPortal({
    input: { bill_number: number, total_cents: cents, bill_date: today(), due_date: day(30), description, commitment_id: job.commitmentId },
    orgId: w.builder.orgId, projectId: job.projectId, companyId: w.builder.companyId, portalTokenId: job.token.id,
  })

const billOf = (kit, number) => kit.rows(`select id, status, total_cents::int total, paid_cents::int paid from public.vendor_bills where bill_number=${kit.q(number)} and company_id is not null order by created_at desc limit 1`)[0]
const mirrors = (kit, w, projectId) => kit.rows(`select i.id, i.invoice_number number, i.status, i.total_cents::int total, i.balance_due_cents::int balance, i.metadata->'connected_receivable'->>'source_bill_id' bill,
    i.metadata->'connected_receivable'->>'source_status' source_status, (i.metadata->'connected_receivable'->>'source_paid_cents')::int source_paid, i.metadata->'connected_receivable'->>'void_reason' void_reason,
    i.metadata->>'delivery' delivery, i.delivery_status, i.client_visible, i.issued_snapshot is not null issued, i.title, i.metadata->'connected_receivable'->>'source_org_name' source_org
  from public.invoices i where i.org_id=${kit.q(w.t.orgId)} and i.project_id=${kit.q(projectId)} and i.metadata ? 'connected_receivable' order by i.created_at`)
const payments = (kit, w, invoiceId) => kit.rows(`select amount_cents::int cents, provider, provider_payment_id, method, status from public.payments where org_id=${kit.q(w.t.orgId)} and invoice_id=${kit.q(invoiceId)} order by created_at`)
const connection = (kit, id) => kit.rows(`select status, ended_reason, ended_at is not null ended, last_synced_at is not null synced from public.project_connections where id=${kit.q(id)}`)[0]
const syncNow = (w, connectionId, billId) => A("lib/services/connected-receivables").syncConnectedReceivable(w.t.orgId, { connection_id: connectionId, source_bill_id: billId })
const codedLines = (w, job, cents) => [{ cost_code_id: w.builder.costCodeId, description: "Electrical", amount_cents: cents, project_id: job.projectId }]

// ---------------------------------------------------------------------------
// 1. Invitations and the claim

const claimed = (kit) => stage(kit, "claimed", async (w) => {
  const before = await workspace(kit, w)
  const first = await claimInvitation(kit, w.owner, { tokenType: "portal", token: w.marina.token.token })
  const second = await claimInvitation(kit, w.owner, { tokenType: "portal", token: w.harbor.token.token })
  const owners = await workspace(kit, w)
  const office = await workspace(kit, w, w.t.actors.officeAdmin)
  const marinaItem = owners.items.find((item) => item.project_name === MARINA.name)
  const harborItem = owners.items.find((item) => item.project_name === HARBOR.name)
  w.marina.grantId = marinaItem.id
  w.harbor.grantId = harborItem.id
  const opened = await trade(kit, w, () => A("lib/services/external-portal-auth").openTradeBuilderConnection(marinaItem.id))
  return { before, first, second, owners, office, opened }
})

async function builderInvitesTheOwnerWhoClaimsIt(kit, spec, check) {
  const w = await world(kit)
  const s = await claimed(kit)
  const { q } = kit
  const tokens = kit.rows(`select p.name project, t.portal_type, t.purpose, c.email contact_email, co.name company, t.can_submit_invoices from public.portal_access_tokens t join public.projects p on p.id=t.project_id
    left join public.contacts c on c.id=t.contact_id left join public.companies co on co.id=t.company_id where t.org_id=${q(w.builder.orgId)} order by p.name`)
  const identity = kit.rows(`select email, status, email_verified_at is not null verified from public.external_identities where email=${q(w.owner.email.toLowerCase())}`)
  const grants = kit.rows(`select p.name project, g.status, g.org_id=${q(w.builder.orgId)} builders, g.portal_access_token_id=t.id on_the_invited_token from public.external_identity_grants g join public.portal_access_tokens t on t.id=g.portal_access_token_id join public.projects p on p.id=t.project_id
    where g.identity_id=(select id from public.external_identities where email=${q(w.owner.email.toLowerCase())}) order by p.name`)
  const observed = {
    builderSide: tokens.map((token) => ({ project: token.project, portal: token.portal_type, forPurpose: token.purpose, invitee: token.contact_email === w.owner.email, company: token.company, mayInvoice: token.can_submit_invoices })),
    beforeAnyClaim: s.before === null ? "no verified identity: no connections" : "connections listed",
    claims: { first: { created: s.first.created, forTheInvitedEmail: s.first.email === w.owner.email.toLowerCase() }, second: { created: s.second.created } },
    identity: identity.map((row) => ({ status: row.status, verified: row.verified })),
    grants: grants.map((row) => ({ project: row.project, status: row.status, inTheBuildersOrganization: row.builders, onTheInvitedToken: row.on_the_invited_token })),
    builderConnections: s.owners.items.map((item) => ({ kind: item.kind, builder: item.org_name, project: item.project_name, address: item.project_address, company: item.company_name })),
    anotherMemberWithADifferentEmail: s.office === null ? "no verified identity: no connections" : "connections listed",
    openingAConnection: { opensTheSubPortalLink: s.opened.href === `/s/${w.marina.token.token}` },
  }
  check.equal("the builder's two sub-portal invitations to the owner's email are claimed into one verified identity with a grant each, Builder connections lists both, and another member of the company (different email) sees none", spec.expected, observed)
  return { orgId: w.t.orgId, builderOrgId: w.builder.orgId }
}

// ---------------------------------------------------------------------------
// 2. Linking a project to a new job

const linkedNew = (kit) => stage(kit, "linkedNew", async (w) => {
  await claimed(kit)
  const links = A("lib/services/project-connections")
  const office = await attempt(() => trade(kit, w, () => links.linkBuilderProject({ mode: "create", grant_id: w.marina.grantId, property_type: "residential", billing_basis: "progress", total_contract_value_cents: 5_000_000 }), w.t.actors.officeAdmin))
  const result = await trade(kit, w, () => links.linkBuilderProject({ mode: "create", grant_id: w.marina.grantId, property_type: "residential", billing_basis: "progress", total_contract_value_cents: 5_000_000 }))
  const again = await attempt(() => trade(kit, w, () => links.linkBuilderProject({ mode: "create", grant_id: w.marina.grantId, property_type: "residential", billing_basis: "progress" })))
  const overview = await kit.as(w.owner, () => links.getProjectConnection(result.projectId))
  w.marina.linked = { ...result }
  return { office, result, again, overview }
})

async function linkingCreatesAJob(kit, spec, check) {
  const w = await world(kit)
  const s = await linkedNew(kit)
  const { q } = kit
  const job = kit.rows(`select p.name, p.status, p.phase, p.property_type, p.retainage_percent, p.location->>'address' address, pfs.billing_model, pfs.fixed_price_billing_basis basis, pfs.metadata->'receivables' receivables,
      c.contract_type, c.total_cents, cl.full_name customer, cl.id=pc.customer_contact_id is_the_connections_customer
    from public.projects p left join public.project_financial_settings pfs on pfs.project_id=p.id and pfs.org_id=p.org_id left join public.contracts c on c.project_id=p.id and c.org_id=p.org_id
      left join public.contacts cl on cl.id=p.client_id left join public.project_connections pc on pc.project_id=p.id and pc.org_id=p.org_id where p.id=${q(s.result.projectId)}`)[0]
  const connectionRow = kit.rows(`select status, source_org_id=${q(w.builder.orgId)} builders_org, source_project_id=${q(w.marina.projectId)} builders_project, source_company_id=${q(w.builder.companyId)} the_companys_directory_entry_there,
      source_org_name, source_project_name, portal_access_token_id=${q(w.marina.token.id)} on_the_token, grant_id=${q(w.marina.grantId)} on_the_grant, linked_by=${q(w.owner.userId)} by_the_owner, last_synced_at is null never_synced from public.project_connections where id=${q(s.result.connectionId)}`)[0]
  const directory = kit.rows(`select 'company' kind, t.key role, pr.status from public.party_roles pr join public.directory_relationship_types t on t.id=pr.relationship_type_id join public.companies co on co.id=pr.company_id where pr.org_id=${q(w.t.orgId)} and co.name=${q(BUILDER)}
    union all select 'contact', t.key, pr.status from public.party_roles pr join public.directory_relationship_types t on t.id=pr.relationship_type_id join public.contacts c on c.id=pr.contact_id where pr.org_id=${q(w.t.orgId)} and c.full_name=${q(BUILDER)} order by 1, 2`)
  const companies = Number(kit.rows(`select count(*)::int n from public.companies where org_id=${q(w.t.orgId)} and name=${q(BUILDER)}`)[0].n)
  const link = kit.rows(`select l.is_primary from public.contact_company_links l join public.contacts c on c.id=l.contact_id and c.org_id=l.org_id join public.companies co on co.id=l.company_id and co.org_id=l.org_id where l.org_id=${q(w.t.orgId)} and c.full_name=${q(BUILDER)} and co.name=${q(BUILDER)}`)
  const event = kit.rows(`select payload->>'source_org_name' builder, payload->>'source_project_name' project from public.events where org_id=${q(w.t.orgId)} and event_type='project_connection_linked' and entity_id=${q(s.result.projectId)}`)
  const observed = {
    officeAdminWithoutAVerifiedIdentity: s.office,
    result: { customerKept: s.result.customerKept, backfillQueued: s.result.backfillQueued, backfillFailed: s.result.backfillFailed },
    job: { name: job.name, status: job.status, phase: job.phase, posture: job.property_type, address: job.address, contractType: job.contract_type, contractCents: Number(job.total_cents), billingModel: job.billing_model, billingBasis: job.basis, retainagePercent: Number(job.retainage_percent), receivables: job.receivables, customer: job.customer, customerIsTheConnectionsCustomer: job.is_the_connections_customer },
    builderInTheDirectory: { companies, roles: directory, contactIsPrimaryThere: link[0]?.is_primary === true },
    connection: connectionRow && { status: connectionRow.status, builderOrganization: connectionRow.builders_org, builderProject: connectionRow.builders_project, builderCompany: connectionRow.the_companys_directory_entry_there, builderName: connectionRow.source_org_name, projectName: connectionRow.source_project_name, onTheInvitedToken: connectionRow.on_the_token, onTheGrant: connectionRow.on_the_grant, linkedByTheOwner: connectionRow.by_the_owner, neverSynced: connectionRow.never_synced },
    linkingAgain: s.again,
    jobOverview: s.overview && { status: s.overview.status, builder: s.overview.builderName, project: s.overview.builderProjectName, endedAt: s.overview.endedAt, canManage: s.overview.canManage },
    event,
  }
  check.equal("linking the Marina Way invitation in create mode makes an active delivery-phase job named for the project at its address with the contract amount and the default company billing terms, the builder (one directory company with the client role, no duplicate) as its customer, and one active connection to the builder's job, grant and token; a second link is refused", spec.expected, observed)
  return { orgId: w.t.orgId, projectId: s.result.projectId, connectionId: s.result.connectionId }
}

// ---------------------------------------------------------------------------
// The defect: Builder connections cannot say which invitations already feed a job

async function builderConnectionsListsTheLinkedJobs(kit, spec, check) {
  const w = await world(kit)
  const s = await linkedNew(kit)
  const result = await trade(kit, w, async () => {
    try {
      const rows = await A("lib/services/project-connections").listProjectConnectionsForGrants([w.marina.grantId, w.harbor.grantId])
      return rows.map((row) => ({ project: row.projectName, status: row.status, onTheCreatedJob: row.projectId === s.result.projectId }))
    } catch (error) {
      return `refused: ${String(error.message).slice(0, 120)}`
    }
  })
  check.equal("Builder connections lists which of the owner's invitations already feed a job, and which job", spec.expected, { linkedJobs: result })
  return { orgId: w.t.orgId, projectId: s.result.projectId }
}

// ---------------------------------------------------------------------------
// 3. Linking an existing job

const linkedExisting = (kit) => stage(kit, "linkedExisting", async (w) => {
  await linkedNew(kit)
  const jobs = A("lib/services/trade-workspace")
  const job = await trade(kit, w, () => jobs.createTradeJob({ name: "Harbor Avenue electrical", address: HARBOR.address, property_type: "residential", customer_kind: "company", billing_basis: "invoices", retainage_percent: 0, payment_terms_days: 30, customer_certifies: false, total_contract_value_cents: 3_000_000 }))
  const links = A("lib/services/project-connections")
  const pickable = await trade(kit, w, () => links.listLinkableJobs())
  const result = await trade(kit, w, () => links.linkBuilderProject({ mode: "link", grant_id: w.harbor.grantId, project_id: job.id }))
  const again = await attempt(() => trade(kit, w, () => links.linkBuilderProject({ mode: "link", grant_id: w.harbor.grantId, project_id: w.t.jobs.gc })))
  w.harbor.tradeJobId = job.id
  w.harbor.connectionId = result.connectionId
  w.harbor.billSeq = 0
  return { job, pickable, result, again }
})

async function linkingAnExistingJobKeepsItsTerms(kit, spec, check) {
  const w = await world(kit)
  const s = await linkedExisting(kit)
  const { q } = kit
  const job = kit.rows(`select p.name, p.retainage_percent, pfs.fixed_price_billing_basis basis, pfs.metadata->'receivables' receivables, c.total_cents, cl.full_name customer from public.projects p
    left join public.project_financial_settings pfs on pfs.project_id=p.id and pfs.org_id=p.org_id left join public.contracts c on c.project_id=p.id and c.org_id=p.org_id left join public.contacts cl on cl.id=p.client_id where p.id=${q(s.job.id)}`)[0]
  const connectionRow = connection(kit, s.result.connectionId)
  const observed = {
    pickedFrom: { offersTheNewJob: s.pickable.jobs.some((entry) => entry.id === s.job.id), offersTheJobLinkedInCreateMode: s.pickable.jobs.some((entry) => entry.id === w.marina.linked.projectId) },
    result: { customerKept: s.result.customerKept, backfillQueued: s.result.backfillQueued },
    job: { name: job.name, retainagePercent: Number(job.retainage_percent), billingBasis: job.basis, receivables: job.receivables, contractCents: Number(job.total_cents), customer: job.customer },
    connection: { status: connectionRow.status },
    linkingTheGrantToAnotherJob: s.again,
  }
  check.equal("linking the Harbor Avenue invitation to an existing job offers only jobs with no live link, keeps the job's no-retainage terms and contract and sets the builder as its customer; the grant cannot be linked twice", spec.expected, observed)
  return { orgId: w.t.orgId, projectId: s.job.id, connectionId: s.result.connectionId }
}

// ---------------------------------------------------------------------------
// 4. The first invoice

const firstInvoice = (kit) => stage(kit, "firstInvoice", async (w) => {
  await linkedExisting(kit)
  const bill = await submitBill(kit, w, w.harbor, { number: "ELEC-101", cents: 1_200_000, description: "Progress invoice 1 - rough-in" })
  const queued = kit.rows(`select job_type, status, payload->>'connection_id'=${kit.q(w.harbor.connectionId)} for_the_link, payload->>'source_bill_id'=${kit.q(bill.id)} for_the_bill from public.outbox where org_id=${kit.q(w.t.orgId)} and job_type='sync_connected_receivable'`)
  const builderQueue = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${kit.q(w.builder.orgId)} and job_type='sync_connected_receivable'`)[0].n)
  const duplicate = await attempt(() => submitBill(kit, w, w.harbor, { number: "ELEC-101", cents: 1_200_000, description: "Progress invoice 1 - rough-in" }))
  await kit.drainOutbox(w.t.orgId)
  const rerun = await kit.service(() => syncNow(w, w.harbor.connectionId, bill.id))
  const rerunAgain = await kit.service(() => syncNow(w, w.harbor.connectionId, bill.id))
  w.harbor.bill1 = bill.id
  return { bill, queued, builderQueue, duplicate, rerun, rerunAgain }
})

async function subInvoiceIsOneIssuedReceivable(kit, spec, check) {
  const w = await world(kit)
  const s = await firstInvoice(kit)
  const { q } = kit
  const list = mirrors(kit, w, w.harbor.tradeJobId)
  const invoiceCount = Number(kit.rows(`select count(*)::int n from public.invoices where org_id=${q(w.t.orgId)} and project_id=${q(w.harbor.tradeJobId)}`)[0].n)
  const mail = kit.rows(`select job_type from public.outbox where org_id=${q(w.t.orgId)} and job_type like '%invoice%' and job_type <> 'sync_connected_receivable'`).map((row) => row.job_type)
  const book = await moneyBook(kit, w, w.harbor.tradeJobId)
  const link = connection(kit, w.harbor.connectionId)
  const lines = kit.rows(`select description, quantity::float qty, unit_price_cents::int unit_cost from public.invoice_lines where org_id=${q(w.t.orgId)} and invoice_id=${q(list[0].id)}`)
  const customerOnInvoice = kit.rows(`select i.metadata->>'customer_name' customer, (i.metadata->>'customer_id')::uuid = pc.customer_contact_id is_the_connections_customer, i.due_date::text due_date, i.issue_date::text issue_date
    from public.invoices i join public.project_connections pc on pc.id=${q(w.harbor.connectionId)} where i.id=${q(list[0].id)}`)[0]
  const observed = {
    queuedForTheSubsOrganization: s.queued.map((row) => ({ job: row.job_type, status: row.status, forTheLink: row.for_the_link, forTheBill: row.for_the_bill })),
    queuedForTheBuilder: s.builderQueue,
    resubmittingTheSameInvoice: s.duplicate.startsWith("refused: This invoice looks like one you have already submitted") ? "refused: looks like one already submitted" : s.duplicate,
    billingBook: { invoices: invoiceCount, mirrors: list.map((row) => ({ number: row.number, status: row.status, totalCents: row.total, balanceCents: row.balance, sourceIsTheBill: row.bill === s.bill.id, builderStatus: row.source_status, builderPaidCents: row.source_paid, title: row.title, issued: row.issued })), summary: summaryOf(book) },
    nothingSentToAnyone: { delivery: list[0].delivery, deliveryStatus: list[0].delivery_status, visibleToTheCustomer: list[0].client_visible, invoiceEmailJobsQueued: mail },
    customerAndDates: { customer: customerOnInvoice.customer, isTheConnectionsCustomer: customerOnInvoice.is_the_connections_customer, dueMatchesTheBill: customerOnInvoice.due_date === day(30), issuedOnTheBillDate: customerOnInvoice.issue_date === today() },
    lines: lines.map((line) => ({ description: line.description, quantity: line.qty, unitCostCents: line.unit_cost })),
    rerunningTheSync: { first: { status: s.rerun.status, changed: s.rerun.changed, needsReview: s.rerun.needsReview }, second: { status: s.rerunAgain.status, changed: s.rerunAgain.changed } },
    connectionRecordsTheSync: link.synced,
  }
  check.equal("the sub's portal invoice queues one sync job in the trade organization (none in the builder's), becomes ONE issued invoice for the bill's amount to the builder on the linked job, is never emailed, and a rerun of the sync changes nothing and adds no second invoice", spec.expected, observed)
  return { orgId: w.t.orgId, billId: s.bill.id }
}

// ---------------------------------------------------------------------------
// 5. Approval and a partial payment

const partial = (kit) => stage(kit, "partial", async (w) => {
  const s = await firstInvoice(kit)
  const vb = A("lib/services/vendor-bills")
  const bill = w.harbor.bill1
  const pay = (status, cents, key) => kit.as(w.builder.owner, () => vb.updateVendorBillStatus({ billId: bill, input: { status, payment_amount_cents: cents, payment_method: "check", check_number: key, payment_date: today(), books_payment_account_id: glId(kit, w.builder, "1000"), payment_idempotency_key: `trade-net-01-${key}-${w.builder.orgId}` } }))
  w.harbor.pay = pay
  await kit.as(w.builder.owner, () => vb.updateVendorBillStatus({ billId: bill, input: { status: "approved", actual_lines: codedLines(w, w.harbor, 1_200_000) } }))
  await kit.drainOutbox(w.t.orgId)
  const afterApproval = { mirror: mirrors(kit, w, w.harbor.tradeJobId)[0], payments: payments(kit, w, mirrors(kit, w, w.harbor.tradeJobId)[0].id) }
  await pay("partial", 500_000, "6001")
  await kit.drainOutbox(w.t.orgId)
  const afterPartial = { mirror: mirrors(kit, w, w.harbor.tradeJobId)[0] }
  const reruns = []
  for (let i = 0; i < 2; i++) reruns.push(await kit.service(() => syncNow(w, w.harbor.connectionId, bill)))
  return { ...s, afterApproval, afterPartial, reruns }
})

async function approvalAndPartialPaymentRecordOnce(kit, spec, check) {
  const w = await world(kit)
  const s = await partial(kit)
  const { q } = kit
  const mirror = mirrors(kit, w, w.harbor.tradeJobId)[0]
  const book = await moneyBook(kit, w, w.harbor.tradeJobId)
  const received = payments(kit, w, mirror.id)
  const events = kit.rows(`select event_type from public.events where org_id=${q(w.t.orgId)} and entity_id=${q(mirror.id)} and event_type like 'connected_receivable%' order by created_at`).map((row) => row.event_type)
  const observed = {
    afterApproval: { invoices: mirrors(kit, w, w.harbor.tradeJobId).length, status: s.afterApproval.mirror.status, builderStatus: s.afterApproval.mirror.source_status, balanceCents: s.afterApproval.mirror.balance, payments: s.afterApproval.payments.length },
    afterPartialPayment: { status: s.afterPartial.mirror.status, builderStatus: s.afterPartial.mirror.source_status, builderPaidCents: s.afterPartial.mirror.source_paid, totalCents: s.afterPartial.mirror.total, balanceCents: s.afterPartial.mirror.balance },
    paymentsOnTheInvoice: received.map((payment) => ({ cents: payment.cents, provider: payment.provider, identity: payment.provider_payment_id === `connected:${w.harbor.bill1}:500000`, method: payment.method, status: payment.status })),
    rerunningTheSyncTwice: s.reruns.map((result) => ({ status: result.status, changed: result.changed })),
    paymentsAfterTheReruns: received.length,
    billingBook: summaryOf(book),
    trail: events,
  }
  check.equal("the builder's approval is mirrored (the invoice stays issued, builder status approved), its 500,000-cent partial payment is recorded on the invoice once as a builder-portal payment whatever the number of sync reruns, leaving 700,000 owed on the one invoice", spec.expected, observed)
  return { orgId: w.t.orgId, invoiceId: mirror.id }
}

// ---------------------------------------------------------------------------
// 6. The balance

const paid = (kit) => stage(kit, "paid", async (w) => {
  await partial(kit)
  await w.harbor.pay("paid", 700_000, "6002")
  await kit.drainOutbox(w.t.orgId)
  const reruns = []
  for (let i = 0; i < 2; i++) reruns.push(await kit.service(() => syncNow(w, w.harbor.connectionId, w.harbor.bill1)))
  return { reruns }
})

async function finalPaymentClosesTheReceivable(kit, spec, check) {
  const w = await world(kit)
  const s = await paid(kit)
  const mirror = mirrors(kit, w, w.harbor.tradeJobId)[0]
  const received = payments(kit, w, mirror.id)
  const book = await moneyBook(kit, w, w.harbor.tradeJobId)
  const bill = billOf(kit, "ELEC-101")
  const observed = {
    builderBill: { status: bill.status, paidCents: bill.paid },
    invoice: { status: mirror.status, totalCents: mirror.total, balanceCents: mirror.balance, builderStatus: mirror.source_status, builderPaidCents: mirror.source_paid },
    payments: received.map((payment) => ({ cents: payment.cents, identity: payment.provider_payment_id.replace(w.harbor.bill1, "<bill>") })),
    paymentsTotalCents: received.reduce((sum, payment) => sum + payment.cents, 0),
    rerunningTheSyncTwice: s.reruns.map((result) => ({ status: result.status, changed: result.changed })),
    billingBook: summaryOf(book),
  }
  check.equal("the builder's payment of the balance records a second payment of 700,000 once and pays the one invoice in full at the bill's total, and reruns change nothing", spec.expected, observed)
  return { orgId: w.t.orgId, invoiceId: mirror.id }
}

// ---------------------------------------------------------------------------
// 7. Rejections

const rejected = (kit) => stage(kit, "rejected", async (w) => {
  await paid(kit)
  const vb = A("lib/services/vendor-bills")
  const reject = (billId) => kit.as(w.builder.owner, () => vb.updateVendorBillStatus({ billId, input: { status: "rejected", rejection_reason: "Pricing does not match the subcontract schedule" } }))
  const second = await submitBill(kit, w, w.harbor, { number: "ELEC-102", cents: 300_000, description: "Progress invoice 2 - trim" })
  await kit.drainOutbox(w.t.orgId)
  const mirroredBeforeRejection = mirrors(kit, w, w.harbor.tradeJobId).find((row) => row.number === "ELEC-102")
  await reject(second.id)
  await kit.drainOutbox(w.t.orgId)
  const third = await submitBill(kit, w, w.harbor, { number: "ELEC-103", cents: 150_000, description: "Progress invoice 3 - extras" })
  await reject(third.id)
  await kit.drainOutbox(w.t.orgId)
  const neverMirrored = await kit.service(() => syncNow(w, w.harbor.connectionId, third.id))
  return { second, third, mirroredBeforeRejection, neverMirrored }
})

async function rejectedBillsVoidOrNeverMirror(kit, spec, check) {
  const w = await world(kit)
  const s = await rejected(kit)
  const list = mirrors(kit, w, w.harbor.tradeJobId)
  const second = list.find((row) => row.number === "ELEC-102")
  const book = await moneyBook(kit, w, w.harbor.tradeJobId)
  const observed = {
    beforeTheRejection: { number: s.mirroredBeforeRejection.number, status: s.mirroredBeforeRejection.status, totalCents: s.mirroredBeforeRejection.total },
    afterTheRejection: { status: second.status, balanceCents: second.balance, builderStatus: second.source_status, voidReason: second.void_reason },
    billRejectedBeforeItMirrored: { invoicesForIt: list.filter((row) => row.number === "ELEC-103").length, sync: s.neverMirrored },
    theFirstInvoiceIsUntouched: list.filter((row) => row.number === "ELEC-101").map((row) => row.status),
    billingBook: summaryOf(book),
    mirrorsOnTheJob: list.map((row) => `${row.number}:${row.status}`),
  }
  check.equal("rejecting a bill whose mirror was issued voids the mirror (reason rejected, builder status rejected), a bill rejected before it ever mirrored never produces an invoice and its sync is skipped, and the paid invoice is untouched", spec.expected, observed)
  return { orgId: w.t.orgId }
}

// ---------------------------------------------------------------------------
// 8. Edits

const openMirror = (kit) => stage(kit, "openMirror", async (w) => {
  await rejected(kit)
  const bill = await submitBill(kit, w, w.harbor, { number: "ELEC-104", cents: 600_000, description: "Progress invoice 4 - fixtures" })
  await kit.drainOutbox(w.t.orgId)
  w.harbor.bill4 = bill.id
  return { bill }
})

async function mirroredInvoicesRefuseUserEdits(kit, spec, check) {
  const w = await world(kit)
  await openMirror(kit)
  const { q } = kit
  const mirror = mirrors(kit, w, w.harbor.tradeJobId).find((row) => row.number === "ELEC-104")
  const snapshot = () => kit.rows(`select status, total_cents::int total, balance_due_cents::int balance, updated_at::text updated, (select count(*)::int from public.payments p where p.invoice_id=i.id) payments, (select count(*)::int from public.invoices x where x.org_id=i.org_id and x.project_id=i.project_id) invoices from public.invoices i where i.id=${q(mirror.id)}`)[0]
  const before = snapshot()
  const invoices = A("lib/services/invoices")
  const asOwner = (work) => attempt(() => kit.as(w.owner, work))
  const input = { project_id: w.harbor.tradeJobId, invoice_number: "ELEC-104-EDIT", title: "Edited by the sub", lines: [{ description: "Edited", quantity: 1, unit: "ea", unit_cost: 1 }] }
  const refusals = {
    edit: await asOwner(() => invoices.updateInvoice({ invoiceId: mirror.id, input })),
    void: await asOwner(() => invoices.voidInvoice({ invoiceId: mirror.id })),
    delete: await asOwner(() => invoices.deleteInvoice({ invoiceId: mirror.id })),
    revise: await asOwner(() => invoices.reviseInvoice({ invoiceId: mirror.id })),
    scheduleSend: await asOwner(() => invoices.scheduleInvoiceSend({ invoiceId: mirror.id, sendAt: new Date(Date.now() + 2 * DAY).toISOString(), recipients: ["ap@builder.example.test"] })),
    receivePayment: await asOwner(() => A("lib/services/payments").recordMultiInvoicePayment({ received_at: new Date().toISOString(), method: "check", idempotency_key: require("node:crypto").randomUUID(), allocations: [{ invoice_id: mirror.id, amount_cents: 100_000 }] })),
  }
  // The same changes as a browser's own session would send them to the data API.
  const rest = (write) => attempt(() => kit.as(w.owner, async () => {
    const { supabase } = await A("lib/services/context").requireOrgContext()
    const { data, error } = await write(supabase)
    if (error) throw new Error(error.message)
    if (!data?.length) throw new Error("no rows changed")
  }))
  const dataApi = {
    rewriteTheTotal: await rest((db) => db.from("invoices").update({ total_cents: 1, balance_due_cents: 1 }).eq("id", mirror.id).select("id")),
    voidIt: await rest((db) => db.from("invoices").update({ status: "void" }).eq("id", mirror.id).select("id")),
    deleteIt: await rest((db) => db.from("invoices").delete().eq("id", mirror.id).select("id")),
    plantAPayment: await rest((db) => db.from("payments").insert({ org_id: w.t.orgId, invoice_id: mirror.id, amount_cents: 600_000, method: "check", status: "succeeded", provider: "manual", received_at: new Date().toISOString() }).select("id")),
  }
  const after = snapshot()
  const observed = { refusals, dataApi, unchanged: JSON.stringify(before) === JSON.stringify(after), invoiceState: { status: after.status, totalCents: after.total, balanceCents: after.balance, payments: after.payments } }
  check.equal("editing, voiding, deleting, revising, scheduling a send of or receiving a payment against a mirrored invoice is refused with the builder's name and leaves the invoice, its payments and the book exactly as they were", spec.expected, observed)
  return { orgId: w.t.orgId, invoiceId: mirror.id }
}

// ---------------------------------------------------------------------------
// 9. Pause, resume, revoke

const paused = (kit) => stage(kit, "paused", async (w) => {
  await openMirror(kit)
  const access = app("portal-access")
  await kit.as(w.builder.owner, () => access.pausePortalToken(w.harbor.token.id))
  const pausedConnection = connection(kit, w.harbor.connectionId)
  const grantWhilePaused = kit.rows(`select status, paused_at is not null paused from public.external_identity_grants where id=${kit.q(w.harbor.grantId)}`)[0]
  const workspaceWhilePaused = (await workspace(kit, w)).items.map((item) => item.project_name)
  const vb = A("lib/services/vendor-bills")
  const pausedAt = new Date().toISOString()
  await kit.as(w.builder.owner, () => vb.updateVendorBillStatus({ billId: w.harbor.bill4, input: { status: "approved", actual_lines: codedLines(w, w.harbor, 600_000) } }))
  const duringPause = await submitBill(kit, w, w.harbor, { number: "ELEC-105", cents: 200_000, description: "Progress invoice 5 - punch" })
  await kit.drainOutbox(w.t.orgId)
  const queuedWhilePaused = Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${kit.q(w.t.orgId)} and job_type='sync_connected_receivable' and created_at > ${kit.q(pausedAt)}`)[0].n)
  const direct = await kit.service(() => syncNow(w, w.harbor.connectionId, duringPause.id))
  const heldMirror = mirrors(kit, w, w.harbor.tradeJobId).find((row) => row.number === "ELEC-104")
  const invoicesForTheBillWhilePaused = mirrors(kit, w, w.harbor.tradeJobId).filter((row) => row.number === "ELEC-105").length
  const overviewWhilePaused = await kit.as(w.owner, () => A("lib/services/project-connections").getProjectConnection(w.harbor.tradeJobId))
  await kit.as(w.builder.owner, () => access.resumePortalToken(w.harbor.token.id))
  const resumedConnection = connection(kit, w.harbor.connectionId)
  await kit.drainOutbox(w.t.orgId)
  const afterResume = { openMirror: mirrors(kit, w, w.harbor.tradeJobId).find((row) => row.number === "ELEC-104")?.source_status, billSubmittedWhilePaused: mirrors(kit, w, w.harbor.tradeJobId).filter((row) => row.number === "ELEC-105").length }
  await kit.as(w.builder.owner, () => access.revokePortalToken(w.harbor.token.id))
  const revokedConnection = connection(kit, w.harbor.connectionId)
  await kit.as(w.builder.owner, () => access.resumePortalToken(w.harbor.token.id)).catch(() => null)
  const afterResumeOfARevoked = connection(kit, w.harbor.connectionId)
  const workspaceAfterRevoke = (await workspace(kit, w)).items.map((item) => item.project_name)
  const relink = await attempt(() => trade(kit, w, () => A("lib/services/project-connections").linkBuilderProject({ mode: "link", grant_id: w.harbor.grantId, project_id: w.harbor.tradeJobId })))
  return { invoicesForTheBillWhilePaused, pausedConnection, grantWhilePaused, workspaceWhilePaused, queuedWhilePaused, direct, heldMirror, overviewWhilePaused, resumedConnection, afterResume, revokedConnection, afterResumeOfARevoked, workspaceAfterRevoke, relink, duringPause }
})

async function pausingTheBuilderAccessPausesTheLink(kit, spec, check) {
  const w = await world(kit)
  const s = await paused(kit)
  const observed = {
    paused: { connection: s.pausedConnection.status, grant: s.grantWhilePaused.status, builderConnectionsLists: s.workspaceWhilePaused, overviewShowsIt: s.overviewWhilePaused?.status },
    whilePaused: { syncJobsQueuedForTheBuildersChanges: s.queuedWhilePaused, aDirectSyncOfANewBill: s.direct, invoicesForTheNewBill: s.invoicesForTheBillWhilePaused, theOpenMirrorStaysAt: s.heldMirror.source_status },
    resumed: { connection: s.resumedConnection.status },
    revoked: { connection: s.revokedConnection.status, reason: s.revokedConnection.ended_reason, endedAtSet: s.revokedConnection.ended },
    resumingARevokedAccess: { connection: s.afterResumeOfARevoked.status },
    afterRevoke: { builderConnectionsLists: s.workspaceAfterRevoke, relinkingTheGrant: s.relink },
  }
  check.equal("pausing the builder's portal access pauses the grant and the link (no syncing, a direct sync is skipped), resuming reactivates it, revoking ends it for good with its reason and a revoked access cannot be resumed or linked again", spec.expected, observed)
  return { orgId: w.t.orgId, connectionId: w.harbor.connectionId }
}

async function resumingALinkCatchesUpOnTheBuildersChanges(kit, spec, check) {
  const w = await world(kit)
  const s = await paused(kit)
  check.equal("after the builder resumes the access, the mirror shows the builder's current status (approved) and the bill submitted while the link was paused has its receivable", spec.expected, { openMirrorBuilderStatus: s.afterResume.openMirror, receivablesForTheBillSubmittedWhilePaused: s.afterResume.billSubmittedWhilePaused })
  return { orgId: w.t.orgId, connectionId: w.harbor.connectionId }
}

// ---------------------------------------------------------------------------
// The defect: a job that holds retainage

async function mirrorEqualsTheBillOnAJobThatHoldsRetainage(kit, spec, check) {
  const w = await world(kit)
  await linkedNew(kit)
  const { q } = kit
  const job = w.marina
  const bill = await submitBill(kit, w, job, { number: "ELEC-301", cents: 800_000, description: "Progress invoice 1 - service" })
  await kit.drainOutbox(w.t.orgId)
  const firstSync = mirrors(kit, w, job.linked.projectId).map((row) => ({ number: row.number, status: row.status, totalCents: row.total }))
  const second = await kit.service(() => syncNow(w, job.linked.connectionId, bill.id))
  const secondSync = { status: second.status, changed: second.changed }
  const afterSecond = mirrors(kit, w, job.linked.projectId).map((row) => ({ number: row.number, status: row.status }))
  check.equal("the receivable mirrored for an 800,000-cent bill on the job the link created (default 10% retainage) is 800,000 cents, and syncing it again leaves one issued invoice", spec.expected, { billCents: 800_000, firstSync, secondSync, afterSecondSync: afterSecond })
  return { orgId: w.t.orgId }
}

module.exports = {
  id: "TRADE-NET-01",
  subcases: {
    "builder-invites-the-owner-who-claims-it": builderInvitesTheOwnerWhoClaimsIt,
    "linking-creates-a-job-with-the-builder-as-customer": linkingCreatesAJob,
    "builder-connections-lists-the-linked-jobs": builderConnectionsListsTheLinkedJobs,
    "linking-an-existing-job-keeps-its-terms": linkingAnExistingJobKeepsItsTerms,
    "sub-invoice-is-one-issued-receivable": subInvoiceIsOneIssuedReceivable,
    "builder-approval-and-partial-payment-record-once": approvalAndPartialPaymentRecordOnce,
    "builder-final-payment-closes-the-receivable": finalPaymentClosesTheReceivable,
    "rejected-bills-void-or-never-mirror": rejectedBillsVoidOrNeverMirror,
    "mirrored-invoices-refuse-user-edits": mirroredInvoicesRefuseUserEdits,
    "pausing-the-builder-access-pauses-the-link": pausingTheBuilderAccessPausesTheLink,
    "resuming-a-link-catches-up-on-the-builders-changes": resumingALinkCatchesUpOnTheBuildersChanges,
    "mirror-equals-the-bill-on-a-job-that-holds-retainage": mirrorEqualsTheBillOnAJobThatHoldsRetainage,
  },
}
