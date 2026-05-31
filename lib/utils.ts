import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Whole-dollar USD from cents with grouping and no decimals, e.g. 125000000 -> "$1,250,000".
 * Used for pipeline value displays (funnel, table, prospect rows).
 */
export function formatMoneyCents(cents?: number | null): string {
  const dollars = Math.round((cents ?? 0) / 100)
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

export function formatPhone(phone?: string | null): string {
  if (!phone) return ""
  const digits = phone.replace(/\D/g, "")
  if (digits.length === 10) {
    const [, area, mid, last] = digits.match(/(\d{3})(\d{3})(\d{4})/) || []
    if (area && mid && last) return `(${area}) ${mid}-${last}`
  } else if (digits.length === 11 && digits.startsWith("1")) {
    const [, area, mid, last] = digits.substring(1).match(/(\d{3})(\d{3})(\d{4})/) || []
    if (area && mid && last) return `(${area}) ${mid}-${last}`
  }
  return phone
}
