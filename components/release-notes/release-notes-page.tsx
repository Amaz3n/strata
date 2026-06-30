"use client"

import { useEffect, useMemo, useTransition } from "react"
import Link from "next/link"
import { format } from "date-fns"

import { markReleaseNotesSeenAction } from "@/app/actions/release-notes"
import { ArrowRight, CheckCircle2, Sparkles, Wrench, Shield, Phone } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ReleaseNote, ReleaseNoteCategory } from "@/lib/services/release-notes"
import { cn } from "@/lib/utils"

const CATEGORY_STYLES: Record<
  ReleaseNoteCategory,
  { label: string; icon: typeof Sparkles; className: string }
> = {
  new: {
    label: "New",
    icon: Sparkles,
    className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  improved: {
    label: "Improved",
    icon: CheckCircle2,
    className: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  fixed: {
    label: "Fixed",
    icon: Wrench,
    className: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  admin: {
    label: "Admin",
    icon: Shield,
    className: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  mobile: {
    label: "Mobile",
    icon: Phone,
    className: "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
}

function formatReleaseDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Recently"
  return format(date, "MMM d, yyyy")
}

export function ReleaseNotesPage({ notes }: { notes: ReleaseNote[] }) {
  const [, startTransition] = useTransition()
  const noteIds = useMemo(() => notes.map((note) => note.id), [notes])

  useEffect(() => {
    if (noteIds.length === 0) return

    startTransition(() => {
      markReleaseNotesSeenAction(noteIds).catch((error) => {
        console.error("Unable to mark release notes seen", error)
      })
    })

    window.dispatchEvent(
      new CustomEvent("arc-release-notes-unread-change", { detail: { unreadCount: 0 } }),
    )
  }, [noteIds, startTransition])

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 pb-12">
      <section className="border-b border-border pb-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="size-4" />
            Arc keeps getting better
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-normal">What&apos;s New</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Small improvements, fixes, and new workflows shipped steadily into your Arc workspace.
              </p>
            </div>
            <Button variant="outline" asChild>
              <Link href="/help">Help Center</Link>
            </Button>
          </div>
        </div>
      </section>

      {notes.length === 0 ? (
        <div className="border border-border bg-card p-8 text-center">
          <h2 className="text-lg font-semibold">No updates yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            New Arc improvements will show up here when they are published.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {notes.map((note) => {
            const category = CATEGORY_STYLES[note.category]
            const Icon = category.icon

            return (
              <article key={note.id} className="border border-border bg-card p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("gap-1.5", category.className)}>
                        <Icon className="size-3" />
                        {category.label}
                      </Badge>
                      {!note.seenAt && note.visibility !== "quiet" && (
                        <span className="text-xs font-medium text-primary">Unread</span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatReleaseDate(note.publishedAt)}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-xl font-semibold tracking-normal">{note.title}</h2>
                      <p className="text-sm leading-6 text-muted-foreground">{note.summary}</p>
                      {note.body && (
                        <p className="text-sm leading-6 text-foreground/85">{note.body}</p>
                      )}
                    </div>
                  </div>

                  {note.href && (
                    <Button variant="ghost" className="shrink-0 justify-start" asChild>
                      <Link href={note.href}>
                        {note.ctaLabel ?? "Open"}
                        <ArrowRight data-icon="inline-end" />
                      </Link>
                    </Button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
