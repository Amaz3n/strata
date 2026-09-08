import { booksDigest } from "@/lib/services/books/hash"

export type ClearingBalance = { code: string; balanceCents: number }
export type ClearingSupport = { code: string; amountCents: number; expectedSettlementDate: string; explanation: string; evidenceUrl: string }

export function clearingSupportMatches(balances: ClearingBalance[], items: ClearingSupport[], periodEnd: string) {
  const expected = new Map(balances.filter(row => row.balanceCents !== 0).map(row => [row.code, row.balanceCents]))
  const supported = new Map<string, number>()
  for (const item of items) {
    if (!expected.has(item.code) || !Number.isSafeInteger(item.amountCents) || item.amountCents === 0 ||
      item.expectedSettlementDate <= periodEnd || item.explanation.trim().length < 10 || !/^https:\/\//.test(item.evidenceUrl)) return false
    supported.set(item.code, (supported.get(item.code) ?? 0) + item.amountCents)
  }
  return [...expected].every(([code, amount]) => supported.get(code) === amount)
}

export function clearingLedgerDigest(rows: Array<{ id: string; entry_id: string; account_id: string; debit_cents: number; credit_cents: number }>) {
  return booksDigest(rows.map(row => ({ id: row.id, entryId: row.entry_id, accountId: row.account_id, debitCents: row.debit_cents, creditCents: row.credit_cents })).sort((a, b) => a.id.localeCompare(b.id)))
}
