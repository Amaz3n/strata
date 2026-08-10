import "server-only"

import {
  AI_FEATURE_BASE_TIER,
  AI_FEATURE_DESCRIPTIONS,
  AI_FEATURE_LABELS,
  AI_FEATURE_REQUIRES_VISION,
  AI_FEATURE_VALUES,
  AI_MODEL_CATALOG,
  AI_PROVIDER_LABELS,
  AI_PROVIDER_VALUES,
  AI_TIER_VALUES,
  catalogEntry,
  getAiFeatureTierConfig,
  normalizeModelId,
  type AiFeature,
  type AiProvider,
  type AiTier,
} from "@/lib/services/ai-config"
import { listAvailableModels, type AvailableModel } from "@/lib/services/ai/model-listing"
import { loadPriceOverrides } from "@/lib/services/ai/usage"
import { getAiUsageReport, type AiUsageReport } from "@/lib/services/ai/usage-reporting"
import { listOrgAiSearchAccess, type OrgAiSearchAccess } from "@/lib/services/ai-search-access"
import { hasAnyPermission, requirePermission } from "@/lib/services/permissions"
import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Everything the AI console renders, resolved on the server in one pass.
 *
 * The console used to build itself from five client fetches, which meant the
 * operator watched four spinners settle before the page said anything. Routing,
 * prices, usage and provider catalogs are all server-readable, so they are read
 * together here and the client only ever mutates.
 */

export type AiRoutingSource = "platform" | "env" | "default"
export type AiPriceSource = "override" | "catalog"

export interface AiModelPrice {
  inputPerMTokUsd: number | null
  outputPerMTokUsd: number | null
  /** Where the rate came from. Null when no rate is known at all. */
  source: AiPriceSource | null
}

/** One (feature, tier) route — a cell in the routing matrix. */
export interface AiRoutingCell {
  feature: AiFeature
  tier: AiTier
  provider: AiProvider
  model: string
  source: AiRoutingSource
  price: AiModelPrice
  /** Null when neither the catalog nor the provider list says either way. */
  vision: boolean | null
}

export interface AiFeatureRouting {
  feature: AiFeature
  label: string
  description: string
  baseTier: AiTier
  requiresVision: boolean
  cells: AiRoutingCell[]
}

/** A model that is either routed to, priced, or was actually called in the window. */
export interface AiModelRow {
  key: string
  provider: AiProvider
  model: string
  label: string
  price: AiModelPrice
  vision: boolean | null
  routedTo: Array<{ feature: AiFeature; tier: AiTier }>
  calls: number
  errors: number
  costUsd: number
  unpricedCalls: number
  /** False when the provider's live list does not offer it — a typo, or retired. */
  offeredByProvider: boolean
}

export interface AiProviderStatus {
  provider: AiProvider
  label: string
  configured: boolean
  warning: string | null
  models: AvailableModel[]
}

export interface AiConsoleSnapshot {
  canManage: boolean
  windowDays: number
  routing: AiFeatureRouting[]
  /** Routes pinned by an operator, i.e. rows the Reset action can undo. */
  overrideCount: number
  models: AiModelRow[]
  providers: AiProviderStatus[]
  usage: AiUsageReport
  orgs: OrgAiSearchAccess[]
}

const MANAGE_PERMISSIONS = ["platform.feature_flags.manage", "billing.manage"] as const

function priceKey(provider: AiProvider, model: string) {
  return `${provider}:${normalizeModelId(model)}`
}

function resolvePrice(
  provider: AiProvider,
  model: string,
  overrides: Record<string, { inputPerMTokUsd: number | null; outputPerMTokUsd: number | null }>,
): AiModelPrice {
  const override = overrides[priceKey(provider, model)]
  if (override && (override.inputPerMTokUsd !== null || override.outputPerMTokUsd !== null)) {
    return { ...override, source: "override" }
  }

  const catalog = catalogEntry(provider, model)
  if (catalog && (catalog.inputPerMTokUsd !== null || catalog.outputPerMTokUsd !== null)) {
    return {
      inputPerMTokUsd: catalog.inputPerMTokUsd,
      outputPerMTokUsd: catalog.outputPerMTokUsd,
      source: "catalog",
    }
  }

  return { inputPerMTokUsd: null, outputPerMTokUsd: null, source: null }
}

/**
 * Vision support, catalog first. A provider listing reports `true` for anything
 * it does not recognise, so it is only trusted when the catalog is silent — and
 * an unknown model stays `null` rather than being asserted either way.
 */
function resolveVision(provider: AiProvider, model: string, offered: AvailableModel | undefined): boolean | null {
  const catalog = catalogEntry(provider, model)
  if (catalog) return catalog.vision
  return offered ? offered.vision : null
}

