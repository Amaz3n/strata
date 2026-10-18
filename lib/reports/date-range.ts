/** Calendar dates for UTC reports. End is exclusive to retain PostgreSQL microseconds. */
export function utcReportDateRange(startDate: string, endDate: string) {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) throw new Error("Report dates must be valid calendar dates in YYYY-MM-DD format")
    const date = new Date(`${value}T00:00:00.000Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Report dates must be valid calendar dates in YYYY-MM-DD format")
    return date
  }
  const start = parse(startDate)
  const end = parse(endDate)
  if (start > end) throw new Error("Report start date must be on or before its end date")
  end.setUTCDate(end.getUTCDate() + 1)
  return { startInclusive: start.toISOString(), endExclusive: end.toISOString() }
}
