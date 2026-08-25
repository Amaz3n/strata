/**
 * Display formatters shared by every Documents surface (table, mobile list,
 * properties panel, upload dialog).
 *
 * Convention: every formatter returns an empty string when there is nothing to
 * show. The placeholder ("-", "Unknown") is a presentation decision and belongs
 * to the call site, not to the formatter.
 *
 * Dates are pinned to one explicit locale rather than the viewer's. These render
 * inside client components that are still server-rendered, so a viewer-dependent
 * locale makes the SSR and hydration passes disagree and React discards the
 * markup. Arc has no i18n layer and formats dates as en-US everywhere else, so
 * the pin is also what keeps Documents consistent with the rest of the app.
 */

const DISPLAY_LOCALE = "en-US"

const shortDate = new Intl.DateTimeFormat(DISPLAY_LOCALE, { month: "short", day: "numeric" })
const shortDateWithYear = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
})
const mediumDate = new Intl.DateTimeFormat(DISPLAY_LOCALE, { dateStyle: "medium" })
const mediumDateTime = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
})

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"]

/** `812 B`, `4.1 KB`, `1.3 GB`. Sub-kilobyte sizes have no fractional part. */
export function formatFileSize(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || bytes < 0) return ""
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${FILE_SIZE_UNITS[unitIndex]}`
}

function toDate(value?: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** `Mar 4` — plus the year when it is not the current one. Dense columns and chips. */
export function formatShortDate(value?: string | null): string {
  const date = toDate(value)
  if (!date) return ""
  return date.getFullYear() === new Date().getFullYear()
    ? shortDate.format(date)
    : shortDateWithYear.format(date)
}

/**
 * `Today` / `Yesterday` / `3d ago` for the last week, then {@link formatShortDate}.
 * For columns people scan for recency, such as the table's Modified column.
 */
export function formatRelativeDate(value?: string | null): string {
  const date = toDate(value)
  if (!date) return ""

  const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`

  return formatShortDate(value)
}

/** `Mar 4, 2026`. For detail surfaces where the exact date is the point. */
export function formatDate(value?: string | null): string {
  const date = toDate(value)
  return date ? mediumDate.format(date) : ""
}

/** `Mar 4, 2026, 2:15 PM`. For audit and timeline entries. */
export function formatDateTime(value?: string | null): string {
  const date = toDate(value)
  return date ? mediumDateTime.format(date) : ""
}
