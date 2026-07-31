export interface ForecastSnapshotLine {
  cost_code_id?: string | null
  budget_line_id?: string | null
  cost_code?: string | null
  cost_code_name?: string | null
  adjusted_budget_cents?: number | null
  committed_cents?: number | null
  actual_cents?: number | null
  estimate_at_completion_cents?: number | null
  cost_to_complete_cents?: number | null
}

export interface SnapshotVarianceLine {
  key: string
  label: string
  from_cents: number
  to_cents: number
  variance_cents: number
}

function lineKey(line: ForecastSnapshotLine, index: number) {
  return line.budget_line_id ?? line.cost_code_id ?? line.cost_code ?? `line-${index}`
}

function forecastValue(line: ForecastSnapshotLine) {
  return Number(line.estimate_at_completion_cents ?? line.adjusted_budget_cents ?? 0)
}

export function compareForecastSnapshotLines(from: ForecastSnapshotLine[], to: ForecastSnapshotLine[]): SnapshotVarianceLine[] {
  const fromMap = new Map(from.map((line, index) => [lineKey(line, index), line]))
  const toMap = new Map(to.map((line, index) => [lineKey(line, index), line]))
  return Array.from(new Set([...fromMap.keys(), ...toMap.keys()])).map((key) => {
    const fromLine = fromMap.get(key)
    const toLine = toMap.get(key)
    const fromCents = fromLine ? forecastValue(fromLine) : 0
    const toCents = toLine ? forecastValue(toLine) : 0
    return {
      key,
      label: toLine?.cost_code_name ?? toLine?.cost_code ?? fromLine?.cost_code_name ?? fromLine?.cost_code ?? "Uncoded",
      from_cents: fromCents,
      to_cents: toCents,
      variance_cents: toCents - fromCents,
    }
  })
}

export type ForecastCurve = "linear" | "front_loaded" | "back_loaded"

export interface TimePhaseInput {
  start: string
  end: string
  amount_cents: number
  curve?: ForecastCurve
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

export function distributeForecastAcrossMonths(input: TimePhaseInput): Record<string, number> {
  if (!Number.isInteger(input.amount_cents)) throw new Error("Forecast amount must be integer cents")
  const start = new Date(`${input.start}T00:00:00.000Z`)
  const end = new Date(`${input.end}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new Error("Forecast dates are invalid")
  const months: string[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const finalMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= finalMonth) {
    months.push(monthKey(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  const curve = input.curve ?? "linear"
  const weights = months.map((_, index) => {
    if (curve === "front_loaded") return months.length - index
    if (curve === "back_loaded") return index + 1
    return 1
  })
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  let allocated = 0
  return Object.fromEntries(months.map((month, index) => {
    const cents = index === months.length - 1 ? input.amount_cents - allocated : Math.round(input.amount_cents * weights[index] / weightTotal)
    allocated += cents
    return [month, cents]
  }))
}
