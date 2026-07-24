"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useTransition } from "react"

import { setCommunityContextAction, setDivisionContextAction } from "@/app/(app)/desk-context-actions"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"

interface FilterOption {
  id: string
  name: string
}

interface SalesDeskFiltersProps {
  divisions: FilterOption[]
  communities: FilterOption[]
  divisionId?: string
  communityId?: string
}

/** URL-backed division/community filters. The desk itself stays a server component. */
export function SalesDeskFilters({ divisions, communities, divisionId, communityId }: SalesDeskFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const setParam = (key: string, value: string) => {
    startTransition(async () => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === "all") params.delete(key)
      else params.set(key, value)
      if (key === "division") {
        unwrapAction(await setDivisionContextAction(value === "all" ? null : value))
        params.delete("community")
      } else {
        unwrapAction(await setCommunityContextAction(value === "all" ? null : value))
      }
      router.push(`/sales${params.size ? `?${params.toString()}` : ""}`)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {divisions.length > 0 ? (
        <Select disabled={pending} value={searchParams.get("division") ?? divisionId ?? "all"} onValueChange={(value) => setParam("division", value)}>
          <SelectTrigger className="h-8 w-44 text-xs">
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
      ) : null}
      <Select disabled={pending} value={searchParams.get("community") ?? communityId ?? "all"} onValueChange={(value) => setParam("community", value)}>
        <SelectTrigger className="h-8 w-48 text-xs">
          <SelectValue placeholder="All communities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All communities</SelectItem>
          {communities.map((community) => (
            <SelectItem key={community.id} value={community.id}>
              {community.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
