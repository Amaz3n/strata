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

/** A company the organization keeps books for (`books_legal_entities`). */
export type BooksCompany = { id: string; name: string; isPrimary: boolean }

/** One company's side of a tie-out: its own ledger against its own subledger. */
export type CompanyTieOut = {
  legalEntityId: string
  name: string
  status: "passed" | "failed"
  ledgerCents: number
  subledgerCents: number
  differenceCents: number
  exceptions?: unknown[]
}

/**
 * Which company a subledger record belongs to, by the posting function's rule
 * (`post_books_journal_entry`, docs/books-entities.md): a company's own account
 * decides; cash, undeposited funds and cards nobody owns are the primary
 * company's; otherwise the job's company, and the primary company when the job
 * names none or there is no job. The subledger side of every per-company
 * tie-out is attributed through this one rule, so a document and its posting
 * can only disagree when the ledger was written some other way.
 */
export function expectedOwner(
  input: { accountOwner?: string | null; cashAccount?: boolean; projectOwner?: string | null },
  primaryId: string,
): string {
  if (input.accountOwner) return input.accountOwner
  if (input.cashAccount) return primaryId
  return input.projectOwner ?? primaryId
}

/** Adds `cents` under `key`. */
export function addTo(totals: Map<string, number>, key: string, cents: number) {
  totals.set(key, (totals.get(key) ?? 0) + cents)
  return totals
}

/**
 * Each company's ledger against its subledger. Every company appears, so one with
 * no activity reads as tied rather than missing, and an owner the register does
 * not know is still reported (by id) rather than dropped.
 */
export function tieByCompany(
  companies: BooksCompany[],
  ledger: ReadonlyMap<string, number>,
  subledger: ReadonlyMap<string, number>,
  exceptions: ReadonlyMap<string, unknown[]> = new Map(),
): CompanyTieOut[] {
  const ids = [...new Set([...companies.map(company => company.id), ...ledger.keys(), ...subledger.keys(), ...exceptions.keys()])]
  const names = new Map(companies.map(company => [company.id, company.name]))
  return ids.map(id => {
    const ledgerCents = ledger.get(id) ?? 0
    const subledgerCents = subledger.get(id) ?? 0
    const found = exceptions.get(id) ?? []
    return {
      legalEntityId: id,
      name: names.get(id) ?? id,
      status: ledgerCents === subledgerCents && found.length === 0 ? "passed" : "failed",
      ledgerCents,
      subledgerCents,
      differenceCents: ledgerCents - subledgerCents,
      ...(found.length ? { exceptions: found } : {}),
    }
  })
}

/**
 * The org-wide control, also held to each company. With more than one company a
 * company out of balance fails the control even when the companies' differences
 * cancel in the org total. A single-company organization is left exactly as the
 * org-wide control found it: its one company IS the org.
 */
export function withCompanies(tieOut: LedgerTieOut, companies: BooksCompany[], rows: CompanyTieOut[]): LedgerTieOut {
  if (companies.length < 2) return tieOut
  return {
    ...tieOut,
    status: tieOut.status === "failed" || rows.some(row => row.status === "failed") ? "failed" : "passed",
    companies: rows,
  }
}

/**
 * A tie-out as a blocking close check. Per-company results ride in the evidence,
 * and the companies out of balance are named, so the person closing knows which
 * company's books to open.
 */
export function tieOutCloseCheck(result: LedgerTieOut, options: { href?: string; applicable?: boolean } = {}) {
  const outOfBalance = (result.companies ?? []).filter(company => company.status === "failed")
  return {
    code: result.code,
    label: result.label,
    category: "controls",
    blocking: true,
    status: result.status,
    issueCount: result.status === "failed" ? Math.max(1, result.exceptions?.length ?? 0, outOfBalance.length) : 0,
    ...(options.href ? { href: options.href } : {}),
    evidence: {
      ...(options.applicable === false ? { applicable: false } : {}),
      ledger_cents: result.ledgerCents,
      subledger_cents: result.subledgerCents,
      difference_cents: result.differenceCents,
      ...(result.exceptions?.length ? { exceptions: result.exceptions } : {}),
      ...(result.rows ? { rows: result.rows } : {}),
      ...(result.companies
        ? {
            companies: result.companies.map(company => ({
              legal_entity_id: company.legalEntityId,
              name: company.name,
              status: company.status,
              ledger_cents: company.ledgerCents,
              subledger_cents: company.subledgerCents,
              difference_cents: company.differenceCents,
              ...(company.exceptions ? { exceptions: company.exceptions } : {}),
            })),
            out_of_balance_companies: outOfBalance.map(company => company.name),
          }
        : {}),
    },
  }
}

