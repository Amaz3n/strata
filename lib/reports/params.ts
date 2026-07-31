import { z } from "zod"

import type { ReportDefinition, ReportParamSpec, ReportParams } from "@/lib/reports/types"

/**
 * Parameters travel in the URL, which makes every report view shareable, and are
 * snapshotted onto each run so a pull can be reproduced months later.
 */

export const PERIOD_PRESETS = [
  { value: "all", label: "All dates" },
  { value: "ytd", label: "Year to date" },
  { value: "qtd", label: "Quarter to date" },
  { value: "mtd", label: "Month to date" },
  { value: "last12", label: "Last 12 months" },
  { value: "lastyear", label: "Last calendar year" },
] as const

export type PeriodPreset = (typeof PERIOD_PRESETS)[number]["value"]

function iso(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function todayIso() {
  return iso(new Date())
}

/** Resolve a period preset to an inclusive date range. `null` means unbounded. */
export function periodRange(preset: string, now = new Date()): { from: string | null; to: string | null } {
  const year = now.getUTCFullYear()
  const today = iso(now)
  switch (preset) {
    case "ytd":
      return { from: `${year}-01-01`, to: today }
    case "qtd": {
      const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3
      return { from: iso(new Date(Date.UTC(year, quarterStartMonth, 1))), to: today }
    }
    case "mtd":
      return { from: iso(new Date(Date.UTC(year, now.getUTCMonth(), 1))), to: today }
    case "last12":
      return { from: iso(new Date(Date.UTC(year, now.getUTCMonth() - 11, 1))), to: today }
    case "lastyear":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }
    default:
      return { from: null, to: null }
  }
}

export function periodLabel(preset: string) {
  return PERIOD_PRESETS.find((option) => option.value === preset)?.label ?? "All dates"
}

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const toggleParam = z.enum(["0", "1"])

function defaultFor(spec: ReportParamSpec): string {
  switch (spec.kind) {
    case "date":
      return todayIso()
    case "period":
      return "all"
    case "select":
      return spec.options[0]?.value ?? ""
    case "toggle":
      return "0"
  }
}

function schemaFor(spec: ReportParamSpec) {
  switch (spec.kind) {
    case "date":
      return dateParam
    case "period":
      return z.enum(PERIOD_PRESETS.map((option) => option.value) as [PeriodPreset, ...PeriodPreset[]])
    case "select":
      return z.enum(spec.options.map((option) => option.value) as [string, ...string[]])
    case "toggle":
      return toggleParam
  }
}

/**
 * Parse raw search params against a definition's spec. Unknown keys are dropped
 * and invalid values fall back to the default — a hand-edited URL degrades to a
 * valid report rather than a 400.
 */
export function parseReportParams(
  definition: ReportDefinition,
  raw: Record<string, string | string[] | undefined>,
): ReportParams {
  const params: ReportParams = {}
  for (const spec of definition.params ?? []) {
    const candidate = raw[spec.key]
    const value = Array.isArray(candidate) ? candidate[0] : candidate
    const parsed = value === undefined ? null : schemaFor(spec).safeParse(value)
    params[spec.key] = parsed?.success ? String(parsed.data) : defaultFor(spec)
  }
  return params
}

export function isToggleOn(params: ReportParams, key: string) {
  return params[key] === "1"
}

/**
 * The lens a report may honestly claim, given how much of the ambient scope that
 * report's `run` actually passes to its service. Org-wide reports (WIP, aging,
 * ledgers) name no lens at all rather than implying a filter they never apply.
 */
export function ambientScopeLabel(
  context: { divisionLabel?: string; communityLabel?: string },
  ambientScope?: "division" | "full",
): string | null {
  if (!ambientScope) return null
  const parts = [context.divisionLabel]
  if (ambientScope === "full") parts.push(context.communityLabel)
  return parts.filter(Boolean).join(" · ") || "All communities"
}

/** Human summary of the active parameters, for the subtitle and run history. */
export function describeParams(definition: ReportDefinition, params: ReportParams): string[] {
  const parts: string[] = []
  for (const spec of definition.params ?? []) {
    const value = params[spec.key]
    if (value === undefined) continue
    switch (spec.kind) {
      case "date":
        parts.push(`${spec.label} ${value}`)
        break
      case "period":
        parts.push(periodLabel(value))
        break
      case "select": {
        const option = spec.options.find((candidate) => candidate.value === value)
        if (option) parts.push(option.label)
        break
      }
      case "toggle":
        if (value === "1") parts.push(spec.label)
        break
    }
  }
  return parts
}
