/**
 * The cash a community's land contracts call for, month by month.
 *
 * Pure: the org cash forecast, the community board and the land supply report
 * all read takedown cash through here, so they cannot disagree.
 *
 * - A takedown closes for its lot count times its price per lot, LESS the
 *   deposits tied to it: a deposit is credited against the takedown price at
 *   closing, so counting both would spend the same dollars twice. A deposit
 *   that was refunded or forfeited is no longer a credit.
 * - A deposit is cash out on its due date while it is still scheduled.
 * - An extension or penalty fee is cash out on its due date until its payment
 *   is recorded; callers pass only unpaid fees.
 * - Anything still owed but already overdue (takedown, deposit or fee) lands
 *   in the current month: it is owed now.
 * - Obligations of a terminated or completed contract are not passed in; the
 *   loader reads only draft and executed contracts.
 */

export type TakedownCashStatus = "scheduled" | "closed" | "cancelled"
export type LandDepositStatus = "scheduled" | "paid" | "applied" | "refunded" | "forfeited" | "cancelled"

export interface TakedownCashInput {
  id: string
  scheduledDate: string | null
  lotCount: number
  pricePerLotCents: number | null
  status: TakedownCashStatus
}

export interface LandDepositCashInput {
  takedownId: string | null
  dueOn: string
  amountCents: number
  status: LandDepositStatus
}

export interface LandFeeCashInput {
  dueOn: string | null
  feeCents: number
}

export interface LandObligationMonth {
  /** `YYYY-MM`. */
  month: string
  takedownCents: number
  depositCents: number
  feeCents: number
  totalCents: number
}

/** Deposits that still stand as a credit against the takedown they are tied to. */
const CREDITED_DEPOSIT_STATUSES: ReadonlySet<LandDepositStatus> = new Set(["scheduled", "paid", "applied"])

/** What a takedown costs at closing, and how much of that its deposits already cover. */
export function takedownCash(takedown: TakedownCashInput, deposits: readonly LandDepositCashInput[]) {
  const grossCents = takedown.lotCount * (takedown.pricePerLotCents ?? 0)
  const creditedDepositCents = deposits
    .filter((deposit) => deposit.takedownId === takedown.id && CREDITED_DEPOSIT_STATUSES.has(deposit.status))
    .reduce((sum, deposit) => sum + deposit.amountCents, 0)
  return {
    grossCents,
    creditedDepositCents,
    /** Never below zero: deposits beyond the price are the seller's to return, not cash in. */
    netCents: Math.max(0, grossCents - creditedDepositCents),
  }
}

function monthOf(date: string) {
  return date.slice(0, 7)
}

/** Month buckets of land cash out, sorted; months with nothing owed are absent. */
export function landObligationsByMonth(input: {
  takedowns: readonly TakedownCashInput[]
  deposits: readonly LandDepositCashInput[]
  fees: readonly LandFeeCashInput[]
  /** `YYYY-MM-DD`. */
  today: string
}): LandObligationMonth[] {
  const currentMonth = monthOf(input.today)
  const buckets = new Map<string, LandObligationMonth>()
  const bucket = (date: string) => {
    const month = monthOf(date) < currentMonth ? currentMonth : monthOf(date)
    const existing = buckets.get(month)
    if (existing) return existing
    const created = { month, takedownCents: 0, depositCents: 0, feeCents: 0, totalCents: 0 }
    buckets.set(month, created)
    return created
  }

  for (const takedown of input.takedowns) {
    if (takedown.status !== "scheduled" || !takedown.scheduledDate) continue
    const { netCents } = takedownCash(takedown, input.deposits)
    if (netCents > 0) bucket(takedown.scheduledDate).takedownCents += netCents
  }
  for (const deposit of input.deposits) {
    if (deposit.status !== "scheduled" || deposit.amountCents <= 0) continue
    bucket(deposit.dueOn).depositCents += deposit.amountCents
  }
  for (const fee of input.fees) {
    if (!fee.dueOn || fee.feeCents <= 0) continue
    bucket(fee.dueOn).feeCents += fee.feeCents
  }

  return Array.from(buckets.values())
    .map((row) => ({ ...row, totalCents: row.takedownCents + row.depositCents + row.feeCents }))
    .sort((left, right) => left.month.localeCompare(right.month))
}
