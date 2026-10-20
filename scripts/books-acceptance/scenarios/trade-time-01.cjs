// TRADE-TIME-01 — a two-week pay period at an electrical company (TR03-02, TR03-03). The Arc Trade
// company from trade-seed.cjs (its own organization for this scenario) runs a biweekly period,
// Monday 2026-09-21 to Sunday 2026-10-04, on a 40-hour weekly overtime rule. Two crew members clock in
// and out across the company's three jobs through the clock service (each day's session is
// back-dated to its day, as the clock would have recorded it), the foreman approves in bulk holding
// time.approve and not bill.approve, the office admin locks the period and exports the payroll CSV,
// and the payroll provider's register for the period is imported into Books payroll, where it
// reconciles to the labor Books recognized from the approved time.
//
//   crew-clock-across-three-jobs             12 sessions on three jobs land as submitted time at each
//                                            worker's rate in force
//   foreman-bulk-approves-and-overtime-flags a bulk approval by the foreman (time.approve, no
//                                            bill.approve) splits the one entry that crosses the
//                                            weekly line and posts labor cost to the jobs
//   admin-locks-the-period                   closing needs time.close, locks the approved time, and a
//                                            closed period cannot close again
//   payroll-csv-export                       the export carries each worker's hours by job, regular
//                                            and overtime, with labor cost
//   register-reconciles-in-books-payroll     the provider register is prepared and reviewed in Books
//                                            payroll and reconciles to recognized labor to the cent
const { createHash, randomUUID } = require("node:crypto")
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")
const { enableBooks, projectBooks } = require("./trade-books.cjs")

const A = (path) => require(`../../../${path}`)

const PERIOD = { startsOn: "2026-09-21", endsOn: "2026-10-04" }
const POLICY = { pay_frequency: "biweekly", pay_anchor_date: "2026-09-07", automatic_overtime: true, weekly_overtime_hours: 40, daily_overtime_hours: null, daily_double_time_hours: null }

// One clocked day: worker, work date, job, hours. In work order.
const SHIFTS = [
  ["crew", "2026-09-21", "gc", 9], ["crew", "2026-09-22", "homeowner", 9], ["crew", "2026-09-23", "commercial", 9],
  ["crew", "2026-09-24", "gc", 9], ["crew", "2026-09-25", "homeowner", 8],
  ["crewTwo", "2026-09-21", "homeowner", 8], ["crewTwo", "2026-09-22", "gc", 8], ["crewTwo", "2026-09-23", "commercial", 8],
  ["crew", "2026-09-28", "commercial", 8], ["crew", "2026-09-29", "homeowner", 8], ["crewTwo", "2026-09-28", "gc", 8],
]

const STAGES = new WeakMap()
/** Each stage runs once per kit, after the stages it builds on; so a single subcase can be run alone. */
function stage(kit, name, build) {
  if (!STAGES.has(kit)) STAGES.set(kit, new Map())
  const stages = STAGES.get(kit)
  if (!stages.has(name)) stages.set(name, build())
  return stages.get(name)
}

