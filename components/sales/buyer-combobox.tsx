"use client"

import { useEffect, useRef, useState } from "react"

import { Check, ChevronDown, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { searchBuyerContactsAction } from "@/app/(app)/sales/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"

export interface BuyerOption {
  id: string
  name: string
  email: string | null
}

/** Capped, debounced buyer picker — never loads the full contacts table. */
export function BuyerCombobox({
  value,
  selectedName,
  onSelect,
  placeholder = "Search buyer contacts…",
  disabled,
}: {
  value: string | null
  selectedName?: string | null
  onSelect: (option: BuyerOption | null) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [options, setOptions] = useState<BuyerOption[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (timer.current) clearTimeout(timer.current)
    setLoading(true)
    timer.current = setTimeout(async () => {
      try {
        setOptions(unwrapAction(await searchBuyerContactsAction(query)))
      } catch {
        setOptions([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query, open])

  const label = selectedName ?? (value ? "Selected buyer" : null)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          className="h-9 w-full justify-between rounded-none px-3 text-left text-sm font-normal"
        >
          <span className={cn("truncate", !label && "text-muted-foreground")}>{label ?? placeholder}</span>
          <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] rounded-none p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a name or email"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {loading ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Searching…</p>
          ) : options.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">No matching contacts.</p>
          ) : (
            options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  onSelect(option)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{option.name}</span>
                  {option.email ? <span className="block truncate text-xs text-muted-foreground">{option.email}</span> : null}
                </span>
                {value === option.id ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
