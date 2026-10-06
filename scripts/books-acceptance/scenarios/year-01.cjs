// YEAR-01 — fiscal year end on a noncalendar year through the product's
// services: opening batch, custom accounts, accountant journals, period close
// (which posts the retained-earnings transfer), reopen and reclose.
const { app, greenfieldOrg } = require("./shared.cjs")

const START_MONTH = 4

function openingLines(opening) {
  return [
    { accountCode: "1060", description: "Opening funds held in escrow", debitCents: opening.cash, creditCents: 0 },
    { accountCode: "3010", description: "Opening owner contributions", debitCents: 0, creditCents: opening.ownerContributions },
    { accountCode: "3100", description: "Opening retained earnings", debitCents: 0, creditCents: opening.retainedEarnings },
  ]
}

function months(first, count) {
  const [year, month] = first.split("-").map(Number)
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1 + offset, 1))
    return date.toISOString().slice(0, 7)
  })
}

function yearOrg(kit, name, opening, periods) {
  const custom = require("../expected/YEAR-01.json").subcases["noncalendar-year-closes-to-retained-earnings"].inputs.customAccounts
  const accounts = custom.map((account) => ({ ...account, normalBalance: ["income", "liability", "equity"].includes(account.accountType) ? "credit" : "debit" }))
  return greenfieldOrg(kit, { name, periods, fiscalYearStartMonth: START_MONTH, accounts, opening: openingLines(opening) })
}

function journal(kit, org, entry, memo = "Accountant journal for the YEAR-01 fixture") {
  const { createAdjustingJournal } = app("books/bookkeeping")
  return kit.as(org.reviewer, () => createAdjustingJournal({ entryDate: entry.date, memo: `${memo} (${entry.date})`, lines: [
    { accountCode: entry.debit, debitCents: entry.cents, creditCents: 0, description: memo },
    { accountCode: entry.credit, debitCents: 0, creditCents: entry.cents, description: memo },
  ] }))
}

const close = (kit, org, period) => kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods[period].periodId))
const reopen = (kit, org, period, reason) => kit.as(org.owner, () => app("books/period-close").reopenAccountingPeriod({ periodId: org.periods[period].periodId, reason }))

function yearEndEntries(kit, org) {
  return kit.rows(`select id, entry_date::text, entry_kind from public.journal_entries where org_id=${kit.q(org.orgId)} and source_type='year_end_close' and status in ('posted','reversed') order by created_at`)
}

function entryNet(kit, org, entryId) {
  return kit.postedNet(org.orgId, `e.id=${kit.q(entryId)}`)
}

const netIncome = (kit, org, start, end) => kit.service(() => app("books/statements").buildProfitAndLoss(org.orgId, start, end)).then((pl) => pl.netIncomeCents)
const balanceSheet = (kit, org, asOf) => kit.service(() => app("books/statements").buildBalanceSheet(org.orgId, asOf))

