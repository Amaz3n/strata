import { parseMoneyToCents } from "@/lib/financials/money-input"

/**
 * Reading a trial balance someone pasted out of the system they are leaving.
 *
 * Pure and tested, for the same reason `money-input.ts` is: this is the one-time
 * act of telling Arc what the business was worth, and a parser that quietly reads
 * an unreadable amount as zero would open the books on a wrong number that
 * balances.
 */

export type TrialBalanceAccount = {
  id: string
  code: string
  name: string
  account_type: string
  active: boolean
}

export type ParsedTrialBalanceRow = {
  key: string
  /** Exactly as it appeared in the pasted trial balance, for the audit trail. */
  sourceLabel: string
  accountCode: string
  debitCents: number
  creditCents: number
  /** Set when the pasted amounts could not be read, so nothing is silently zero. */
  problem: string | null
}

/**
 * Cell separators: tab, semicolon, two-or-more spaces, or a comma that is not a
 * thousands separator.
 *
 * The comma case is the whole difficulty. A CSV export uses commas to separate
 * cells, and an accounting system writes `125,000.00` inside one — so splitting
 * on every comma turns one amount into two cells and silently halves the balance.
 * A comma preceded by a digit and followed by exactly three digits then a
 * non-digit is part of a number; anything else separates.
 *
 * `1000,100` stays genuinely ambiguous (code plus amount, or one million?) and is
 * read as a number. Column-aligned and tab-separated exports, which are what
 * QuickBooks and Sage actually produce, avoid the question entirely.
 */
const SEPARATORS = /\t|;|\s{2,}|(?<!\d),|,(?!\d{3}(?:\D|$))/

/**
 * Parse a pasted trial balance.
 *
 * Deliberately forgiving about shape — every accounting system exports a slightly
 * different one — and deliberately strict about money: an unreadable amount is
 * reported, never treated as zero. A row whose debit and credit both fail to
 * parse is the difference between a balanced batch and a wrong one.
 */
export function parseTrialBalance(text: string, accounts: TrialBalanceAccount[]): ParsedTrialBalanceRow[] {
  const byCode = new Map(accounts.map((account) => [account.code.trim().toLowerCase(), account]))
  const byName = new Map(accounts.map((account) => [account.name.trim().toLowerCase(), account]))

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const cells = line.split(SEPARATORS).map((cell) => cell.trim()).filter(Boolean)
      const key = `row-${index}`
      if (cells.length < 2) {
        return { key, sourceLabel: line, accountCode: "", debitCents: 0, creditCents: 0, problem: "Could not read this line" }
      }

      // Money is read from the right: the last two numeric-looking cells are
      // debit and credit, and a single trailing amount is a signed balance.
      const amounts: Array<{ index: number; cents: number | null }> = []
      for (let i = cells.length - 1; i >= 0 && amounts.length < 2; i -= 1) {
        const cents = parseMoneyToCents(cells[i])
        if (cells[i] === "" ) continue
        if (cents === null && !/[\d.]/.test(cells[i])) break
        amounts.unshift({ index: i, cents })
      }
      if (amounts.length === 0) {
        return { key, sourceLabel: line, accountCode: "", debitCents: 0, creditCents: 0, problem: "No amount found" }
      }
      if (amounts.some((amount) => amount.cents === null)) {
        return { key, sourceLabel: line, accountCode: "", debitCents: 0, creditCents: 0, problem: "Amount could not be read" }
      }

      const label = cells.slice(0, amounts[0].index).join(" ").trim() || cells[0]
      let debitCents = 0
      let creditCents = 0
      if (amounts.length === 2) {
        debitCents = Math.max(0, amounts[0].cents ?? 0)
        creditCents = Math.max(0, amounts[1].cents ?? 0)
      } else {
        const signed = amounts[0].cents ?? 0
        if (signed >= 0) debitCents = signed
        else creditCents = Math.abs(signed)
      }

      // Match on the leading code first, then the whole label as a name.
      const leading = label.split(/[\s·:-]+/)[0]?.trim().toLowerCase() ?? ""
      const matched = byCode.get(leading) ?? byName.get(label.trim().toLowerCase())

      return {
        key,
        sourceLabel: label,
        accountCode: matched?.code ?? "",
        debitCents,
        creditCents,
        problem: null,
      }
    })
}
