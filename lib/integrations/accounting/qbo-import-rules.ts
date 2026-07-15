export function qboImportCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100)
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed * 100)
  }
  return 0
}

export async function collectPaginatedRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  options: { pageSize?: number; label?: string } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, options.pageSize ?? 1000)
  const rows: T[] = []

  while (true) {
    const from = rows.length
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${options.label ?? "paginated rows"}: ${error.message}`)

    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export function qboVendorCreditCents(value: unknown): number {
  return -Math.abs(qboImportCents(value))
}

export function qboPurchaseIsCredit(purchase: any): boolean {
  if (purchase?.Credit === true) return true
  if (String(purchase?.Credit ?? "").toLowerCase() === "true") return true
  if (qboImportCents(purchase?.TotalAmt) < 0) return true
  const lineAmounts = ((purchase?.Line ?? []) as any[])
    .map((line) => qboImportCents(line?.Amount))
    .filter((amount) => amount !== 0)
  return lineAmounts.length > 0 && lineAmounts.every((amount) => amount < 0)
}

export function qboPurchaseCreditCents(value: unknown): number {
  return -Math.abs(qboImportCents(value))
}

export function qboJournalEntryLineAmounts(
  value: unknown,
  postingType: unknown,
): { storedCents: number; signedCents: number } {
  const storedCents = Math.abs(qboImportCents(value))
  const isCredit = String(postingType ?? "").toLowerCase() === "credit"
  return {
    storedCents,
    signedCents: storedCents * (isCredit ? -1 : 1),
  }
}

export function qboImportedExpenseCostCents(input: {
  amountCents: unknown
  taxCents?: unknown
  metadata?: { source?: unknown; qbo_signed_amount_cents?: unknown } | null
}): number {
  const source = String(input.metadata?.source ?? "")
  const signedAmountValue = input.metadata?.qbo_signed_amount_cents
  const signedAmount = Number(signedAmountValue)
  if (source === "journal_entry" && signedAmountValue != null && Number.isFinite(signedAmount)) {
    return Math.round(signedAmount)
  }

  const storedTotal = Math.round(Number(input.amountCents ?? 0) + Number(input.taxCents ?? 0))
  return source.startsWith("expense_credit") ? -Math.abs(storedTotal) : storedTotal
}

export function extractLinkedQboIds(transaction: any, txnType: "invoice" | "bill"): string[] {
  const ids = new Set<string>()
  for (const line of (transaction?.Line ?? []) as any[]) {
    for (const linked of (line?.LinkedTxn ?? []) as any[]) {
      if (String(linked?.TxnType ?? "").toLowerCase() !== txnType) continue
      if (linked?.TxnId) ids.add(String(linked.TxnId))
    }
  }
  return Array.from(ids)
}

export function extractLinkedQboAmounts(
  transaction: any,
  txnType: "invoice" | "bill" | "vendorcredit",
): { qboId: string; amountCents: number }[] {
  const byId = new Map<string, number>()
  for (const line of (transaction?.Line ?? []) as any[]) {
    for (const linked of (line?.LinkedTxn ?? []) as any[]) {
      if (String(linked?.TxnType ?? "").toLowerCase() !== txnType) continue
      if (!linked?.TxnId) continue
      const id = String(linked.TxnId)
      byId.set(id, (byId.get(id) ?? 0) + qboImportCents(line?.Amount))
    }
  }
  return Array.from(byId, ([qboId, amountCents]) => ({ qboId, amountCents }))
}

export function qboImportProviderPaymentId(params: {
  kind: "payment" | "billpayment"
  qboId: string
  split: boolean
  lineId: string
  vendorCredit?: boolean
}): string {
  const prefix = params.kind === "payment" ? "qbo_payment" : "qbo_billpayment"
  const suffix = params.split ? `_${params.lineId}` : ""
  return `${prefix}_${params.qboId}${suffix}${params.vendorCredit ? "_vc" : ""}`
}

export function isUsableQboPaymentMapping(
  row: { entity_type?: string | null; entity_id?: string | null; status?: string | null },
  paymentIds: ReadonlySet<string>,
): boolean {
  if (row.entity_type !== "payment" && row.entity_type !== "bill_payment") return false
  if (!row.entity_id || !paymentIds.has(String(row.entity_id))) return false
  return row.status !== "error" && row.status !== "conflict"
}
