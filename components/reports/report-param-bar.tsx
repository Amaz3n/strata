"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useTransition } from "react"

import { PERIOD_PRESETS } from "@/lib/reports/params"
import type { ReportParamSpec, ReportParams } from "@/lib/reports/types"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

/**
 * Report parameters only — time and report-specific options. Division and
 * community stay ambient (the desk scope switcher owns them); adding a lens
 * control here would fork scope per surface, which the desk doctrine forbids.
 */
export function ReportParamBar({
  specs,
  values,
}: {
  specs: ReportParamSpec[]
  values: ReportParams
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString())
    next.set(key, value)
    startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }))
  }

  if (specs.length === 0) return null

  return (
    <div
      className={cn(
        "flex flex-wrap items-end gap-x-6 gap-y-3 border px-4 py-3 transition-opacity",
        pending && "opacity-60",
      )}
    >
      {specs.map((spec) => {
        const value = values[spec.key] ?? ""
        const controlId = `report-param-${spec.key}`

        if (spec.kind === "toggle") {
          return (
            <div key={spec.key} className="flex items-center gap-2 pb-1.5">
              <Switch
                id={controlId}
                checked={value === "1"}
                onCheckedChange={(checked) => setParam(spec.key, checked ? "1" : "0")}
              />
              <Label htmlFor={controlId} className="text-xs font-medium">
                {spec.label}
              </Label>
            </div>
          )
        }

        if (spec.kind === "date") {
          return (
            <div key={spec.key} className="space-y-1">
              <Label htmlFor={controlId} className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {spec.label}
              </Label>
              <Input
                id={controlId}
                type="date"
                value={value}
                onChange={(event) => setParam(spec.key, event.target.value)}
                className="h-8 w-40 text-sm"
              />
            </div>
          )
        }

        const options = spec.kind === "period" ? PERIOD_PRESETS.map((preset) => ({ ...preset })) : spec.options

        return (
          <div key={spec.key} className="space-y-1">
            <Label htmlFor={controlId} className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {spec.label}
            </Label>
            <Select value={value} onValueChange={(next) => setParam(spec.key, next)}>
              <SelectTrigger id={controlId} size="sm" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