const world = (kit) => stage(kit, "world", async () => {
  const w = await tradeCompany(kit, { name: "Voltline Electric - pay period (acceptance)" })
  const { q } = kit
  await kit.as(w.actors.owner, () => app("time-policy").saveTimePolicy(POLICY))
  // The crew work all three jobs and the foreman approves on all three: the assignments are fixture rows,
  // written the way the seed writes its own.
  const assign = (user, projectId) => kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status)
    select ${q(w.orgId)},${q(projectId)},${q(user.userId)},id,'active' from public.roles where key='field' and scope='project'
    on conflict (project_id,user_id) do nothing;`)
  for (const key of ["crew", "crewTwo"]) for (const job of ["gc", "commercial"]) assign(w.actors[key], w.jobs[job])
  assign(w.actors.foreman, w.jobs.commercial)
  assign(w.actors.crewTwo, w.jobs.homeowner)
  // Each job budgets labor and material by cost code, so the clock asks the crew which one their hours belong to.
  const codes = Object.fromEntries(kit.rows(`select code, id from public.cost_codes where org_id=${q(w.orgId)} and code in ('3270','3280')`).map((row) => [row.code, row.id]))
  for (const job of Object.values(w.jobs))
    await kit.as(w.actors.owner, () => app("budgets").createBudget({ project_id: job, status: "approved", lines: [
      { cost_code_id: codes["3270"], description: "Rough electrical labor", amount_cents: 4_000_000 },
      { cost_code_id: codes["3280"], description: "Rough electrical material", amount_cents: 2_000_000 },
    ] }))
  w.laborCodeId = codes["3270"]
  // The company turns Books on before the period: approved time posts labor to the ledger as it is approved.
  await enableBooks(kit, w, ["2026-09", "2026-10"])
  return w
})

const clocked = (kit) => stage(kit, "clocked", async () => {
  const w = await world(kit)
  const { q } = kit
  for (const [key, date, job, hours] of SHIFTS) {
    const actor = w.actors[key]
    await kit.as(actor, () => app("time-clock").clockIn({ projectId: w.jobs[job], costCodeId: w.laborCodeId, source: "mobile" }))
    kit.sql(`update public.time_clock_sessions set started_at = now() - interval '${hours} hours', work_date = ${q(date)} where org_id=${q(w.orgId)} and worker_user_id=${q(actor.userId)} and ended_at is null;`)
    await kit.as(actor, () => app("time-clock").clockOut({}))
  }
  return w
})

const entries = (kit, w, where = "") => kit.rows(`select e.id, e.worker_name worker, e.work_date::text date, p.name job, e.hours::float8 hours, e.status, e.base_rate_cents, e.burden_multiplier::float8 burden,
    e.is_overtime, e.is_double_time, e.cost_cents, e.metadata, e.created_at
  from public.time_entries e join public.projects p on p.id=e.project_id where e.org_id=${kit.q(w.orgId)} ${where} order by e.work_date, e.worker_name, e.created_at`)

const WORKER = { crew: "Casey Crew", crewTwo: "Chris Crew" }

async function crewClockAcrossThreeJobs(kit, spec, check) {
  const w = await clocked(kit)
  const { q } = kit
  const rows = entries(kit, w, `and e.work_date between '${PERIOD.startsOn}' and '${PERIOD.endsOn}'`)
  const sessions = kit.rows(`select count(*) filter (where ended_at is not null)::int closed, count(*) filter (where ended_at is null)::int open, count(*) filter (where time_entry_id is not null)::int linked from public.time_clock_sessions where org_id=${q(w.orgId)} and work_date between '${PERIOD.startsOn}' and '${PERIOD.endsOn}'`)[0]
  check.equal("eleven clock sessions close into one submitted entry each, at the rate and burden in force, with no clock left open", spec.expected, {
    sessions,
    entries: rows.map((r) => ({ worker: r.worker, date: r.date, job: r.job, hours: Number(r.hours.toFixed(2)), status: r.status, baseRateCents: r.base_rate_cents, burden: r.burden, overtime: r.is_overtime })),
  })
  return { orgId: w.orgId }
}


const approved = (kit) => stage(kit, "approved", async () => {
  const w = await clocked(kit)
  const ids = kit.rows(`select id from public.time_entries where org_id=${kit.q(w.orgId)} and status='submitted' and work_date between '${PERIOD.startsOn}' and '${PERIOD.endsOn}'`).map((row) => row.id)
  w.bulk = await kit.as(w.actors.foreman, () => app("timesheets").approveTimeEntries({ ids }))
  w.submittedIds = ids
  return w
})

const closed = (kit) => stage(kit, "closed", async () => {
  const w = await approved(kit)
  w.close = await kit.as(w.actors.officeAdmin, () => app("timesheets").closePayPeriod({ startsOn: PERIOD.startsOn }))
  return w
})

// The Books ledger is a projection of approved time; project it as the company's books do.
const booked = (kit) => stage(kit, "booked", async () => {
  const w = await closed(kit)
  await kit.drainOutbox(w.orgId)
  await projectBooks(kit, w)
  return w
})

const effective = (kit, actor) => kit.as(actor, () => A("lib/services/authorization").getEffectiveOrgPermissions(actor.orgId, actor.userId))
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 120)}` } }

