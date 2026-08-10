import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  AI_FEATURE_LABELS,
  AI_PROVIDER_LABELS,
  type AiFeature,
  type AiProvider,
  type AiTier,
} from "@/lib/services/ai-config"
import { loadPriceOverrides } from "@/lib/services/ai/usage"

/**
 * Reading the AI ledger for the platform page.
 *
 * Two honesty rules run through every figure here:
 *
 * 1. UNPRICED IS NOT FREE. Calls on a model with no known rate are counted
 *    separately and surfaced, never folded into the total as zero. A dashboard
 *    that quietly under-reports spend is worse than one that says "I don't know
 *    what these cost".
 * 2. TRUNCATION IS DISCLOSED. Aggregation happens in JS over a capped window,
 *    so when the cap bites the caller is told rather than shown a total that
 *    silently excludes rows.
 */

/** Rows scanned per report. Above this the window is truncated and disclosed. */
const MAX_ROWS = 50_000

export interface AiUsageBucket {
  key: string
  label: string
  calls: number
  errors: number
  costUsd: number
  /** Calls whose model has no known price, so cost is understated by this many. */
  unpricedCalls: number
  inputTokens: number
  outputTokens: number
  p50LatencyMs: number
  p95LatencyMs: number
}

export interface AiUsageDailyPoint {
  date: string
  calls: number
  costUsd: number
  errors: number
}

export interface AiUsageErrorSample {
  createdAt: string
  feature: string
  provider: string
  model: string
  tier: string
  errorKind: string | null
}

export interface AiUsageReport {
  windowDays: number
  totals: {
    calls: number
    errors: number
    costUsd: number
    unpricedCalls: number
    escalatedCalls: number
    inputTokens: number
    outputTokens: number
  }
  byFeature: AiUsageBucket[]
  byModel: AiUsageBucket[]
  byOrg: AiUsageBucket[]
  byTier: AiUsageBucket[]
  daily: AiUsageDailyPoint[]
  recentErrors: AiUsageErrorSample[]
  /** True when the window hit MAX_ROWS; totals understate reality. */
  truncated: boolean
  /** Models seen in the window that have no price recorded. */
  unpricedModels: string[]
}

interface UsageRow {
  org_id: string | null
  feature: string
  tier: string
  provider: string
  model: string
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: string | number | null
  latency_ms: number
  escalated_from: string | null
  status: string
  error_kind: string | null
  created_at: string
}

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function buildBuckets(
  rows: UsageRow[],
  keyOf: (row: UsageRow) => string,
  labelOf: (key: string, row: UsageRow) => string,
): AiUsageBucket[] {
  const groups = new Map<string, { rows: UsageRow[]; label: string }>()
  for (const row of rows) {
    const key = keyOf(row)
    const existing = groups.get(key)
    if (existing) existing.rows.push(row)
    else groups.set(key, { rows: [row], label: labelOf(key, row) })
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const latencies = group.rows.map((row) => row.latency_ms).sort((a, b) => a - b)
      let costUsd = 0
      let unpricedCalls = 0
      for (const row of group.rows) {
        if (row.cost_usd === null) unpricedCalls += 1
        else costUsd += Number(row.cost_usd)
      }
      return {
        key,
        label: group.label,
        calls: group.rows.length,
        errors: group.rows.filter((row) => row.status === "error").length,
        costUsd,
        unpricedCalls,
        inputTokens: group.rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
        outputTokens: group.rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
      }
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls)
}

