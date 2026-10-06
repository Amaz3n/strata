import type { LedgerTieOut } from "@/lib/services/books/verifier"

/** Missing evidence is a control failure, never a zero-balance success. */
export function requireLedgerTieOut(rows: LedgerTieOut[], code: LedgerTieOut["code"]): LedgerTieOut {
  const matches = rows.filter(row => row.code === code)
  if (matches.length !== 1) throw new Error(`Close requires exactly one ${code} result`)
  return matches[0]
}

export function retainageCloseChecks(rows: LedgerTieOut[]) {
  return (["retainage_receivable_control", "retainage_payable_control"] as const).map(code => {
    const result = requireLedgerTieOut(rows, code)
    return {
      code,
      label: result.label,
      category: "controls",
      blocking: true,
      status: result.status,
      issueCount: result.status === "failed" ? 1 : 0,
      href: "/reports/retainage",
      evidence: {
        ledger_cents: result.ledgerCents,
        subledger_cents: result.subledgerCents,
        difference_cents: result.differenceCents,
      },
    }
  })
}
