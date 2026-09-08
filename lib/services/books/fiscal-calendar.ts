/** Fiscal years are named for the calendar year in which they start. */
export function fiscalYearRange(startYear: number, startMonth: number) {
  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2200 || !Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error("Invalid fiscal calendar")
  const startDate = `${startYear}-${String(startMonth).padStart(2, "0")}-01`
  const next = new Date(Date.UTC(startYear + 1, startMonth - 1, 1))
  next.setUTCDate(next.getUTCDate() - 1)
  return { startDate, endDate: next.toISOString().slice(0, 10), months: Array.from({ length: 12 }, (_, offset) => new Date(Date.UTC(startYear, startMonth - 1 + offset, 1)).toISOString().slice(0, 10)) }
}

export function fiscalYearRangeEndingOn(endDate: string, startMonth: number) {
  const [year, month] = endDate.split("-").map(Number)
  return fiscalYearRange(month < startMonth ? year - 1 : year, startMonth)
}
