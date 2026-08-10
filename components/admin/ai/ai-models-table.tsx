"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { setAiModelPriceAction } from "@/app/(app)/platform/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Eye, Loader2, Search } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  AI_FEATURE_LABELS,
  AI_PROVIDER_LABELS,
  AI_TIER_LABELS,
} from "@/lib/services/ai-config"
import type { AiModelRow } from "@/lib/services/ai-console"

import { compact, money, rate } from "./format"

/**
 * Every model in play, and what it costs.
 *
 * Prices used to live at the bottom of the usage tab as a blank four-field form,
 * which meant recording a rate started with typing a model id you had to
 * remember. Here the rate sits on the row for the model it belongs to, and an
 * unpriced model that is actually being called is impossible to miss.
 */

type Filter = "all" | "routed" | "unpriced"

export function AiModelsTable({
  models,
  canManage,
  windowDays,
}: {
  models: AiModelRow[]
  canManage: boolean
  windowDays: number
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")

  const unpricedInUse = models.filter((model) => model.price.source === null && model.calls > 0).length

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => {
      if (filter === "routed" && model.routedTo.length === 0) return false
      if (filter === "unpriced" && model.price.source !== null) return false
      if (!needle) return true
      return (
        model.model.toLowerCase().includes(needle) ||
        model.label.toLowerCase().includes(needle) ||
        model.provider.includes(needle)
      )
    })
  }, [models, query, filter])

  const FILTERS: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: "All", count: models.length },
    { value: "routed", label: "Routed", count: models.filter((model) => model.routedTo.length > 0).length },
    { value: "unpriced", label: "No rate", count: models.filter((model) => model.price.source === null).length },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Models</h2>
          <p className="text-xs text-muted-foreground">
            Rates are USD per million tokens. A model with no rate reports its spend as unknown, never as zero.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter models"
              className="h-8 w-48 rounded-none pl-7 text-xs"
            />
          </div>
          <div className="flex items-center gap-px bg-border">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setFilter(entry.value)}
                className={cn(
                  "px-2.5 py-1.5 text-xs transition-colors",
                  filter === entry.value
                    ? "bg-foreground text-background"
                    : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {entry.label}
                <span className="ml-1 tabular-nums opacity-70">{entry.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {unpricedInUse > 0 ? (
        <div className="mx-4 mb-3 border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="text-xs text-warning">
            {unpricedInUse} model{unpricedInUse === 1 ? " is" : "s are"} being called with no recorded rate — their
            spend is missing from every total on this page.
          </p>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border-y py-12 text-center">
          <p className="text-sm font-medium">No models match that filter</p>
          <p className="mt-1 text-xs text-muted-foreground">Clear the search, or switch back to All.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto border-y">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-left font-medium">Routed to</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">In / out $/Mtok</th>
                  <th className="w-px px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((model) => (
                  <ModelRow key={model.key} model={model} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-[11px] text-muted-foreground">
            Calls and spend cover the last {windowDays} days. Models with no traffic and no route are the built-in
            catalog.
          </p>
        </>
      )}
    </div>
  )
}

function ModelRow({ model, canManage }: { model: AiModelRow; canManage: boolean }) {
  const unpriced = model.price.source === null

  return (
    <tr className="hover:bg-accent/40">
      <td className="max-w-0 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[13px]">{model.model}</span>
          {model.vision ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>Accepts images and PDFs.</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {AI_PROVIDER_LABELS[model.provider]}
          {model.routedTo.length > 0 && !model.offeredByProvider
            ? " · not in the provider's current list"
            : ""}
        </span>
      </td>

      <td className="px-3 py-2.5">
        {model.routedTo.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {model.routedTo.map((route) => (
              <Badge
                key={`${route.feature}:${route.tier}`}
                variant="secondary"
                className="rounded-none text-[10px] font-normal"
              >
                {AI_FEATURE_LABELS[route.feature]} · {AI_TIER_LABELS[route.tier]}
              </Badge>
            ))}
          </div>
        )}
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
        {model.calls > 0 ? compact(model.calls) : <span className="text-muted-foreground">—</span>}
        {model.errors > 0 ? (
          <span className="ml-1.5 text-[11px] text-destructive">{model.errors} err</span>
        ) : null}
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
        {model.calls === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            <span className={cn(model.unpricedCalls > 0 && "text-warning")}>{money(model.costUsd)}</span>
            {model.unpricedCalls > 0 ? (
              <p className="text-[11px] text-warning">+{compact(model.unpricedCalls)} unpriced</p>
            ) : null}
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right tabular-nums">
        {unpriced ? (
          <span className="text-warning">no rate</span>
        ) : (
          <>
            <span>
              {rate(model.price.inputPerMTokUsd)} / {rate(model.price.outputPerMTokUsd)}
            </span>
            {model.price.source === "override" ? (
              <span className="ml-1.5 text-[11px] text-muted-foreground">set</span>
            ) : null}
          </>
        )}
      </td>

      <td className="px-3 py-2.5 text-right">
        {canManage ? <PriceEditor model={model} /> : null}
      </td>
    </tr>
  )
}

function PriceEditor({ model }: { model: AiModelRow }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [output, setOutput] = useState("")
  const [pending, startTransition] = useTransition()

  function openWith(next: boolean) {
    setOpen(next)
    if (next) {
      setInput(model.price.inputPerMTokUsd === null ? "" : String(model.price.inputPerMTokUsd))
      setOutput(model.price.outputPerMTokUsd === null ? "" : String(model.price.outputPerMTokUsd))
    }
  }

  function parseRate(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return { ok: true as const, value: null }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) return { ok: false as const, value: null }
    return { ok: true as const, value: parsed }
  }

  function save() {
    const parsedInput = parseRate(input)
    const parsedOutput = parseRate(output)
    if (!parsedInput.ok || !parsedOutput.ok) {
      toast.error("Rates must be zero or a positive number.")
      return
    }

    startTransition(async () => {
      try {
        unwrapAction(
          await setAiModelPriceAction({
            provider: model.provider,
            model: model.model,
            inputPerMTokUsd: parsedInput.value,
            outputPerMTokUsd: parsedOutput.value,
          }),
        )
        toast.success("Rate saved", { description: "New calls on this model report real spend." })
        setOpen(false)
        router.refresh()
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not save the rate.")
      }
    })
  }

  return (
    <Popover open={open} onOpenChange={openWith}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={model.price.source === null && model.calls > 0 ? "outline" : "ghost"}
          className="h-7 rounded-none text-xs"
        >
          {model.price.source === null ? "Add rate" : "Edit"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 rounded-none p-3">
        <div>
          <p className="font-mono text-xs">{model.model}</p>
          <p className="text-[11px] text-muted-foreground">
            USD per million tokens. Leave blank to record it as unknown rather than zero.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">Input</Label>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              inputMode="decimal"
              placeholder="0.30"
              className="h-8 rounded-none tabular-nums"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Output</Label>
            <Input
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              inputMode="decimal"
              placeholder="2.50"
              className="h-8 rounded-none tabular-nums"
            />
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 w-full rounded-none text-xs"
          disabled={pending}
          onClick={save}
        >
          {pending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          {pending ? "Saving…" : "Save rate"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
