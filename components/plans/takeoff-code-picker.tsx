"use client"

import { useMemo, useState, type ReactNode } from "react"

import { Check, ChevronsUpDown } from "@/components/icons"
import { centsToDollars } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A takeoff is entered by cost code, so the code has to be reachable by typing
 * it. Division and group headers are excluded: they name a section of the bill,
 * nothing is ever built against them.
 */
export function pickableCostCodes(costCodes: CostCode[]): CostCode[] {
  return costCodes.filter(
    (code) => code.category !== "csi-division" && code.category !== "nahb-group" && code.is_active !== false,
  )
}

export function TakeoffCodePicker({
  costCodes,
  value,
  onSelect,
  /** Sorts this division's codes to the top — used by the per-division add button. */
  preferDivision,
  placeholder = "Cost code",
  align = "start",
  open,
  onOpenChange,
  children,
}: {
  costCodes: CostCode[]
  value: string | null
  onSelect: (code: CostCode) => void
  preferDivision?: string | null
  placeholder?: string
  align?: "start" | "end"
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const isOpen = open ?? uncontrolled
  const setOpen = onOpenChange ?? setUncontrolled

  const options = useMemo(() => {
    const pickable = pickableCostCodes(costCodes)
    if (!preferDivision) return pickable
    return [
      ...pickable.filter((code) => code.division === preferDivision),
      ...pickable.filter((code) => code.division !== preferDivision),
    ]
  }, [costCodes, preferDivision])

  const selected = value ? costCodes.find((code) => code.id === value) ?? null : null

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ?? (
          <Button
            type="button"
            variant="ghost"
            role="combobox"
            aria-expanded={isOpen}
            aria-label="Cost code"
            className={cn(
              "group/code h-7 w-full justify-between gap-1 rounded-none px-1.5 text-left font-mono text-[11px] font-normal",
              !selected && "text-muted-foreground",
            )}
          >
            <span className="truncate">{selected?.code ?? placeholder}</span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 group-focus/code:opacity-100" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] p-0" align={align}>
        <Command
          filter={(itemValue, search) => {
            const haystack = itemValue.toLowerCase()
            const needle = search.toLowerCase().trim()
            if (!needle) return 1
            // Every word has to appear, so "06 framing" narrows instead of widening.
            return needle.split(/\s+/).every((token) => haystack.includes(token)) ? 1 : 0
          }}
        >
          <CommandInput placeholder="Search code or name…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No cost code matches.</CommandEmpty>
            <CommandGroup>
              {options.map((code) => (
                <CommandItem
                  key={code.id}
                  value={`${code.code} ${code.name} ${code.division ?? ""} ${code.id}`}
                  onSelect={() => {
                    onSelect(code)
                    setOpen(false)
                  }}
                >
                  <Check className={cn("size-4 shrink-0", code.id === value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="font-mono text-xs">{code.code}</span>
                      <span className="ml-2 text-xs">{code.name}</span>
                    </span>
                    {code.unit || code.default_unit_cost_cents != null ? (
                      <span className="block truncate text-[10px] tabular-nums text-muted-foreground">
                        {code.default_unit_cost_cents != null
                          ? `${centsToDollars(code.default_unit_cost_cents)} / ${code.unit ?? "ea"}`
                          : `per ${code.unit}`}
                      </span>
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
