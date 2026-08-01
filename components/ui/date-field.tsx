"use client"

import { useState } from "react"
import { format } from "date-fns"
import { CalendarDays } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Parses a `YYYY-MM-DD` value as a local date. Going through `new Date(string)`
 * would read it as UTC and land on the previous day west of Greenwich.
 */
export function parseDateValue(value?: string | null): Date | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10))
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function formatDateValue(date?: Date): string {
  if (!date) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

interface DateFieldProps {
  label?: string
  /** `YYYY-MM-DD`, or empty for no selection. */
  value: string
  onChange: (value: string) => void
  placeholder?: string
  id?: string
  disabled?: boolean
  /** Renders a clear control once a date is set. */
  clearable?: boolean
  className?: string
}

/**
 * Single-date picker: a calendar in a popover rather than a native date input,
 * which renders inconsistently across browsers and is awkward on touch.
 */
export function DateField({
  label,
  value,
  onChange,
  placeholder = "Pick a date",
  id,
  disabled = false,
  clearable = false,
  className,
}: DateFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = parseDateValue(value)

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn(
                "w-full justify-start text-left font-normal tabular-nums",
                !selected && "text-muted-foreground",
              )}
            >
              <CalendarDays className="mr-2 size-4 shrink-0" />
              {selected ? format(selected, "LLL d, yyyy") : placeholder}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selected}
              onSelect={(date) => {
                onChange(formatDateValue(date))
                setOpen(false)
              }}
              autoFocus
            />
          </PopoverContent>
        </Popover>
        {clearable && selected ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange("")}
            className="shrink-0 text-muted-foreground"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  )
}