async function foremanBulkApprovesWithTimeApproveOnly(kit, spec, check) {
  const w = await approved(kit)
  const { q } = kit
  const permissions = await effective(kit, w.actors.foreman)
  const rows = entries(kit, w, `and e.work_date between '${PERIOD.startsOn}' and '${PERIOD.endsOn}'`)
  const posted = kit.rows(`select count(*)::int entries, coalesce(sum(j.cost_cents - e.cost_cents),0)::int difference
    from public.job_cost_entries j join public.time_entries e on e.id::text=j.source_id::text where j.org_id=${q(w.orgId)} and j.source_type='time_entry' and j.status='posted'`)[0]
  const hasHours = (key) => rows.filter((r) => r.worker === WORKER[key]).reduce((total, r) => total + r.hours, 0)
  check.equal("the foreman holds time.approve and not bill.approve; one bulk approval moves every submitted entry of the period to approved with nothing refused, the hours are untouched, each entry posts labor to its job at its own cost, and the foreman cannot send time for client approval or close the period", spec.expected, {
    foremanHolds: { "time.approve": permissions.includes("time.approve"), "bill.approve": permissions.includes("bill.approve"), "time.close": permissions.includes("time.close") },
    bulk: { failed: w.bulk.failed, approvedEveryEntryTheForemanSent: w.submittedIds.every((id) => w.bulk.done.includes(id)) },
    entriesStillWaiting: rows.filter((r) => r.status !== "pm_approved").length,
    hoursByWorker: { [WORKER.crew]: hasHours("crew"), [WORKER.crewTwo]: hasHours("crewTwo") },
    jobCostPostedForEveryApprovedEntry: Number(posted.entries) === rows.length && posted.difference === 0,
    foremanRefused: {
      clientApproval: await refusal(() => kit.as(w.actors.foreman, () => app("cost-plus").createTimeEntryApprovalLink(rows[0].id))),
      closingThePeriod: await refusal(() => kit.as(w.actors.foreman, () => app("timesheets").closePayPeriod({ startsOn: PERIOD.startsOn }))),
    },
  })
  return { orgId: w.orgId }
}

async function weeklyOvertimeEntryIsAutoFlagged(kit, spec, check) {
  const w = await approved(kit)
  const friday = entries(kit, w, `and e.work_date='2026-09-25' and e.worker_name=${kit.q(WORKER.crew)}`)
  check.equal("Casey's Friday entry takes her 36 earlier hours of the week to 44: approval splits it into 4 regular hours and 4 overtime hours, the overtime part flagged by the rule", spec.expected,
    friday.map((r) => ({ hours: r.hours, overtime: r.is_overtime, doubleTime: r.is_double_time, status: r.status, overtimeSource: r.metadata.overtime_source ?? null })))
  return { orgId: w.orgId }
}

async function adminLocksThePeriod(kit, spec, check) {
  const w = await closed(kit)
  const { q } = kit
  const [period] = kit.rows(`select starts_on::text, ends_on::text, closed_by from public.pay_periods where org_id=${q(w.orgId)}`)
  const rows = entries(kit, w, `and e.work_date between '${PERIOD.startsOn}' and '${PERIOD.endsOn}'`)
  check.equal("the office admin (time.close) closes the biweekly period after every entry is approved: every entry is locked at its hours, the summary totals the period's hours by worker and job, and a second close is refused", spec.expected, {
    period: { startsOn: period.starts_on, endsOn: period.ends_on, closedByTheOfficeAdmin: period.closed_by === w.actors.officeAdmin.userId },
    everyEntryLocked: rows.every((r) => r.status === "locked"),
    lockedHours: Math.round(rows.reduce((total, r) => total + r.hours, 0) * 100) / 100,
    summaryHours: { total: w.close.summary.totals.hours, byWorker: Object.fromEntries(w.close.summary.byWorker.map((row) => [row.label, row.hours])), byJob: Object.fromEntries(w.close.summary.byJob.map((row) => [row.label, row.hours])) },
    closingAgain: await refusal(() => kit.as(w.actors.officeAdmin, () => app("timesheets").closePayPeriod({ startsOn: PERIOD.startsOn }))),
  })
  return { orgId: w.orgId }
}

/** Emails vary by run; the export carries them, so the checks read the file with each replaced by its worker's key. */
const maskEmails = (w, text) => Object.entries(WORKER).reduce((out, [key]) => out.replaceAll(w.actors[key].email, `<${key}>`), text)