export async function getAiConsoleSnapshot({ windowDays }: { windowDays: number }): Promise<AiConsoleSnapshot> {
  const { user } = await requireAuth()
  await requirePermission("platform.org.access", { userId: user.id })

  const supabase = createServiceSupabaseClient()

  const [canManage, orgs, usage, overrides, providerLists, configs] = await Promise.all([
    hasAnyPermission([...MANAGE_PERMISSIONS], { userId: user.id }),
    listOrgAiSearchAccess(),
    getAiUsageReport({ supabase, windowDays }),
    loadPriceOverrides(supabase),
    Promise.all(AI_PROVIDER_VALUES.map((provider) => listAvailableModels(provider))),
    Promise.all(
      AI_FEATURE_VALUES.flatMap((feature) =>
        AI_TIER_VALUES.map((tier) => getAiFeatureTierConfig({ supabase, feature, tier })),
      ),
    ),
  ])

  const providers: AiProviderStatus[] = providerLists.map((entry) => ({
    provider: entry.provider,
    label: AI_PROVIDER_LABELS[entry.provider],
    configured: entry.configured,
    warning: entry.warning,
    models: entry.models,
  }))

  const offeredByKey = new Map<string, AvailableModel>()
  for (const entry of providerLists) {
    for (const model of entry.models) offeredByKey.set(`${entry.provider}:${model.id}`, model)
  }

  const cells: AiRoutingCell[] = configs.map((config) => {
    const model = normalizeModelId(config.model)
    return {
      feature: config.feature,
      tier: config.tier,
      provider: config.provider,
      model,
      source: config.source,
      price: resolvePrice(config.provider, model, overrides),
      vision: resolveVision(config.provider, model, offeredByKey.get(`${config.provider}:${model}`)),
    }
  })

  const routing: AiFeatureRouting[] = AI_FEATURE_VALUES.map((feature) => ({
    feature,
    label: AI_FEATURE_LABELS[feature],
    description: AI_FEATURE_DESCRIPTIONS[feature],
    baseTier: AI_FEATURE_BASE_TIER[feature],
    requiresVision: AI_FEATURE_REQUIRES_VISION[feature],
    // Tier order is preserved from the flatMap above, so this stays Fast → Heavy.
    cells: cells.filter((cell) => cell.feature === feature),
  }))

  return {
    canManage,
    windowDays,
    routing,
    overrideCount: cells.filter((cell) => cell.source === "platform").length,
    models: buildModelRows({ cells, usage, overrides, offeredByKey }),
    providers,
    usage,
    orgs,
  }
}

/**
 * The models actually in play: routed to, called in the window, priced by hand,
 * or in the seed catalog. Deliberately not "every model the providers offer" —
 * that is hundreds of rows, and the picker is where you go browsing.
 */
function buildModelRows({
  cells,
  usage,
  overrides,
  offeredByKey,
}: {
  cells: AiRoutingCell[]
  usage: AiUsageReport
  overrides: Record<string, { inputPerMTokUsd: number | null; outputPerMTokUsd: number | null }>
  offeredByKey: Map<string, AvailableModel>
}): AiModelRow[] {
  const rows = new Map<string, AiModelRow>()

  function ensure(provider: AiProvider, model: string): AiModelRow {
    const key = priceKey(provider, model)
    const existing = rows.get(key)
    if (existing) return existing

    const offered = offeredByKey.get(`${provider}:${normalizeModelId(model)}`)
    const row: AiModelRow = {
      key,
      provider,
      model: normalizeModelId(model),
      label: offered?.label ?? catalogEntry(provider, model)?.label ?? normalizeModelId(model),
      price: resolvePrice(provider, model, overrides),
      vision: resolveVision(provider, model, offered),
      routedTo: [],
      calls: 0,
      errors: 0,
      costUsd: 0,
      unpricedCalls: 0,
      offeredByProvider: Boolean(offered),
    }
    rows.set(key, row)
    return row
  }

  for (const entry of AI_MODEL_CATALOG) ensure(entry.provider, entry.model)
  for (const cell of cells) ensure(cell.provider, cell.model).routedTo.push({ feature: cell.feature, tier: cell.tier })

  for (const key of Object.keys(overrides)) {
    const [provider, ...rest] = key.split(":")
    const parsed = AI_PROVIDER_VALUES.find((value) => value === provider)
    if (parsed && rest.length > 0) ensure(parsed, rest.join(":"))
  }

  for (const bucket of usage.byModel) {
    const [provider, ...rest] = bucket.key.split(":")
    const parsed = AI_PROVIDER_VALUES.find((value) => value === provider)
    if (!parsed || rest.length === 0) continue
    const row = ensure(parsed, rest.join(":"))
    row.calls += bucket.calls
    row.errors += bucket.errors
    row.costUsd += bucket.costUsd
    row.unpricedCalls += bucket.unpricedCalls
  }

  // Routed models first — they are what an operator is here to manage — then by
  // spend, so the expensive experiment sits above the model nothing calls.
  return Array.from(rows.values()).sort((a, b) => {
    if (a.routedTo.length !== b.routedTo.length) return b.routedTo.length - a.routedTo.length
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd
    if (b.calls !== a.calls) return b.calls - a.calls
    return a.key.localeCompare(b.key)
  })
}
