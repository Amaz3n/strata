"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { CLASSIFICATION_LABELS, CORRESPONDENCE_CLASSIFICATIONS } from "@/lib/correspondence"
import { unwrapAction } from "@/lib/action-result"
import type {
  ArchivedCorrespondencePage,
  CorrespondenceMessage,
  CorrespondenceThreadPage,
  ProjectCorrespondenceInbox,
} from "@/lib/services/correspondence"
import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Archive, ArchiveRestore, Check, ChevronLeft, ChevronRight, FileText } from "@/components/icons"
import { CorrespondenceAddMenu } from "@/components/correspondence/correspondence-add-menu"
import { CorrespondenceFilters, type FilterChanges } from "@/components/correspondence/correspondence-filters"
import {
  ArchivedCorrespondenceTable,
  CorrespondenceThreadTable,
} from "@/components/correspondence/correspondence-thread-table"
import {
  CorrespondenceDetailSheet,
  type DetailTarget,
} from "@/components/correspondence/correspondence-detail-sheet"
import { LinkDialog } from "@/components/correspondence/correspondence-link-dialog"
import {
  archiveProjectEmailsAction,
  confirmProjectEmailClassificationsAction,
  reclassifyProjectEmailsAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"
import { cn } from "@/lib/utils"

export function CorrespondenceClient({
  projectId,
  inbox,
  threads,
  archived,
  filters,
  showArchived,
  openEmailId,
  openThreadId,
  canWrite,
}: {
  projectId: string
  inbox: ProjectCorrespondenceInbox
  threads: CorrespondenceThreadPage | null
  archived: ArchivedCorrespondencePage | null
  filters: CorrespondenceFilterInput
  showArchived: boolean
  openEmailId: string | null
  openThreadId: string | null
  canWrite: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [navigating, startNavigation] = useTransition()
  const [acting, startAction] = useTransition()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [linkEmailId, setLinkEmailId] = useState<string | null>(null)

  // A new page of results is a new selection; keeping ids across a filter change
  // would act on rows the user can no longer see.
  useEffect(() => setSelected(new Set()), [threads, archived])

  const setParams = useCallback(
    (changes: FilterChanges) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key)
        else next.set(key, value)
      }
      const query = next.toString()
      startNavigation(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
      })
    },
    [pathname, router, searchParams],
  )

  const target: DetailTarget | null = openEmailId
    ? { kind: "message", emailId: openEmailId }
    : openThreadId
      ? { kind: "thread", threadId: openThreadId }
      : null

  const total = showArchived ? (archived?.total ?? 0) : (threads?.total ?? 0)
  const pageSize = showArchived ? (archived?.pageSize ?? 50) : (threads?.pageSize ?? 50)
  const page = showArchived ? (archived?.page ?? 1) : (threads?.page ?? 1)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const reviewCount = (threads?.threads ?? []).reduce((sum, thread) => sum + thread.unreviewed_count, 0)

  const exportHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("email")
    params.delete("thread")
    params.delete("view")
    params.delete("page")
    const query = params.toString()
    return `/projects/${projectId}/exports/correspondence${query ? `?${query}` : ""}`
  }, [projectId, searchParams])

  /**
   * A ruling reaches the list either way: the server revalidates the page, and
   * the rows the user just acted on are cleared from the selection so the bulk
   * bar reflects what is still pending.
   */
  const afterMutation = useCallback(() => {
    setSelected(new Set())
    router.refresh()
  }, [router])

  const runBulk = (work: () => Promise<CorrespondenceMessage[]>, success: string) => {
    startAction(async () => {
      try {
        await work()
        toast.success(success)
        afterMutation()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong")
      }
    })
  }

  const selection = showArchived
    ? { projectId, emailIds: [...selected] }
    : { projectId, threadIds: [...selected] }

  const emptyMessage = useMemo(() => {
    const filtersActive =
      Boolean(filters.search) ||
      Boolean(filters.classification) ||
      Boolean(filters.direction) ||
      Boolean(filters.linked) ||
      Boolean(filters.from) ||
      Boolean(filters.to) ||
      filters.needsReview === true ||
      filters.hasAttachments === true
    if (filtersActive) return "No conversation matches these filters."
    if (!inbox.address) return "This project has no correspondence on file."
    return "No correspondence yet. Forward or BCC mail to this project's address — it's under Add."
  }, [filters, inbox.address])

  return (
    <div className={cn("space-y-4", navigating && "opacity-60 transition-opacity")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant={showArchived ? "ghost" : "secondary"}
            size="sm"
            onClick={() => setParams({ view: null, page: null })}
          >
            Log
          </Button>
          <Button
            variant={showArchived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setParams({ view: "archived", page: null })}
          >
            Unfiled
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={exportHref} target="_blank" rel="noreferrer">
              <FileText className="size-4" />
              Export
            </a>
          </Button>
          <CorrespondenceAddMenu inbox={inbox} />
        </div>
      </div>

      <CorrespondenceFilters
        filters={filters}
        showArchived={showArchived}
        pending={navigating}
        reviewCount={reviewCount}
        onChange={setParams}
      />

      {canWrite && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border bg-secondary/40 px-3 py-2">
          <span className="text-sm font-medium tabular-nums">
            {selected.size} selected
          </span>
          {showArchived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={acting}
              onClick={() =>
                runBulk(
                  async () =>
                    unwrapAction(await archiveProjectEmailsAction({ ...selection, archived: false })),
                  "Messages restored to the log",
                )
              }
            >
              <ArchiveRestore className="size-4" />
              Restore
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                disabled={acting}
                onClick={() =>
                  runBulk(
                    async () => unwrapAction(await confirmProjectEmailClassificationsAction(selection)),
                    "Classifications confirmed",
                  )
                }
              >
                <Check className="size-4" />
                Confirm
              </Button>
              {/*
                A menu, not a select: this picks an action to run once, and a
                select would keep showing the last thing chosen as if it were
                the state of the selection.
              */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={acting}>
                    Reclassify as…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() =>
                        runBulk(
                          async () =>
                            unwrapAction(
                              await reclassifyProjectEmailsAction({ ...selection, classification: value }),
                            ),
                          "Classification updated",
                        )
                      }
                    >
                      {CLASSIFICATION_LABELS[value]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                variant="outline"
                disabled={acting}
                onClick={() =>
                  runBulk(
                    async () =>
                      unwrapAction(await archiveProjectEmailsAction({ ...selection, archived: true })),
                    "Messages unfiled",
                  )
                }
              >
                <Archive className="size-4" />
                Unfile
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {showArchived ? (
        <ArchivedCorrespondenceTable
          projectId={projectId}
          messages={archived?.messages ?? []}
          selected={selected}
          canWrite={canWrite}
          onToggle={(emailId, checked) =>
            setSelected((current) => {
              const next = new Set(current)
              if (checked) next.add(emailId)
              else next.delete(emailId)
              return next
            })
          }
          onOpen={(emailId) => setParams({ email: emailId, thread: null })}
        />
      ) : (
        <CorrespondenceThreadTable
          threads={threads?.threads ?? []}
          selected={selected}
          canWrite={canWrite}
          onToggle={(threadId, checked) =>
            setSelected((current) => {
              const next = new Set(current)
              if (checked) next.add(threadId)
              else next.delete(threadId)
              return next
            })
          }
          onToggleAll={(checked) =>
            setSelected(checked ? new Set((threads?.threads ?? []).map((thread) => thread.thread_id)) : new Set())
          }
          onOpen={(threadId) => setParams({ thread: threadId, email: null })}
          emptyMessage={emptyMessage}
        />
      )}

      {total > 0 && (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            {showArchived ? " unfiled" : total === 1 ? " conversation" : " conversations"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || navigating}
              onClick={() => setParams({ page: page <= 2 ? null : String(page - 1) })}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount || navigating}
              onClick={() => setParams({ page: String(page + 1) })}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      <CorrespondenceDetailSheet
        projectId={projectId}
        target={target}
        canWrite={canWrite}
        onClose={() => setParams({ email: null, thread: null })}
        onMessagesChanged={afterMutation}
        onLink={setLinkEmailId}
      />

      <LinkDialog
        projectId={projectId}
        emailId={linkEmailId}
        onOpenChange={(open) => !open && setLinkEmailId(null)}
        onLinked={() => afterMutation()}
      />
    </div>
  )
}
