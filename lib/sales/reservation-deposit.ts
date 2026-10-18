import { parseMoneyToCents } from "@/lib/financials/money-input"

/** Matches the invoice total and invoice-line unit-price integer columns. */
export const MAX_RESERVATION_DEPOSIT_CENTS = 2_147_483_647

export function parseReservationDeposit(value: string): number | null {
  if (!value.trim()) return null
  const cents = parseMoneyToCents(value)
  return cents !== null && cents >= 0 && cents <= MAX_RESERVATION_DEPOSIT_CENTS ? cents : null
}

export function reservationDepositInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}
