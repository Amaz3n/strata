"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Activity } from "@/components/icons"
import type { DemoUsageSummary } from "@/lib/services/platform-demo-usage"

function formatRelative(timestamp?: string | null) {
  if (!timestamp) return "No activity yet"
  const diffMs = Date.now() - new Date(timestamp).getTime()
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000))
  if (diffMinutes < 1) return "Just now"
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}

export function DemoUsageSheet({ summary }: { summary: DemoUsageSummary }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 rounded-none" onClick={() => setOpen(true)}>
        <Activity className="mr-1.5 h-3.5 w-3.5" />
        Demo usage
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-md sm:rounded-none"
        >
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <SheetTitle>Demo usage</SheetTitle>
                <SheetDescription>Recent activity in the demo org.</SheetDescription>
              </div>
              <Badge variant={summary.tracking ? "default" : "outline"}>
                {summary.tracking ? "Tracking" : "Waiting"}
              </Badge>
            </div>
          </SheetHeader>

          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Last seen" value={formatRelative(summary.lastActivityAt)} />
              <Metric label="Logins" value={String(summary.logins)} />
              <Metric label="Page views" value={String(summary.pageViews)} />
            </div>

            <div className="border px-4 py-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">Demo user</p>
              <p className="mt-1 text-sm font-medium">{summary.demoUserLabel}</p>
              <p className="mt-1 text-xs text-muted-foreground">Last login {formatRelative(summary.lastLoginAt)}</p>
              <p className="text-xs text-muted-foreground">
                Last active {formatRelative(summary.membershipLastActiveAt)} · {summary.uniquePages} unique pages
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">Top pages</p>
              {summary.topPages.length ? (
                summary.topPages.map((page) => (
                  <div
                    key={page.path}
                    className="flex items-center justify-between gap-3 border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{page.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{page.path}</p>
                    </div>
                    <Badge variant="secondary">{page.count}</Badge>
                  </div>
                ))
              ) : (
                <p className="border px-3 py-2 text-sm text-muted-foreground">
                  No demo page views tracked yet.
                </p>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  )
}
