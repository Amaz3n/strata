/**
 * Pure math for the external mirror.
 *
 * The mirror's grain is the whole point of C3.5: one summarized journal per
 * period at account grain, not one push per source transaction. A CPA files
 * from a monthly summary they can tie to a trial balance; they cannot file from
 * a replay of a builder's operational history.
 */

export type MirrorLedgerLine = {
  accountId: string
  debitCents: number
  creditCents: number
}

export type MirrorAccount = {
  accountId: string
  code: string
  name: string
}

export type MirrorAccountMapping = {
  glAccountId: string
  externalAccountId: string
  externalAccountName: string | null
}

export type MirrorSummaryLine = {
  externalAccountId: string
  externalAccountName: string | null
  debitCents: number
  creditCents: number
  description: string
}

export type MirrorSummary =
  | { ok: true; lines: MirrorSummaryLine[]; totalDebitCents: number; totalCreditCents: number }
  | { ok: false; unmappedAccounts: MirrorAccount[]; unbalancedBy: number }

/**
 * Net each account's activity for the period, then map it to the external chart.
 *
 * Accounts are netted to a single debit-or-credit line rather than carried as
 * both: a mirror that restates gross activity per side is a dump again, one
 * level up. An account whose activity nets to zero is dropped entirely — it says
 * nothing and would only widen the entry.
 *
 * Fails as a whole rather than per line. A summary missing one mapped account
 * does not balance, and a journal that does not balance is worse in the external
 * system than no journal at all — it silently corrupts the CPA's trial balance
 * rather than telling anyone the mapping is incomplete.
 */
export function buildMirrorSummary(input: {
  lines: MirrorLedgerLine[]
  accounts: MirrorAccount[]
  mappings: MirrorAccountMapping[]
  periodLabel: string
}): MirrorSummary {
  const netByAccount = new Map<string, number>()
  for (const line of input.lines) {
    const net = Math.round(line.debitCents) - Math.round(line.creditCents)
    netByAccount.set(line.accountId, (netByAccount.get(line.accountId) ?? 0) + net)
  }

  const accountById = new Map(input.accounts.map((account) => [account.accountId, account]))
  const mappingByAccount = new Map(input.mappings.map((mapping) => [mapping.glAccountId, mapping]))

  const active = [...netByAccount.entries()].filter(([, net]) => net !== 0)
  const unmappedAccounts: MirrorAccount[] = []
  const summaryLines: MirrorSummaryLine[] = []

  // Sorted by account code so the same period always produces byte-identical
  // lines — the mirror has to be re-runnable without looking like a new entry.
  const ordered = active.sort(([leftId], [rightId]) => {
    const left = accountById.get(leftId)?.code ?? leftId
    const right = accountById.get(rightId)?.code ?? rightId
    return left.localeCompare(right)
  })

  for (const [accountId, net] of ordered) {
    const account = accountById.get(accountId) ?? { accountId, code: accountId, name: accountId }
    const mapping = mappingByAccount.get(accountId)
    if (!mapping) {
      unmappedAccounts.push(account)
      continue
    }
    summaryLines.push({
      externalAccountId: mapping.externalAccountId,
      externalAccountName: mapping.externalAccountName,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
      description: `${account.code} ${account.name} · ${input.periodLabel}`,
    })
  }

  const totalDebitCents = summaryLines.reduce((sum, line) => sum + line.debitCents, 0)
  const totalCreditCents = summaryLines.reduce((sum, line) => sum + line.creditCents, 0)

  if (unmappedAccounts.length > 0) {
    return { ok: false, unmappedAccounts, unbalancedBy: totalDebitCents - totalCreditCents }
  }
  if (totalDebitCents !== totalCreditCents) {
    return { ok: false, unmappedAccounts: [], unbalancedBy: totalDebitCents - totalCreditCents }
  }
  return { ok: true, lines: summaryLines, totalDebitCents, totalCreditCents }
}

/** Stable idempotency key: one mirrored summary per period per connection. */
export function mirrorReference(periodId: string, connectionId: string) {
  return `books_period_summary:${periodId}:${connectionId}`
}
