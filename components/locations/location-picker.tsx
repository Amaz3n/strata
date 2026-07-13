"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import { createLocationAction } from "@/app/(app)/projects/[id]/locations/actions"
import type { ProjectLocation } from "@/lib/services/locations"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Check, ChevronsUpDown, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"

export function LocationPicker({
  projectId,
  locations,
  value,
  onValueChange,
  canCreate = false,
  disabled = false,
  placeholder = "Select location",
}: {
  projectId: string
  locations: ProjectLocation[]
  value?: string | null
  onValueChange: (locationId: string | null, fullPath: string | null) => void
  canCreate?: boolean
  disabled?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [localLocations, setLocalLocations] = useState(locations)
  const [pending, startTransition] = useTransition()
  const selected = useMemo(() => localLocations.find((location) => location.id === value), [localLocations, value])
  const createName = query.trim()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} disabled={disabled} className="w-full justify-between font-normal">
          <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.full_path ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search locations…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No locations found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__none__" onSelect={() => { onValueChange(null, null); setOpen(false) }}>
                <Check className={cn("mr-2 h-4 w-4", value ? "opacity-0" : "opacity-100")} />
                No location
              </CommandItem>
              {localLocations.filter((location) => location.is_active).map((location) => (
                <CommandItem key={location.id} value={location.full_path} onSelect={() => { onValueChange(location.id, location.full_path); setOpen(false) }}>
                  <Check className={cn("mr-2 h-4 w-4", value === location.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{location.full_path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {canCreate && createName && !createName.includes(">") ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    disabled={pending}
                    value={`create-${createName}`}
                    onSelect={() => startTransition(async () => {
                      try {
                        const created = unwrapAction(await createLocationAction(projectId, { name: createName }))
                        setLocalLocations((current) => [...current, created].sort((a, b) => a.full_path.localeCompare(b.full_path)))
                        onValueChange(created.id, created.full_path)
                        setQuery("")
                        setOpen(false)
                        toast.success("Location created")
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Could not create location")
                      }
                    })}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Create “{createName}”
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

