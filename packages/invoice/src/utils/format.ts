export function formatAmount(amount?: number | null, currency = "USD", locale = "en-US", includeDecimals = true) {
  const value = typeof amount === "number" ? amount : 0
  const minimumFractionDigits = includeDecimals ? 2 : 0
  const maximumFractionDigits = includeDecimals ? 2 : 0

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(value)
  } catch {
    // Fallback simple formatter
    const fixed = value.toFixed(includeDecimals ? 2 : 0)
    return `${currency} ${fixed}`
  }
}
