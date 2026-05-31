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

/**
 * Parses a date string representing a date-only value (e.g. "YYYY-MM-DD")
 * into a Date object representing that same date in the local timezone.
 * This prevents timezone shifts where a date is displayed as the day before.
 */
export function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null
  const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    const year = parseInt(match[1], 10)
    const month = parseInt(match[2], 10) - 1
    const day = parseInt(match[3], 10)
    return new Date(year, month, day)
  }
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  return d
}

/**
 * Formats a "YYYY-MM-DD" date-only string using local timezone to avoid off-by-one day display bugs.
 */
export function formatLocalDate(dateStr: string | null | undefined, pattern: string): string {
  const d = parseLocalDate(dateStr)
  if (!d) return ""
  const { format } = require("date-fns")
  return format(d, pattern)
}

/**
 * Checks if a "YYYY-MM-DD" date string represents a date that has passed.
 * The estimate/proposal is valid through the entire expiration day.
 * It is considered expired starting the next day (00:00:00 local/server time).
 */
export function isDateExpired(validUntilStr: string | null | undefined): boolean {
  if (!validUntilStr) return false

  const match = validUntilStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    const year = parseInt(match[1], 10)
    const month = parseInt(match[2], 10) - 1
    const day = parseInt(match[3], 10)
    // Create local Date representing 23:59:59.999 on that day
    const expirationDate = new Date(year, month, day, 23, 59, 59, 999)
    return new Date() > expirationDate
  }

  // Fallback for other formats
  const d = new Date(validUntilStr)
  if (isNaN(d.getTime())) return false
  return new Date() > d
}

