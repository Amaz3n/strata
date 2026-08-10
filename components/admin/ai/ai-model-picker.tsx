"use client"

import { useMemo, useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Check, Eye, Loader2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import { AI_PROVIDER_VALUES, type AiProvider } from "@/lib/services/ai-config"
import type { AiProviderStatus } from "@/lib/services/ai-console"

import { ratePair } from "./format"

/**
 * One control for "which model runs this", instead of a provider dropdown, a
 * model dropdown and a hidden free-text mode.
 *
 * Provider is a segmented row rather than a second select, so switching provider
 * re-filters the same list in place. Anything the provider lists is one click;
 * anything it does not — a model released this morning — is still reachable by
 * typing the id, because the routing layer accepts any string the provider does.
 */

/** Rendered rows per search. Above this the list is capped and says so. */
const MAX_VISIBLE = 60

export interface ModelChoice {
  provider: AiProvider
  model: string
}

/** `provider:model` → the rate line to show beside it, when one is known. */
export type ModelRateLookup = Record<string, string>

export function AiModelPicker({
  providers,
  rates,
  value,
  saving,
  onSelect,
  align = "start",
  footer,
  trigger,
}: {
  providers: AiProviderStatus[]
  rates: ModelRateLookup
  value: ModelChoice
  saving?: boolean
  onSelect: (choice: ModelChoice) => void
  align?: "start" | "center" | "end"
  footer?: ReactNode
  trigger: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<AiProvider>(value.provider)
  const [query, setQuery] = useState("")

  const status = providers.find((entry) => entry.provider === provider)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const models = status?.models ?? []
    const matches = needle
      ? models.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle),
        )
      : models
    return { matches, shown: matches.slice(0, MAX_VISIBLE) }
  }, [status, query])

  const typed = query.trim()
  const exactMatch = filtered.matches.some((model) => model.id === typed)

  function choose(model: string) {
    setOpen(false)
    setQuery("")
    if (model === value.model && provider === value.provider) return
    onSelect({ provider, model })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setProvider(value.provider)
          setQuery("")
        }
      }}
    >
      <PopoverTrigger asChild disabled={saving}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[23rem] rounded-none p-0">
        <div className="flex items-center gap-px bg-border">
          {AI_PROVIDER_VALUES.map((entry) => {
            const providerStatus = providers.find((item) => item.provider === entry)
            const active = entry === provider
            return (
              <button
                key={entry}
                type="button"
                onClick={() => setProvider(entry)}
                className={cn(
                  "flex-1 px-2 py-2 text-xs transition-colors",
                  active
                    ? "bg-background font-medium text-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {providerStatus?.label ?? entry}
                {providerStatus && !providerStatus.configured ? " ·" : ""}
              </button>
            )
          })}
        </div>

        <Command shouldFilter={false} className="rounded-none border-t">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search models, or type an id…"
            className="h-9"
          />
          <CommandList className="max-h-72">
            {filtered.shown.length === 0 && !typed ? (
              <CommandEmpty className="py-6 text-xs">No models listed for this provider.</CommandEmpty>
            ) : null}

            {typed && !exactMatch ? (
              <CommandItem
                value={typed}
                onSelect={() => choose(typed)}
                className="rounded-none border-b data-[selected=true]:bg-accent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs">Use “{typed}”</span>
                  <span className="text-[11px] text-muted-foreground">
                    Not in the provider list — saved exactly as typed.
                  </span>
                </span>
              </CommandItem>
            ) : null}

            {filtered.shown.map((model) => {
              const selected = model.id === value.model && provider === value.provider
              const rateLine = rates[`${provider}:${model.id}`]
              return (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  onSelect={() => choose(model.id)}
                  className="items-start gap-2 rounded-none data-[selected=true]:bg-accent"
                >
                  <Check
                    className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs">{model.id}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {rateLine ?? "no rate recorded"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 pt-0.5">
                    {model.vision ? <Eye className="h-3 w-3 text-muted-foreground" /> : null}
                    {model.source === "catalog" ? (
                      <Badge variant="outline" className="rounded-none px-1 text-[10px]">
                        built-in
                      </Badge>
                    ) : null}
                  </span>
                </CommandItem>
              )
            })}

            {filtered.matches.length > filtered.shown.length ? (
              <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                Showing {filtered.shown.length} of {filtered.matches.length} — keep typing to narrow.
              </p>
            ) : null}
          </CommandList>
        </Command>

        {status?.warning ? (
          <p className="border-t bg-warning/5 px-3 py-2 text-[11px] text-warning">{status.warning}</p>
        ) : null}

        {footer ? <div className="border-t p-2">{footer}</div> : null}

        {saving ? (
          <div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving…
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Build the `provider:model` → rate-line map the picker shows. */
export function buildRateLookup(
  models: Array<{ provider: AiProvider; model: string; price: { inputPerMTokUsd: number | null; outputPerMTokUsd: number | null } }>,
): ModelRateLookup {
  const lookup: ModelRateLookup = {}
  for (const entry of models) {
    const line = ratePair(entry.price.inputPerMTokUsd, entry.price.outputPerMTokUsd)
    if (line) lookup[`${entry.provider}:${entry.model}`] = `${line} per Mtok`
  }
  return lookup
}
