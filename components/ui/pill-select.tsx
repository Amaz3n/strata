"use client"

import * as React from "react"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

/**
 * The icon-and-label metadata control used along the bottom of the app's
 * composer dialogs (new issue, new task, log activity). A Select wearing a pill,
 * not a new primitive — the trigger is the only thing that differs.
 */
export function PillSelect({
  name,
  value,
  defaultValue,
  onValueChange,
  icon: Icon,
  items,
  className,
  disabled,
  placeholder,
}: {
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  icon: React.ComponentType<{ className?: string }>
  items: { value: string; label: string }[]
  className?: string
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select name={name} value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={cn("w-fit justify-start rounded-none bg-muted/50 px-3", className)}>
        <Icon className="size-4" />
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