async function payrollCsvExport(kit, spec, check) {
  const w = await closed(kit)
  const exported = await kit.as(w.actors.officeAdmin, () => app("timesheets").exportPayPeriod({ startsOn: PERIOD.startsOn, layout: "generic" }))
  const audited = kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(w.orgId)} and entity_type='payroll_hours_export'`)[0].n
  const foreman = await refusal(() => kit.as(w.actors.foreman, () => app("timesheets").exportPayPeriod({ startsOn: PERIOD.startsOn, layout: "generic" })))
  check.equal("the export of the closed period lists each worker's regular and overtime hours and labor cost by job; the foreman cannot export; the export leaves an audit record", spec.expected, {
    filename: exported.filename, lines: maskEmails(w, exported.csv).trim().split("\n"), foremanExport: foreman, auditedExports: Number(audited),
  })
  return { orgId: w.orgId }
}


// The provider's register for the period, as the payroll company would send it: one row per employee and an
// independent control row, amounts in cents. The wages and employer cost each worker is paid on a job follow
// from the hours (hours x cost rate, at 1.5 for overtime; employer cost is the 25% burden the company costs labor at).
const REGISTER = {
  provider: "Gusto", runId: "RUN-2026-10-09", payDate: "2026-10-09", accrualDate: PERIOD.endsOn,
  workers: {
    crew: { reference: "EMP-CASEY", net: 185_800, employeeTaxes: 20_000, deductions: 5_000, allocations: { gc: { gross: 61_200, employerTaxes: 15_300 }, homeowner: { gross: 91_800, employerTaxes: 22_950 }, commercial: { gross: 57_800, employerTaxes: 14_450 } } },
    crewTwo: { reference: "EMP-CHRIS", net: 92_400, employeeTaxes: 8_000, deductions: 2_000, allocations: { gc: { gross: 51_200, employerTaxes: 12_800 }, homeowner: { gross: 25_600, employerTaxes: 6_400 }, commercial: { gross: 25_600, employerTaxes: 6_400 } } },
  },
}
const HEADERS = ["row_type", "provider", "provider_run_id", "period_start", "period_end", "accrual_date", "pay_date", "employee_reference", "gross", "net", "employee_taxes", "employee_deductions", "employer_taxes", "employer_benefits", "funding"]

function registerCsv() {
  const common = [REGISTER.provider, REGISTER.runId, PERIOD.startsOn, PERIOD.endsOn, REGISTER.accrualDate, REGISTER.payDate]
  const rows = [], total = { gross: 0, net: 0, employeeTaxes: 0, deductions: 0, employerTaxes: 0 }
  for (const worker of Object.values(REGISTER.workers)) {
    const gross = Object.values(worker.allocations).reduce((sum, a) => sum + a.gross, 0)
    const employerTaxes = Object.values(worker.allocations).reduce((sum, a) => sum + a.employerTaxes, 0)
    rows.push(["employee", ...common, worker.reference, gross, worker.net, worker.employeeTaxes, worker.deductions, employerTaxes, 0, ""])
    for (const [key, value] of Object.entries({ gross, net: worker.net, employeeTaxes: worker.employeeTaxes, deductions: worker.deductions, employerTaxes })) total[key] += value
  }
  const funding = total.net + total.employeeTaxes + total.deductions + total.employerTaxes
  rows.push(["control", ...common, "", total.gross, total.net, total.employeeTaxes, total.deductions, total.employerTaxes, 0, funding])
  return [HEADERS, ...rows].map((row) => row.join(",")).join("\r\n") + "\r\n"
}

/**
 * The provider's file goes to the company's document store and Books reads it back byte-verified. The
 * acceptance stack has no object store, so the store is the one thing stood in: the read the Books source
 * makes for this file's path returns the bytes retained for it, and every other path is not served.
 */
function retainRegister(kit, w, text) {
  const { q } = kit
  const bytes = Buffer.from(text), checksum = createHash("sha256").update(bytes).digest("hex")
  const [fileId, versionId] = [randomUUID(), randomUUID()]
  const path = `${w.orgId}/payroll/register-${REGISTER.runId}.csv`
  kit.sql(`begin;
