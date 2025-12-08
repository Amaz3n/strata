"use client"

type Props = {
  value: number
  className?: string
  currency?: string
  locale?: string
  maximumFractionDigits?: number
}

export function AnimatedNumber({
  value,
  className,
  currency = "USD",
  locale = "en-US",
  maximumFractionDigits = 2,
}: Props) {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits,
  })

  return <span className={className}>{formatter.format(value ?? 0)}</span>
}


