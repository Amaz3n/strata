export type QboIncomeAccountLike = {
  id: string
  name: string
  fullyQualifiedName?: string
}

export type RawQboAccountRow = {
  Id?: string
  Name?: string
  FullyQualifiedName?: string
}

export function mapQboAccountRows(rows?: RawQboAccountRow[] | null): QboIncomeAccountLike[] {
  return (rows ?? [])
    .filter((account) => Boolean(account.Id && account.Name))
    .map((account) => ({
      id: String(account.Id),
      name: String(account.Name),
      fullyQualifiedName: account.FullyQualifiedName ? String(account.FullyQualifiedName) : undefined,
    }))
}

export function dedupeAndSortQboAccounts(accounts: QboIncomeAccountLike[]): QboIncomeAccountLike[] {
  return Array.from(new Map(accounts.map((account) => [account.id, account])).values()).sort((a, b) =>
    (a.fullyQualifiedName ?? a.name).localeCompare(b.fullyQualifiedName ?? b.name),
  )
}

export function pickPreferredQboIncomeAccounts(params: {
  income: QboIncomeAccountLike[]
  otherIncome: QboIncomeAccountLike[]
  revenueFallback: QboIncomeAccountLike[]
}): QboIncomeAccountLike[] {
  const merged = dedupeAndSortQboAccounts([...params.income, ...params.otherIncome])
  if (merged.length > 0) return merged
  return dedupeAndSortQboAccounts(params.revenueFallback)
}
