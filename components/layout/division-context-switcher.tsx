"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { setDivisionContextAction } from "@/app/(app)/desk-context-actions"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"

export function DivisionContextSwitcher({
  divisions,
  divisionId,
}: {
  divisions: Array<{ id: string; name: string }>
  divisionId?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Select
      value={divisionId ?? "all"}
      disabled={pending}
      onValueChange={(value) => {
        startTransition(async () => {
          try {
            unwrapAction(await setDivisionContextAction(value === "all" ? null : value))
            router.refresh()
          } catch (error) {
            toast.error("Unable to change division", { description: (error as Error).message })
          }
        })
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Division context"
        className="h-8 w-full rounded-none border-sidebar-border bg-sidebar text-xs group-data-[collapsible=icon]:hidden"
      >
        <SelectValue placeholder="All divisions" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All divisions</SelectItem>
        {divisions.map((division) => (
          <SelectItem key={division.id} value={division.id}>
            {division.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
