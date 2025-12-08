"use client"

type Props = {
  amount: number
  currency?: string
  locale?: string
  maximumFractionDigits?: number
}

export function FormatAmount({ amount, currency = "USD", locale = "en-US", maximumFractionDigits = 2 }: Props) {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits,
  })
  return <span>{formatter.format(amount ?? 0)}</span>
}



