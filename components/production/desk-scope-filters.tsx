"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ProductionScopeOption } from "@/lib/services/production-desk-scope"

export function DeskScopeFilters({
  communities,
  divisions,
  communityId,
  divisionId,
  className = "",
}: {
  communities: ProductionScopeOption[]
  divisions: ProductionScopeOption[]
  communityId?: string
  divisionId?: string
  className?: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  if (communities.length === 0 && divisions.length === 0) return null

  function setFilter(key: "community" | "division", value: string) {
    const params = new URLSearchParams(searchParams)
    if (value === "all") params.delete(key)
    else params.set(key, value)
    router.push(`${pathname}${params.size ? `?${params}` : ""}`)
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {communities.length > 0 ? (
        <Select value={communityId ?? "all"} onValueChange={(value) => setFilter("community", value)}>
          <SelectTrigger className="h-8 w-48 rounded-none text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All communities</SelectItem>
            {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      {divisions.length > 0 ? (
        <Select value={divisionId ?? "all"} onValueChange={(value) => setFilter("division", value)}>
          <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All divisions</SelectItem>
            {divisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
