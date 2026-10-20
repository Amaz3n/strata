"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, type ReactNode } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { cn } from "@/lib/utils"
import { usePageTitle } from "@/components/layout/page-title-context"
import { isTradeSurface } from "@/lib/workspace-surface"
import { TEMPLATE_SECTIONS, resolveTemplateSection } from "./sections"

export function TemplatesNavigation({ children }: { children: ReactNode }) {
  const trade = isTradeSurface(usePageTitle().workspaceSurface)
  const section = resolveTemplateSection(useSearchParams().get("section"))
  const active = TEMPLATE_SECTIONS.find(entry => entry.key === section) ?? TEMPLATE_SECTIONS[0]
  const entries = trade ? TEMPLATE_SECTIONS.filter(entry => entry.key === "waivers") : TEMPLATE_SECTIONS
  return (
    <div className="group/template mx-auto w-full max-w-[1440px] py-4">
      <div className="group-has-[[data-waiver-workspace]]/template:hidden mb-6 flex items-end justify-between border-b pb-5">
        <div>
          <p className="mb-3 text-[10px] font-medium uppercase tracking-[.2em] text-muted-foreground">Your company’s starting points</p>
          <h1 className="text-3xl font-medium tracking-tight">Templates</h1>
          <p className="mt-3 text-sm text-muted-foreground">Set it up once. Make it yours every time.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[130px_minmax(0,1fr)] has-[[data-waiver-workspace]]:grid-cols-1">
        <nav aria-label="Template categories" className="space-y-1 group-has-[[data-waiver-workspace]]/template:hidden">
          <p className="px-3 pb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Library</p>
          {entries.map(entry => (
            <Link key={entry.key} href={`/settings/templates?section=${entry.key}`} prefetch
              aria-current={entry.key === section ? "page" : undefined}
              className={cn("block rounded-md px-3 py-2.5 text-sm transition-colors", entry.key === section ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
            >{entry.label}</Link>
          ))}
        </nav>
        <section className="min-w-0">
          {section !== "waivers" && <div className="mb-6">
            <h2 className="text-lg font-medium">{active.label}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{active.description}</p>
          </div>}
          <Suspense key={section} fallback={<TemplateLibraryLoading />}>{children}</Suspense>
        </section>
      </div>
    </div>
  )
}

export function TemplateLibraryLoading() {
  return <div role="status" aria-label="Loading template library" aria-busy="true"><PageLoadingSkeleton /></div>
}
