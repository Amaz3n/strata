"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ProductionScopeOption } from "@/lib/services/production-desk-scope"

/** Community is the page-level filter. Division scope lives in the app header. */
export function DeskScopeFilters({
  communities,
  communityId,
  className = "",
}: {
  communities: ProductionScopeOption[]
  communityId?: string
  className?: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  if (communities.length === 0) return null

  function setCommunity(value: string) {
    const params = new URLSearchParams(searchParams)
    if (value === "all") params.delete("community")
    else params.set("community", value)
    router.push(`${pathname}${params.size ? `?${params}` : ""}`)
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <Select value={communityId ?? "all"} onValueChange={setCommunity}>
        <SelectTrigger className="h-8 w-48 rounded-none text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All communities</SelectItem>
          {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}
