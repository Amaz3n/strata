"use client"

import { type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText } from "@/components/icons"

export type PortalStatusTone = "neutral" | "info" | "success" | "warning" | "danger"

const toneStyles: Record<PortalStatusTone, string> = {
  neutral: "bg-muted text-muted-foreground border-muted",
  info: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  success: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  danger: "bg-red-500/15 text-red-600 border-red-500/30",
}

interface QuotePortalShellProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  documentLabel: string
  statusLabel: string
  statusTone: PortalStatusTone
  /** URL to download/open the PDF version (kept as an artifact, not the primary view). */
  pdfUrl?: string | null
  /** Native document rendering shown as the primary view. */
  document: ReactNode
  /** Right-rail content: the action panel + thread. */
  children: ReactNode
}

export function QuotePortalShell({
  orgName,
  orgLogoUrl,
  documentLabel,
  statusLabel,
  statusTone,
  pdfUrl,
  document,
  children,
}: QuotePortalShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/50 via-muted/20 to-background">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <div className="flex items-center gap-2.5">
            {orgLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={orgLogoUrl} alt={orgName ?? "Logo"} className="h-8 w-8 border object-contain" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center border bg-muted text-xs font-bold">
                {(orgName ?? "A").slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="text-sm font-semibold">{orgName ?? "Arc"}</span>
          </div>
          <div className="flex items-center gap-2">
            {pdfUrl ? (
              <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Download </span>PDF
                </a>
              </Button>
            ) : null}
            <Badge variant="secondary" className={`border ${toneStyles[statusTone]}`}>
              {statusLabel}
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div>{document}</div>
          <aside className="flex flex-col gap-4 lg:sticky lg:top-[5.25rem] lg:self-start">{children}</aside>
        </div>
      </main>
    </div>
  )
}
