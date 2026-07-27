"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import "./studio.css"

type StudioSurface = "runway" | "catalog" | "rules"

const SURFACES: Array<{ key: StudioSurface; label: string; href: string }> = [
  { key: "runway", label: "Runway", href: "/design-studio" },
  { key: "catalog", label: "Catalog", href: "/design-studio/catalog" },
  { key: "rules", label: "Cutoff rules", href: "/design-studio/rules" },
]

interface Props {
  active: StudioSurface
  communityId?: string
  communities: Array<{ id: string; name: string }>
  action?: ReactNode
  children: ReactNode
}

/**
 * The frame every studio surface sits in. Community is a page-level scope
 * rather than a per-tab filter, so switching it keeps you on the surface you
 * were already working on.
 */
export function StudioShell({ active, communityId, communities, action, children }: Props) {
  const router = useRouter()
  const activeHref = SURFACES.find((surface) => surface.key === active)?.href ?? "/design-studio"

  function chooseCommunity(value: string) {
    router.replace(value === "org" ? activeHref : `${activeHref}?community=${value}`)
  }

  return (
    <div className="studio flex min-h-0 flex-1 flex-col">
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 border-border bg-card"
      >
        <nav className="flex items-center gap-1" aria-label="Design studio surfaces">
          {SURFACES.map((surface) => {
            const href = communityId ? `${surface.href}?community=${communityId}` : surface.href
            const isActive = surface.key === active
            return (
              <Link
                key={surface.key}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`px-3 py-1.5 text-[13px] transition-colors ${
                  isActive ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {surface.label}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-2">
          <Select value={communityId ?? "org"} onValueChange={chooseCommunity}>
            <SelectTrigger className="h-8 w-[220px] rounded-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="org">All communities</SelectItem>
              {communities.map((community) => (
                <SelectItem key={community.id} value={community.id}>
                  {community.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {action}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {children}
      </div>
    </div>
  )
}
