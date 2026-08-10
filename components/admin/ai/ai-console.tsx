"use client"

import { useMemo, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RotateCw } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { AiConsoleSnapshot } from "@/lib/services/ai-console"

import { AiModelsTable } from "./ai-models-table"
import { AiOrgAccess } from "./ai-org-access"
import { AiRoutingMatrix } from "./ai-routing-matrix"
import { AiUsagePanel } from "./ai-usage-panel"
import { buildRateLookup } from "./ai-model-picker"
import { compact, money } from "./format"

/**
 * The AI console.
 *
 * Four surfaces, in the order an operator uses them: what runs what (routing),
 * what those models cost (models), what they actually did (usage), and who is
 * allowed to use any of it (access). Everything is resolved on the server, so
 * the page arrives complete and the client only mutates and refreshes.
 */

const TABS = [
  { value: "routing", label: "Routing" },
  { value: "models", label: "Models" },
  { value: "usage", label: "Usage" },
  { value: "access", label: "Access" },
] as const

type TabValue = (typeof TABS)[number]["value"]

const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
]

export function AiConsole({ snapshot }: { snapshot: AiConsoleSnapshot }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<TabValue>("routing")
  const [pending, startTransition] = useTransition()

  const rates = useMemo(() => buildRateLookup(snapshot.models), [snapshot.models])

  const { usage, orgs } = snapshot
  const errorRate = usage.totals.calls > 0 ? (usage.totals.errors / usage.totals.calls) * 100 : 0
  const enabledOrgs = orgs.filter((org) => org.enabled).length
  const unconfigured = snapshot.providers.filter((provider) => !provider.configured)

  function setWindow(value: string) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("window", value)
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }))
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">AI</span>
            <span className="text-xs text-muted-foreground">
              {snapshot.routing.length} features · {snapshot.routing.length * 3} routes
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(snapshot.windowDays)} onValueChange={setWindow} disabled={pending}>
              <SelectTrigger className="h-8 w-36 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={pending}
              onClick={() => startTransition(() => router.refresh())}
            >
              <RotateCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Spend" value={money(usage.totals.costUsd)} hint={`last ${snapshot.windowDays} days`} />
          <Stat label="Calls" value={compact(usage.totals.calls)} hint="completed requests" />
          <Stat
            label="Error rate"
            value={`${errorRate.toFixed(1)}%`}
            hint={`${compact(usage.totals.errors)} failed`}
            alarm={errorRate > 5}
          />
          <Stat
            label="Escalated"
            value={compact(usage.totals.escalatedCalls)}
            hint="needed a stronger model"
          />
          <Stat
            label="Unpriced"
            value={compact(usage.totals.unpricedCalls)}
            hint="calls missing from spend"
            warn={usage.totals.unpricedCalls > 0}
          />
          <Stat
            label="Overrides"
            value={String(snapshot.overrideCount)}
            hint={`${enabledOrgs}/${orgs.length} orgs enabled`}
          />
        </div>

        {unconfigured.length > 0 ? (
          <div className="border-b bg-warning/5 px-4 py-2">
            <p className="text-xs text-warning">
              No API key for {unconfigured.map((provider) => provider.label).join(", ")} — routing to{" "}
              {unconfigured.length === 1 ? "it" : "them"} will fail at call time.
            </p>
          </div>
        ) : null}

        <div className="sticky top-0 z-10 flex items-center gap-1 border-b bg-background/95 px-3 backdrop-blur-sm">
          {TABS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setTab(entry.value)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2.5 text-sm transition-colors",
                tab === entry.value
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className={cn("desk-rise", pending && "opacity-60 transition-opacity")}>
          {tab === "routing" ? (
            <AiRoutingMatrix
              routing={snapshot.routing}
              providers={snapshot.providers}
              rates={rates}
              canManage={snapshot.canManage}
              overrideCount={snapshot.overrideCount}
            />
          ) : null}
          {tab === "models" ? (
            <AiModelsTable
              models={snapshot.models}
              canManage={snapshot.canManage}
              windowDays={snapshot.windowDays}
            />
          ) : null}
          {tab === "usage" ? <AiUsagePanel usage={usage} /> : null}
          {tab === "access" ? <AiOrgAccess orgs={orgs} canManage={snapshot.canManage} /> : null}
        </div>
      </div>
    </div>
    </TooltipProvider>
  )
}

function Stat({
  label,
  value,
  hint,
  alarm,
  warn,
}: {
  label: string
  value: string
  hint: string
  alarm?: boolean
  warn?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default bg-card px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p
            className={cn(
              "mt-1 text-xl font-semibold tabular-nums",
              alarm && "text-destructive",
              !alarm && warn && "text-warning",
            )}
          >
            {value}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} — {hint}
      </TooltipContent>
    </Tooltip>
  )
}
