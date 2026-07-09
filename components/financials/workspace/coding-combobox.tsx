"use client"

import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export interface CodingComboboxOption {
  id: string
  label: string
  sublabel?: string
  /** Extra text matched by the search box (defaults to label). */
  searchValue?: string
}

interface CodingComboboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  /** Current selection shown on the trigger. */
  triggerLabel: string
  triggerSublabel?: string
  searchPlaceholder: string
  groupHeading: string
  emptyLabel: string
  options: CodingComboboxOption[]
  selectedId: string | null
  /** Optional leading item that selects null (e.g. "No cost code", "Auto match"). */
  clearOption?: { label: string; sublabel?: string }
  onSelect: (id: string | null) => void
  contentMinWidthClass?: string
}

/**
 * The in-cell coding picker used across the expense and payable tables:
 * a full-cell ghost trigger with a two-line current value, opening a
 * searchable command list.
 */
export function CodingCombobox({
  open,
  onOpenChange,
  disabled,
  triggerLabel,
  triggerSublabel,
  searchPlaceholder,
  groupHeading,
  emptyLabel,
  options,
  selectedId,
  clearOption,
  onSelect,
  contentMinWidthClass = "min-w-[280px]",
}: CodingComboboxProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{triggerLabel}</span>
            {triggerSublabel ? (
              <span className="block truncate text-[11px] text-muted-foreground">{triggerSublabel}</span>
            ) : null}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("w-[var(--radix-popover-trigger-width)] p-0", contentMinWidthClass)} align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-72 overflow-y-auto">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup heading={groupHeading}>
              {clearOption ? (
                <CommandItem value={clearOption.label} onSelect={() => onSelect(null)}>
                  <Check className={cn("size-4", selectedId ? "opacity-0" : "opacity-100")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{clearOption.label}</span>
                    {clearOption.sublabel ? (
                      <span className="block truncate text-xs text-muted-foreground">{clearOption.sublabel}</span>
                    ) : null}
                  </span>
                </CommandItem>
              ) : null}
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.searchValue ?? option.label}
                  onSelect={() => onSelect(option.id)}
                >
                  <Check className={cn("size-4", option.id === selectedId ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.sublabel ? (
                      <span className="block truncate text-xs text-muted-foreground">{option.sublabel}</span>
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
