"use client"

import type { ReactNode } from "react"
import Link from "next/link"

import "./studio.css"

type StudioSurface = "runway" | "catalog" | "rules"

const SURFACES: Array<{ key: StudioSurface; label: string; href: string }> = [
  { key: "runway", label: "Runway", href: "/design-studio" },
  { key: "catalog", label: "Catalog", href: "/design-studio/catalog" },
  { key: "rules", label: "Cutoff rules", href: "/design-studio/rules" },
]

interface Props {
  active: StudioSurface
  action?: ReactNode
  children: ReactNode
}

/**
 * The frame every studio surface sits in. Community scope is ambient — it comes
 * from the header lens, not from a control on the desk — so this frame only has
 * to carry the surface tabs and whatever action the surface owns.
 */
export function StudioShell({ active, action, children }: Props) {
  return (
    <div className="studio flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 border-border bg-card">
        <nav className="flex items-center gap-1" aria-label="Design studio surfaces">
          {SURFACES.map((surface) => {
            const isActive = surface.key === active
            return (
              <Link
                key={surface.key}
                href={surface.href}
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
        {action}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {children}
      </div>
    </div>
  )
}
