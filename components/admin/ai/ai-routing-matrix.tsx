"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { clearAiTierModelAction, updateAiTierModelAction } from "@/app/(app)/platform/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertTriangle, ChevronsUpDown, Eye, Loader2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  AI_PROVIDER_LABELS,
  AI_TIER_HINTS,
  AI_TIER_LABELS,
  AI_TIER_VALUES,
  defaultConfigForFeatureTier,
} from "@/lib/services/ai-config"
import type { AiFeatureRouting, AiProviderStatus, AiRoutingCell } from "@/lib/services/ai-console"

import { AiModelPicker, type ModelChoice, type ModelRateLookup } from "./ai-model-picker"
import { ratePair } from "./format"

/**
 * The routing table as a matrix: one row per feature, one column per tier.
 *
 * The old page listed all eighteen routes as independent forms, each with its
 * own provider select, model select and Save button — so "is anything pointed at
 * an expensive model?" took eighteen reads. Here every route is one cell you can
 * scan down a column, and editing is a single pick that saves itself.
 */

const SOURCE_LABELS: Record<AiRoutingCell["source"], string> = {
  platform: "Override",
  env: "Environment",
  default: "Built-in",
}

export function AiRoutingMatrix({
  routing,
  providers,
  rates,
  canManage,
  overrideCount,
}: {
  routing: AiFeatureRouting[]
  providers: AiProviderStatus[]
  rates: ModelRateLookup
  canManage: boolean
  overrideCount: number
}) {
  const router = useRouter()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  function save(cell: AiRoutingCell, choice: ModelChoice) {
    const key = `${cell.feature}:${cell.tier}`
    setPendingKey(key)
    startTransition(async () => {
      try {
        unwrapAction(
          await updateAiTierModelAction({
            feature: cell.feature,
            tier: cell.tier,
            provider: choice.provider,
            model: choice.model,
          }),
        )
        toast.success(`${AI_TIER_LABELS[cell.tier]} route updated`, { description: choice.model })
        router.refresh()
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not save the route.")
      } finally {
        setPendingKey(null)
      }
    })
  }

  function reset(cell: AiRoutingCell) {
    const key = `${cell.feature}:${cell.tier}`
    setPendingKey(key)
    startTransition(async () => {
      try {
        unwrapAction(await clearAiTierModelAction({ feature: cell.feature, tier: cell.tier }))
        toast.success("Reset to the built-in default")
        router.refresh()
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not reset the route.")
      } finally {
        setPendingKey(null)
      }
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Model routing</h2>
          <p className="text-xs text-muted-foreground">
            Every feature runs at its entry tier and escalates a column to the right when a check fails.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="rounded-none tabular-nums">
            {overrideCount} override{overrideCount === 1 ? "" : "s"}
          </Badge>
          {!canManage ? <span>Read only</span> : null}
        </div>
      </div>

      {/* Column heads — the matrix collapses to stacked cells below lg. */}
      <div className="hidden border-y bg-muted/30 lg:grid lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
        <div className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Feature
        </div>
        {AI_TIER_VALUES.map((tier) => (
          <Tooltip key={tier}>
            <TooltipTrigger asChild>
              <div className="cursor-default px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {AI_TIER_LABELS[tier]}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64">
              {AI_TIER_HINTS[tier]}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="divide-y border-b lg:divide-y-0">
        {routing.map((feature) => (
          <div
            key={feature.feature}
            className="grid gap-px bg-border lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]"
          >
            <div className="bg-card px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{feature.label}</span>
                {feature.requiresVision ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Sends images or PDFs — needs a vision model.</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{feature.description}</p>
            </div>

            {feature.cells.map((cell) => (
              <RoutingCell
                key={cell.tier}
                cell={cell}
                isEntryTier={cell.tier === feature.baseTier}
                requiresVision={feature.requiresVision}
                providers={providers}
                rates={rates}
                canManage={canManage}
                saving={pendingKey === `${cell.feature}:${cell.tier}`}
                onSelect={(choice) => save(cell, choice)}
                onReset={() => reset(cell)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="rounded-none px-1 text-[10px]">
            entry
          </Badge>
          the tier a feature starts on
        </span>
        <span className="flex items-center gap-1.5">
          <Badge variant="outline" className="rounded-none px-1 text-[10px]">
            override
          </Badge>
          pinned here, not the built-in default
        </span>
        <span>Rates are USD per million input / output tokens.</span>
      </div>
    </div>
  )
}

function RoutingCell({
  cell,
  isEntryTier,
  requiresVision,
  providers,
  rates,
  canManage,
  saving,
  onSelect,
  onReset,
}: {
  cell: AiRoutingCell
  isEntryTier: boolean
  requiresVision: boolean
  providers: AiProviderStatus[]
  rates: ModelRateLookup
  canManage: boolean
  saving: boolean
  onSelect: (choice: ModelChoice) => void
  onReset: () => void
}) {
  const rateLine = ratePair(cell.price.inputPerMTokUsd, cell.price.outputPerMTokUsd)
  const blindToDocuments = requiresVision && cell.vision === false
  const builtIn = defaultConfigForFeatureTier(cell.feature, cell.tier)

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground lg:hidden">
          {AI_TIER_LABELS[cell.tier]}
        </span>
        {isEntryTier ? (
          <Badge variant="secondary" className="rounded-none px-1 text-[10px]">
            entry
          </Badge>
        ) : null}
        {cell.source !== "default" ? (
          <Badge variant="outline" className="rounded-none px-1 text-[10px]">
            {SOURCE_LABELS[cell.source].toLowerCase()}
          </Badge>
        ) : null}
      </div>

      <span className="truncate font-mono text-[13px] font-medium">{cell.model}</span>

      <span className="truncate text-[11px] text-muted-foreground">
        {AI_PROVIDER_LABELS[cell.provider]}
        {rateLine ? ` · ${rateLine}` : ""}
      </span>

      {blindToDocuments ? (
        <span className="flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3" />
          may not accept documents
        </span>
      ) : !rateLine ? (
        <span className="text-[11px] text-warning">no rate — spend reports as unknown</span>
      ) : null}
    </div>
  )

  if (!canManage) {
    return <div className="flex items-start gap-2 bg-card px-3 py-3">{body}</div>
  }

  return (
    <AiModelPicker
      providers={providers}
      rates={rates}
      value={{ provider: cell.provider, model: cell.model }}
      saving={saving}
      onSelect={onSelect}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            Built-in: <span className="font-mono">{builtIn.model}</span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 rounded-none text-xs"
            disabled={cell.source !== "platform"}
            onClick={onReset}
          >
            Reset
          </Button>
        </div>
      }
      trigger={
        <button
          type="button"
          className={cn(
            "group flex w-full items-start gap-2 bg-card px-3 py-3 text-left transition-colors",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            saving && "opacity-60",
          )}
        >
          {body}
          {saving ? (
            <Loader2 className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronsUpDown className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </button>
      }
    />
  )
}
