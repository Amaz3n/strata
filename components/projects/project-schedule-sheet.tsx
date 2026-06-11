"use client"

import { useEffect, useState, type CSSProperties } from "react"

import { OptimisticLink as Link } from "@/lib/navigation/optimistic-pathname"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { ArrowUpRight } from "@/components/icons"
import { getProjectScheduleItemsAction } from "@/app/(app)/projects/actions"
import type { ProjectScheduleSummary, ScheduleItem } from "@/lib/types"
import { cn } from "@/lib/utils"

interface ProjectScheduleSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  projectName: string
  summary: ProjectScheduleSummary | null
}

function formatDate(value?: string) {
  if (!value) return null
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatRange(item: ScheduleItem) {
  const start = formatDate(item.start_date)
  const end = formatDate(item.end_date)
  if (start && end) return `${start} – ${end}`
  if (start) return `Starts ${start}`
  if (end) return `Due ${end}`
  return "No dates"
}

const dotByStatus: Record<string, string> = {
  in_progress: "bg-primary",
  at_risk: "bg-warning",
  blocked: "bg-destructive",
  planned: "bg-muted-foreground/40",
  completed: "bg-success",
}

function ItemRow({ item, trailing }: { item: ScheduleItem; trailing?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dotByStatus[item.status] ?? "bg-muted-foreground/40")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{item.name}</p>
        <p className="text-xs text-muted-foreground">{formatRange(item)}</p>
      </div>
      {trailing}
    </li>
  )
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      <ul className="mt-1 divide-y">{children}</ul>
    </div>
  )
}

export function ProjectScheduleSheet({ open, onOpenChange, projectId, projectName, summary }: ProjectScheduleSheetProps) {
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [loading, setLoading] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoading(true)
    setShowCompleted(false)
    getProjectScheduleItemsAction(projectId)
      .then((data) => {
        if (!cancelled) setItems(data)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  const active = items.filter((i) => i.status === "in_progress" || i.status === "at_risk" || i.status === "blocked")
  const upcoming = items
    .filter((i) => i.status === "planned")
    .sort((a, b) => (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999"))
  const completed = items.filter((i) => i.status === "completed")
  const percent = summary?.percent ?? 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 p-0 sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-md shadow-2xl fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <div className="border-b px-6 pb-5 pt-6">
          <SheetTitle className="text-base font-semibold">{projectName}</SheetTitle>
          <SheetDescription className="sr-only">Schedule progress as of today</SheetDescription>
          <div className="mt-4 flex items-end justify-between">
            <span className="text-3xl font-semibold tabular-nums">{percent}%</span>
            <span className="text-xs text-muted-foreground">complete · as of today</span>
          </div>
          <Progress value={percent} className="mt-2" />
          {summary && summary.total > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {summary.completed} done · {summary.in_progress} in progress · {summary.upcoming} upcoming
            </p>
          ) : null}
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Spinner className="h-4 w-4" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No schedule items yet for this project.</p>
          ) : (
            <>
              <Section label="In progress" count={active.length}>
                {active.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    trailing={<span className="text-xs tabular-nums text-muted-foreground">{item.progress ?? 0}%</span>}
                  />
                ))}
              </Section>

              <Section label="Up next" count={upcoming.length}>
                {upcoming.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </Section>

              {completed.length > 0 ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowCompleted((v) => !v)}
                    className="flex w-full items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span>Completed</span>
                    <span>{showCompleted ? "Hide" : completed.length}</span>
                  </button>
                  {showCompleted ? (
                    <ul className="mt-1 divide-y">
                      {completed.map((item) => (
                        <ItemRow key={item.id} item={item} />
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        {projectId ? (
          <div className="shrink-0 border-t bg-background p-4">
            <Button asChild variant="outline" className="w-full">
              <Link href={`/projects/${projectId}/schedule`}>
                View full schedule
                <ArrowUpRight className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