async function noncalendarYear(kit, expected, check) {
  const input = expected.inputs
  const periods = months(input.fiscalYear.start, 12)
  const org = await yearOrg(kit, "YEAR-01 noncalendar year", input.opening, periods)
  for (const entry of input.journals) await journal(kit, org, entry)
  for (const period of periods.slice(0, 11)) await close(kit, org, period)
  check.equal("closing fiscal periods 1–11 posts no year-end entry", expected.expectedYearEndEntriesBeforeFinalPeriod, yearEndEntries(kit, org).length)
  await close(kit, org, periods[11])
  const entries = yearEndEntries(kit, org)
  check.equal("one year-end entry for the fiscal year", expected.expectedYearEndEntries, entries.length)
  check.equal("year-end entry dated the fiscal year end", input.fiscalYear.end, entries[0]?.entry_date)
  check.equal("year-end entry closes every income-statement account, custom ones included, to 3100", expected.expectedYearEndLines, entries[0] ? entryNet(kit, org, entries[0].id) : {})
  check.equal("the closed year's P&L still reports its earnings", expected.expectedFiscalYearNetIncomeCents, await netIncome(kit, org, input.fiscalYear.start, input.fiscalYear.end))
  check.equal("ledger after year end: RE = opening + net income; distributions stay open", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  check.equal("balance sheet balances at year end", expected.expectedBalanceSheetDifferenceCents, (await balanceSheet(kit, org, input.fiscalYear.end)).differenceCents)
  return { orgId: org.orgId }
}

async function lateAdjustment(kit, expected, check) {
  const input = expected.inputs
  const org = await yearOrg(kit, "YEAR-01 late adjustment", input.opening, ["2026-03", "2026-04"])
  for (const entry of input.journals) await journal(kit, org, entry)
  await close(kit, org, "2026-03")
  let accountantRefused = false
  try { await kit.as(org.reviewer, () => app("books/period-close").reopenAccountingPeriod({ periodId: org.periods["2026-03"].periodId, reason: "Accountant without reopen permission" })) } catch { accountantRefused = true }
  check.equal("an accountant without books.reopen is refused by the server", true, accountantRefused)
  await reopen(kit, org, "2026-03", "Late March software invoice found after year end")
  await journal(kit, org, input.lateAdjustment, "Late prior-year expense")
  await close(kit, org, "2026-03")
  const entries = yearEndEntries(kit, org)
  check.equal("reclose posts only the residual change", expected.expectedRecloseDeltaLines, entries[1] ? entryNet(kit, org, entries[1].id) : {})
  await reopen(kit, org, "2026-03", "Review reopen with no change to the year")
  await close(kit, org, "2026-03")
  check.equal("a reopen and reclose with nothing changed posts nothing", expected.expectedYearEndEntries, yearEndEntries(kit, org).length)
  await journal(kit, org, input.nextYear, "Next fiscal year income")
  await close(kit, org, "2026-04")
  check.equal("closing fiscal 2026 period 1 posts no year-end entry", expected.expectedYearEndEntries, yearEndEntries(kit, org).length)
  check.equal("fiscal 2025 P&L includes the late adjustment", expected.expectedFiscal2025NetIncomeCents, await netIncome(kit, org, "2025-04-01", "2026-03-31"))
  check.equal("fiscal 2026 P&L holds only next-year activity", expected.expectedFiscal2026NetIncomeCents, await netIncome(kit, org, "2026-04-01", "2026-04-30"))
  check.equal("ledger after reclose and next-year activity", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  const sheet = await balanceSheet(kit, org, "2026-04-30")
  check.equal("balance sheet: current earnings are fiscal 2026 only, and it balances", expected.expectedBalanceSheet, { currentEarningsCents: sheet.currentEarningsCents, differenceCents: sheet.differenceCents })
  return { orgId: org.orgId }
}

async function breakEvenYear(kit, expected, check) {
  const input = expected.inputs
  const org = await yearOrg(kit, "YEAR-01 break-even year", input.opening, ["2026-03"])
  for (const entry of input.journals) await journal(kit, org, entry)
  await close(kit, org, "2026-03")
  const entries = yearEndEntries(kit, org)
  check.equal("break-even year still closes income and expense", expected.expectedYearEndEntries, entries.length)
  check.equal("break-even year-end entry has no retained-earnings line", expected.expectedYearEndLines, entries[0] ? entryNet(kit, org, entries[0].id) : {})
  check.equal("retained earnings unchanged", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

async function noActivityYear(kit, expected, check) {
  const org = await yearOrg(kit, "YEAR-01 no activity", expected.inputs.opening, ["2026-03"])
  await close(kit, org, "2026-03")
  check.equal("no year-end entry without income-statement balances", expected.expectedYearEndEntries, yearEndEntries(kit, org).length)
  check.equal("opening position unchanged", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

module.exports = {
  id: "YEAR-01",
  subcases: {
    "noncalendar-year-closes-to-retained-earnings": noncalendarYear,
    "late-adjustment-reopen-reclose-and-next-year": lateAdjustment,
    "break-even-year": breakEvenYear,
    "no-activity-year": noActivityYear,
  },
}

function closedYearIncomeStatement(kit, org, start, end) {
  return Number(kit.rows(`select coalesce(sum(l.debit_cents - l.credit_cents),0)::bigint net from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(org.orgId)} and e.status in ('posted','reversed') and a.account_type in ('income','cogs','expense')
      and e.entry_date between ${kit.q(start)} and ${kit.q(end)}`)[0].net)
}

async function lateAdjustmentInEarlierPeriod(kit, expected, check) {
  const input = expected.inputs
  const org = await yearOrg(kit, "YEAR-01 earlier-period adjustment", input.opening, ["2026-02", "2026-03"])
  for (const entry of input.journals) await journal(kit, org, entry)
  await close(kit, org, "2026-02")
  await close(kit, org, "2026-03")
  // The accountant's natural path is to reopen the month the expense belongs
  // to; periods reopen newest first, so the year end must be reopened before it.
  let refusedOutOfOrder = false
  try {
    await reopen(kit, org, "2026-02", "Missed February software invoice after year end")
  } catch {
    refusedOutOfOrder = true
  }
  check.equal("reopening February while the year end is closed is refused", expected.expectedOutOfOrderReopenRefused, refusedOutOfOrder)
  await reopen(kit, org, "2026-03", "Reopen the year end to correct February")
  await reopen(kit, org, "2026-02", "Missed February software invoice after year end")
  await journal(kit, org, input.lateAdjustment, "Late February expense")
  await close(kit, org, "2026-02")
  await close(kit, org, "2026-03")
  const statuses = kit.rows(`select status from public.accounting_periods where org_id=${kit.q(org.orgId)}`).map((row) => row.status)
  check.equal("every period is closed again", true, statuses.every((status) => status === "closed"))
  check.equal("the closed year carries no income-statement balance", expected.expectedClosedYearIncomeStatementCents, closedYearIncomeStatement(kit, org, "2025-04-01", "2026-03-31"))
  check.equal("RE = opening + corrected net income", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

module.exports.subcases["late-adjustment-in-earlier-closed-period"] = lateAdjustmentInEarlierPeriod

// The same year-end intent twice at once — the transfer itself, then the final
// period's close — must leave exactly one closing entry.
async function sameIntentRetry(kit, expected, check) {
  const input = expected.inputs
  const org = await yearOrg(kit, "YEAR-01 same-intent retry", input.opening, ["2026-03"])
  for (const entry of input.journals) await journal(kit, org, entry)
  const { closeFiscalYearToRetainedEarnings } = app("books/period-close")
  const transfer = () => kit.as(org.owner, () => closeFiscalYearToRetainedEarnings(org.periods["2026-03"].periodId))
  await Promise.allSettled([transfer(), transfer()])
  await Promise.allSettled([close(kit, org, "2026-03"), close(kit, org, "2026-03")])
  check.equal("the final period is closed", "closed", kit.rows(`select status from public.accounting_periods where id=${kit.q(org.periods["2026-03"].periodId)}`)[0].status)
  check.equal("one year-end entry for one intent", expected.expectedYearEndEntries, yearEndEntries(kit, org).length)
  check.equal("RE = opening + net income", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId }
}

module.exports.subcases["same-intent-retry"] = sameIntentRetry
