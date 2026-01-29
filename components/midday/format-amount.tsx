"use client"

type Props = {
  amount: number
  currency?: string
  locale?: string
  maximumFractionDigits?: number
}

type FormatAmountOptions = {
  amount: number
  currency?: string
  locale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  signDisplay?: "auto" | "never" | "always" | "exceptZero"
}

/**
 * Formats an amount as a currency string
 */
export function formatAmount({
  amount,
  currency = "USD",
  locale = "en-US",
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  signDisplay = "auto",
}: FormatAmountOptions): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits,
    signDisplay,
  })
  return formatter.format(amount ?? 0)
}

export function FormatAmount({ amount, currency = "USD", locale = "en-US", maximumFractionDigits = 2 }: Props) {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits,
  })
  return <span>{formatter.format(amount ?? 0)}</span>
}







