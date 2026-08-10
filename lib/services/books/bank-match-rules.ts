/**
 * Deciding which ledger line a bank transaction is.
 *
 * Pure, no I/O, no clock — the same doctrine as `books/cash-flow-rules.ts` and
 * `books/cash-basis-rules.ts`. Bank reconciliation is a matching problem, and a
 * matching rule that cannot be tested without a database does not get tested.
 */

export type BankMatchCandidate = {
  bankTransactionId: string
  journalLineId: string
  bankDate: string
  journalDate: string
  amountCents: number
  counterparty?: string | null
  journalDescription?: string | null
  providerIdentityMatch?: boolean
}

function dateDistanceDays(left: string, right: string) {
  return Math.abs(new Date(`${left}T00:00:00Z`).getTime() - new Date(`${right}T00:00:00Z`).getTime()) / 86_400_000
}

export function scoreBankMatch(candidate: BankMatchCandidate) {
  const days = dateDistanceDays(candidate.bankDate, candidate.journalDate)
  let confidence = candidate.providerIdentityMatch ? 1 : 0.7
  if (!candidate.providerIdentityMatch) {
    if (days === 0) confidence += 0.15
    else if (days <= 2) confidence += 0.1
    else if (days <= 7) confidence += 0.03
    else confidence -= 0.25
    const left = candidate.counterparty?.trim().toLowerCase()
    const right = candidate.journalDescription?.trim().toLowerCase()
    if (left && right && (right.includes(left) || left.includes(right))) confidence += 0.1
  }
  return Math.max(0, Math.min(1, Math.round(confidence * 10000) / 10000))
}

export type BankMatchSuggestion = BankMatchCandidate & { confidence: number }

/** The window a bank line and a ledger line may be apart and still be the same event. */
export const MATCH_WINDOW_DAYS = 10

/**
 * Rank the ledger lines that could be this bank transaction, best first.
 *
 * Pure, so the matching rule can be tested without a database — it decides which
 * ledger line a payment is, which is the whole of bank reconciliation.
 *
 * An inflow is money arriving, so it can only be a debit to the cash account; an
 * outflow can only be a credit. Lines already confirmed against another
 * transaction are excluded, or the tray would offer the same line twice.
 */
export function rankBankMatches(input: {
  transaction: {
    id: string
    date: string
    amountCents: number
    direction: "inflow" | "outflow"
    counterparty?: string | null
  }
  candidates: Array<{
    id: string
    debitCents: number
    creditCents: number
    description: string | null
    entryDate: string
  }>
  excludeLineIds?: ReadonlySet<string>
}): BankMatchSuggestion[] {
  const { transaction } = input
  return input.candidates
    .filter((candidate) => {
      if (input.excludeLineIds?.has(candidate.id)) return false
      const amount = transaction.direction === "inflow" ? candidate.debitCents : candidate.creditCents
      if (amount !== transaction.amountCents) return false
      return dateDistanceDays(transaction.date, candidate.entryDate) <= MATCH_WINDOW_DAYS
    })
    .map((candidate) => {
      const match: BankMatchCandidate = {
        bankTransactionId: transaction.id,
        journalLineId: candidate.id,
        bankDate: transaction.date,
        journalDate: candidate.entryDate,
        amountCents: transaction.amountCents,
        counterparty: transaction.counterparty,
        journalDescription: candidate.description,
      }
      return { ...match, confidence: scoreBankMatch(match) }
    })
    .sort((left, right) => right.confidence - left.confidence)
}
