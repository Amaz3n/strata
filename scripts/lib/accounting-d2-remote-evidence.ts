type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {} }
function id(value: unknown): string | null { return typeof value === "string" && value.length ? value : null }
/** Whitelist export fields: no names, notes, raw HTTP bodies or credentials. */
export function inspectRemoteTransaction(transaction: unknown) {
  const source = object(transaction)
  const lines = Array.isArray(source.Line) ? source.Line : []
  return {
    externalId: id(source.Id), externalVersion: id(source.SyncToken), updatedAt: id(object(source.MetaData).LastUpdatedTime),
    totalAmount: typeof source.TotalAmt === "number" ? source.TotalAmt : null,
    lines: lines.map(raw => {
      const line = object(raw)
      const account = object(line.AccountBasedExpenseLineDetail)
      const item = object(line.ItemBasedExpenseLineDetail)
      return { lineId: id(line.Id), detailType: id(line.DetailType), amount: typeof line.Amount === "number" ? line.Amount : null,
        accountId: id(object(account.AccountRef).value), itemId: id(object(item.ItemRef).value),
        classId: id(object(account.ClassRef ?? item.ClassRef).value), customerId: id(object(account.CustomerRef ?? item.CustomerRef).value) }
    }),
    complete: Array.isArray(source.Line) && !!id(source.Id) && !!id(source.SyncToken),
  }
}
export function classifyRemoteAccounts(neutral: string, legacy: string, accounts: Iterable<string>) {
  const ids = new Set(accounts)
  return ids.has(neutral) && ids.has(legacy) ? "contains_both" : ids.has(neutral) ? "matches_neutral_only" : ids.has(legacy) ? "matches_legacy_only" : "matches_neither"
}