export async function getAiUsageReport({
  supabase,
  windowDays = 30,
  orgId,
}: {
  supabase: SupabaseClient
  windowDays?: number
  /** Scope to one org; omit for the platform-wide view. */
  orgId?: string
}): Promise<AiUsageReport> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from("ai_usage_events")
    .select(
      "org_id,feature,tier,provider,model,input_tokens,output_tokens,cost_usd,latency_ms,escalated_from,status,error_kind,created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS)

  if (orgId) query = query.eq("org_id", orgId)

  const [{ data, error }, orgNames, priceOverrides] = await Promise.all([
    query,
    loadOrgNames(supabase, orgId),
    loadPriceOverrides(supabase),
  ])

  if (error) {
    // The table may not exist yet in a fresh environment; an empty report is a
    // truthful answer there, and noisier handling would only mask real errors.
    if (error.code !== "42P01") console.error("[ai/usage-reporting] Query failed", error.message)
    return emptyReport(windowDays)
  }

  const rows = (data ?? []) as UsageRow[]
  const truncated = rows.length >= MAX_ROWS

  const totals = rows.reduce(
    (acc, row) => {
      acc.calls += 1
      if (row.status === "error") acc.errors += 1
      if (row.cost_usd === null) acc.unpricedCalls += 1
      else acc.costUsd += Number(row.cost_usd)
      if (row.escalated_from) acc.escalatedCalls += 1
      acc.inputTokens += row.input_tokens ?? 0
      acc.outputTokens += row.output_tokens ?? 0
      return acc
    },
    { calls: 0, errors: 0, costUsd: 0, unpricedCalls: 0, escalatedCalls: 0, inputTokens: 0, outputTokens: 0 },
  )

  const dailyMap = new Map<string, AiUsageDailyPoint>()
  for (const row of rows) {
    const date = row.created_at.slice(0, 10)
    const point = dailyMap.get(date) ?? { date, calls: 0, costUsd: 0, errors: 0 }
    point.calls += 1
    point.costUsd += row.cost_usd === null ? 0 : Number(row.cost_usd)
    if (row.status === "error") point.errors += 1
    dailyMap.set(date, point)
  }

  const priced = new Set(Object.keys(priceOverrides))
  const unpricedModels = Array.from(
    new Set(
      rows
        .filter((row) => row.cost_usd === null)
        .map((row) => `${row.provider}:${row.model}`)
        .filter((key) => !priced.has(key)),
    ),
  ).sort()

  return {
    windowDays,
    totals,
    byFeature: buildBuckets(
      rows,
      (row) => row.feature,
      (key) => AI_FEATURE_LABELS[key as AiFeature] ?? key,
    ),
    byModel: buildBuckets(
      rows,
      (row) => `${row.provider}:${row.model}`,
      (key, row) => `${AI_PROVIDER_LABELS[row.provider as AiProvider] ?? row.provider} · ${row.model}`,
    ),
    byOrg: buildBuckets(
      rows,
      (row) => row.org_id ?? "platform",
      (key) => (key === "platform" ? "Platform (no tenant)" : orgNames.get(key) ?? key),
    ),
    byTier: buildBuckets(
      rows,
      (row) => row.tier,
      (key) => key.charAt(0).toUpperCase() + key.slice(1),
    ),
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    recentErrors: rows
      .filter((row) => row.status === "error")
      .slice(0, 20)
      .map((row) => ({
        createdAt: row.created_at,
        feature: AI_FEATURE_LABELS[row.feature as AiFeature] ?? row.feature,
        provider: row.provider,
        model: row.model,
        tier: row.tier,
        errorKind: row.error_kind,
      })),
    truncated,
    unpricedModels,
  }
}

async function loadOrgNames(supabase: SupabaseClient, orgId?: string) {
  const names = new Map<string, string>()
  try {
    let query = supabase.from("orgs").select("id,name").limit(1000)
    if (orgId) query = query.eq("id", orgId)
    const { data } = await query
    for (const row of data ?? []) names.set(row.id as string, (row.name as string) ?? "")
  } catch {
    // Names are a nicety; ids are still meaningful without them.
  }
  return names
}

function emptyReport(windowDays: number): AiUsageReport {
  return {
    windowDays,
    totals: { calls: 0, errors: 0, costUsd: 0, unpricedCalls: 0, escalatedCalls: 0, inputTokens: 0, outputTokens: 0 },
    byFeature: [],
    byModel: [],
    byOrg: [],
    byTier: [],
    daily: [],
    recentErrors: [],
    truncated: false,
    unpricedModels: [],
  }
}

export type { AiFeature, AiProvider, AiTier }