insert into public.files(id,org_id,file_name,storage_path,mime_type,size_bytes,checksum) values(${q(fileId)},${q(w.orgId)},'payroll-register.csv',${q(path)},'text/csv',${bytes.length},${q(checksum)});
insert into public.doc_versions(id,org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum) values(${q(versionId)},${q(w.orgId)},${q(fileId)},1,${q(path)},'payroll-register.csv','text/csv',${bytes.length},${q(checksum)});
update public.files set current_version_id=${q(versionId)} where id=${q(fileId)};
commit;`)
  const storage = require("../../../lib/storage/files-storage")
  const real = storage.getFilesObjectStream
  storage.getFilesObjectStream = async (params) => {
    if (params.orgId !== w.orgId || params.path !== path) throw new Error("The acceptance stack serves only the retained payroll register")
    return { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close() } }), contentLength: bytes.length }
  }
  return { fileId, versionId, restore: () => { storage.getFilesObjectStream = real } }
}

/** The register imported into Books payroll: prepared by the office admin, reviewed by the owner. */
const imported = (kit) => stage(kit, "imported", async () => {
  const w = await booked(kit)
  const { q } = kit
  const evidence = kit.rows(`select j.id, e.worker_user_id, e.project_id from public.job_cost_entries j join public.time_entries e on e.id::text=j.source_id::text
    where j.org_id=${q(w.orgId)} and j.source_type='time_entry' and j.status='posted' order by j.id`)
  const account = kit.rows(`select distinct f.payload->>'cost_account_code' code from public.accounting_facts f where f.org_id=${q(w.orgId)} and f.source_type='labor_cost'`)
  const costAccount = account.length === 1 && account[0].code ? account[0].code : "5030"
  const workers = Object.entries(REGISTER.workers).map(([key, worker]) => ({
    employee_reference: worker.reference, worker_id: w.actors[key].userId,
    allocations: Object.entries(worker.allocations).map(([job, amounts]) => ({
      id: randomUUID(), project_id: w.jobs[job], cost_code_id: w.laborCodeId, cost_account_code: costAccount,
      gross_cents: amounts.gross, employer_taxes_cents: amounts.employerTaxes, employer_benefits_cents: 0,
      labor_evidence_ids: evidence.filter((row) => row.worker_user_id === w.actors[key].userId && row.project_id === w.jobs[job]).map((row) => row.id),
    })),
  }))
  const retained = retainRegister(kit, w, registerCsv())
  try {
    const mapping = { columns: Object.fromEntries(HEADERS.map((header) => [header, header])), amount_unit: "cents", employee_row_value: "employee", control_row_value: "control" }
    const register = { runId: randomUUID(), fileId: retained.fileId, documentVersionId: retained.versionId, mapping, workers }
    const payroll = app("books/payroll-imports")
    const importId = await kit.as(w.actors.officeAdmin, () => payroll.preparePayrollImport({ register, notes: "Pay period 2026-09-21 to 2026-10-04 register from the payroll provider", idempotencyKey: `register-${register.runId}` }))
    w.selfReview = await refusal(() => kit.as(w.actors.officeAdmin, () => payroll.reviewPayrollImport({ id: importId, notes: "Reviewed against the closed period" })))
    await kit.as(w.actors.owner, () => payroll.reviewPayrollImport({ id: importId, notes: "Reviewed against the closed period's payroll export" }))
    w.importId = importId
    w.allocations = workers.flatMap((worker) => worker.allocations)
  } finally {
    retained.restore()
  }
  return w
})

async function registerReconcilesInBooksPayroll(kit, spec, check) {
  const w = await imported(kit)
  const { q } = kit
  const [row] = kit.rows(`select status, prepared_by, reviewed_by, reconciliation from public.books_payroll_imports where org_id=${q(w.orgId)} and id=${q(w.importId)}`)
  const rec = row.reconciliation
  const keyOf = (record, id) => Object.entries(record).find(([, value]) => (value.userId ?? value) === id)?.[0]
  check.equal("the provider's register for the closed period is prepared by the office admin and reviewed by the owner (a preparer cannot review), and reconciles to the labor Books recognized from the approved time: provider wages equal recognized wages and employer cost equals the 25% burden, on every worker and job", spec.expected, {
    status: row.status, preparedByTheOfficeAdmin: row.prepared_by === w.actors.officeAdmin.userId, reviewedByTheOwner: row.reviewed_by === w.actors.owner.userId,
    preparerReviewingOwnImport: w.selfReview,
    providerTotals: { grossCents: rec.totals.gross_cents, netCents: rec.totals.net_cents, employeeTaxesCents: rec.totals.employee_taxes_cents, employeeDeductionsCents: rec.totals.employee_deductions_cents, employerTaxesCents: rec.totals.employer_taxes_cents, fundingCents: rec.fundingCents },
    recognizedLabor: { grossCents: rec.recognizedGrossCents, estimatedBurdenCents: rec.estimatedBurdenCents },
    variance: { wageCents: rec.wageVarianceCents, employerCostCents: rec.burdenVarianceCents, totalCents: rec.costVarianceCents, needsReview: rec.requiresVarianceReview },
    allocations: rec.variances.map((v) => ({
      worker: keyOf(w.actors, v.workerId), job: keyOf(w.jobs, w.allocations.find((a) => a.id === v.allocationId)?.project_id),
      recognizedCents: v.recognizedCents, providerGrossCents: v.providerGrossCents, varianceCents: v.varianceCents,
    })).sort((a, b) => `${a.worker}${a.job}`.localeCompare(`${b.worker}${b.job}`)),
  })
  return { orgId: w.orgId, importId: w.importId }
}

async function payPeriodSummaryShowsTheBooksImport(kit, spec, check) {
  const w = await imported(kit)
  const summary = await kit.as(w.actors.officeAdmin, () => app("timesheets").getPayPeriodSummary({ period: PERIOD.startsOn })).then(
    (value) => ({ payrollImport: value.payrollImport ? { status: value.payrollImport.status, reconciled: value.payrollImport.reconciled } : null }),
    (error) => ({ error: String(error?.message ?? error).slice(0, 160) }),
  )
  check.equal("once the register is imported, the office admin's pay period summary for the closed period reads the reviewed import and shows it reconciled", spec.expected, summary)
  return { orgId: w.orgId, importId: w.importId }
}

// A job the company runs without a cost-coded budget: the clock has no cost code to offer, and approval
// asks for one. A company keeps cost codes on by default (org setting absent means on).
async function timeOnAJobWithoutABudgetCanBeApproved(kit, spec, check) {
  const w = await world(kit)
  const { q } = kit
  const contact = w.customers.homeownerContactId
  const jobId = await kit.as(w.actors.owner, () => app("trade-workspace").createTradeJob({
    name: "Cedar Lane - warranty call", client_id: contact, address: "3 Cedar Lane, Stuart, FL", property_type: "residential", customer_kind: "homeowner",
    billing_basis: "time_and_materials", retainage_percent: 0, payment_terms_days: 15, start_date: "2026-09-14",
  })).then((job) => job.id)
  kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${q(w.orgId)},${q(jobId)},u.id,r.id,'active' from public.roles r, (values (${q(w.actors.crew.userId)}::uuid),(${q(w.actors.foreman.userId)}::uuid)) u(id) where r.key='field' and r.scope='project' on conflict (project_id,user_id) do nothing;`)
  // The job budgets no codes, so the clock asks from the company's own.
  const [costCode] = kit.rows(`select id from public.cost_codes where org_id=${q(w.orgId)} and is_active order by code limit 1`)
  await kit.as(w.actors.crew, () => app("time-clock").clockIn({ projectId: jobId, costCodeId: costCode.id, source: "mobile" }))
  kit.sql(`update public.time_clock_sessions set started_at = now() - interval '2 hours', work_date = '2026-09-14' where org_id=${q(w.orgId)} and worker_user_id=${q(w.actors.crew.userId)} and ended_at is null;`)
  await kit.as(w.actors.crew, () => app("time-clock").clockOut({}))
  const [entry] = kit.rows(`select id from public.time_entries where org_id=${q(w.orgId)} and project_id=${q(jobId)}`)
  const result = await kit.as(w.actors.foreman, () => app("timesheets").approveTimeEntries({ ids: [entry.id] }))
  const [after] = kit.rows(`select status from public.time_entries where id=${q(entry.id)}`)
  check.equal("a crew member clocks two hours on a job that has no cost-coded budget and the foreman approves them: nothing is refused and the entry is approved", spec.expected, {
    refused: result.failed.map((failure) => failure.error), status: after.status,
  })
  return { orgId: w.orgId, jobId }
}

module.exports = {
  id: "TRADE-TIME-01",
  subcases: {
    "crew-clock-across-three-jobs": crewClockAcrossThreeJobs,
    "foreman-bulk-approves-with-time-approve-only": foremanBulkApprovesWithTimeApproveOnly,
    "weekly-overtime-entry-is-auto-flagged": weeklyOvertimeEntryIsAutoFlagged,
    "time-on-a-job-without-a-budget-can-be-approved": timeOnAJobWithoutABudgetCanBeApproved,
    "admin-locks-the-period": adminLocksThePeriod,
    "payroll-csv-export": payrollCsvExport,
    "register-reconciles-in-books-payroll": registerReconcilesInBooksPayroll,
    "pay-period-summary-shows-the-books-import": payPeriodSummaryShowsTheBooksImport,
  },
}