/** An amount on one company's books. */
export type CompanyBalance = { legalEntityId: string; cents: number }

/** Per-company ledger, subledger and the rows that disagree, ready for `tieByCompany`. */
export type CompanyPosition = {
  ledger: Map<string, number>
  subledger: Map<string, number>
  exceptions: Map<string, unknown[]>
}

function position(): CompanyPosition {
  return { ledger: new Map(), subledger: new Map(), exceptions: new Map() }
}

function except(target: CompanyPosition, company: string, row: unknown) {
  target.exceptions.set(company, [...(target.exceptions.get(company) ?? []), row])
}

/**
 * The company a lot's land basis belongs to: the owner of the land account when
 * a company owns it; otherwise the one company carrying the lot (an opening
 * batch or a purchase in that company's name); otherwise, with nothing posted or
 * the basis split between companies, the primary company. A split lot is then
 * out of balance in every company carrying part of it.
 */
export function landHolder(lot: { ledger: CompanyBalance[] }, landAccountOwner: string | null, primaryId: string): string {
  if (landAccountOwner) return landAccountOwner
  const carrying = lot.ledger.filter(held => held.cents !== 0)
  return carrying.length === 1 ? carrying[0].legalEntityId : primaryId
}

/** Land lot by lot, per company: each lot's basis on its holder's books and nowhere else. */
export function landByCompany(
  lots: { lotId: string | null; lotNumber: string | null; basisCents: number; ledger: CompanyBalance[] }[],
  landAccountOwner: string | null,
  primaryId: string,
): CompanyPosition {
  const result = position()
  for (const lot of lots) {
    const holder = landHolder(lot, landAccountOwner, primaryId)
    addTo(result.subledger, holder, lot.basisCents)
    for (const held of lot.ledger) addTo(result.ledger, held.legalEntityId, held.cents)
    for (const company of new Set([holder, ...lot.ledger.map(held => held.legalEntityId)])) {
      const ledgerCents = lot.ledger.filter(held => held.legalEntityId === company).reduce((sum, held) => sum + held.cents, 0)
      const basisCents = company === holder ? lot.basisCents : 0
      if (ledgerCents !== basisCents) except(result, company, { lotId: lot.lotId, lotNumber: lot.lotNumber, ledgerCents, basisCents })
    }
  }
  return result
}

/**
 * Completed homes per company: a home held for sale is carried whole on its
 * owner's books, and nothing else carries a completed-home balance.
 */
export function completedHomesByCompany(
  homes: { projectId: string | null; held: boolean; owner: string; ledger: CompanyBalance[] }[],
): CompanyPosition {
  const result = position()
  for (const home of homes) {
    const totalCents = home.ledger.reduce((sum, held) => sum + held.cents, 0)
    for (const held of home.ledger) addTo(result.ledger, held.legalEntityId, held.cents)
    if (home.held) addTo(result.subledger, home.owner, totalCents)
    for (const company of new Set([...(home.held ? [home.owner] : []), ...home.ledger.map(held => held.legalEntityId)])) {
      const cents = home.ledger.filter(held => held.legalEntityId === company).reduce((sum, held) => sum + held.cents, 0)
      const expectedCents = home.held && company === home.owner ? totalCents : 0
      if (cents !== expectedCents) except(result, company, { projectId: home.projectId, held: home.held, cents, expectedCents })
    }
  }
  return result
}

/**
 * Cash per company: a cash, undeposited-funds or card account is its owner's
 * money, so a balance on it in any other company's books is out of place.
 */
export function cashByCompany(accounts: { accountId: string; code: string; owner: string; ledger: CompanyBalance[] }[]): CompanyPosition {
  const result = position()
  for (const account of accounts) {
    for (const held of account.ledger) {
      if (held.cents === 0) continue
      addTo(result.ledger, held.legalEntityId, held.cents)
      addTo(result.subledger, account.owner, held.cents)
      if (held.legalEntityId !== account.owner) except(result, held.legalEntityId, { accountId: account.accountId, code: account.code, cents: held.cents })
    }
  }
  return result
}
