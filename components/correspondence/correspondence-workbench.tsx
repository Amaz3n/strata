"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { CLASSIFICATION_LABELS, CORRESPONDENCE_CLASSIFICATIONS } from "@/lib/correspondence"
import { unwrapAction } from "@/lib/action-result"
import type {
  CorrespondenceListItem,
  CorrespondenceListPage,
  CorrespondenceReaderTarget,
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Inbox,
  Search,
  X,
} from "@/components/icons"
import { CorrespondenceAddMenu } from "@/components/correspondence/correspondence-add-menu"
import { CorrespondenceDialog } from "@/components/correspondence/correspondence-dialog"
import { CorrespondenceFilterMenu } from "@/components/correspondence/correspondence-filter-menu"
import { CorrespondenceTable } from "@/components/correspondence/correspondence-table"
import { LinkDialog } from "@/components/correspondence/correspondence-link-dialog"
import {
  activeFilterCount,
  correspondenceFilterHref,
  correspondenceHref,
  correspondenceParams,
} from "@/components/correspondence/correspondence-url"
import {
  archiveProjectEmailsAction,
  confirmProjectEmailClassificationsAction,
  reclassifyProjectEmailsAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"
import { cn } from "@/lib/utils"

/**
 * The correspondence workbench: a toolbar, a full-bleed table, and a dialog.
 *
 * It holds no filter state — the server has already read the filters and the
 * open conversation out of the URL. The only local state is the bulk selection,
 * which is about acting on the list rather than describing it, and the two
 * flags that cover the round trip between clicking a row and the server sending
 * that conversation back.
 */
export function CorrespondenceWorkbench({
  projectId,
  inbox,
  list,
  filters,
  target,
  canWrite,
}: {
  projectId: string
  inbox: ProjectCorrespondenceInbox
  list: CorrespondenceListPage
  filters: CorrespondenceFilterInput
  target: CorrespondenceReaderTarget | null
  canWrite: boolean
}) {
  const router = useRouter()
  const [acting, startAction] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [linkEmailId, setLinkEmailId] = useState<string | null>(null)

  /**
   * The URL owns which conversation is open. These two only cover the gap
   * around it: `requestedId` opens the dialog on the click, before the server
   * has sent the messages; `dismissed` closes it on the click, before the
   * server has taken the parameter back out of the URL. Both stand down as soon
   * as the URL catches up.
   */
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    setRequestedId(null)
    setDismissed(false)
  }, [target])

  // A new page of results is a new selection; keeping ids across a filter
  // change would act on rows the user can no longer see.
  useEffect(() => setSelected(new Set()), [list])

  const narrowed = Boolean(filters.search) || activeFilterCount(filters) > 0 || filters.status === "unfiled"
  const nothingOnFile = list.total === 0 && !narrowed

  const openItem = (item: CorrespondenceListItem) => {
    setRequestedId(item.id)
    router.push(
      correspondenceHref(projectId, filters, {
        thread: item.kind === "thread" ? item.id : null,
        email: item.kind === "message" ? item.id : null,
      }),
      { scroll: false },
    )
  }

  const closeDialog = () => {
    setDismissed(true)
    router.push(correspondenceHref(projectId, filters, { email: null, thread: null }), { scroll: false })
  }

  const runBulk = (work: () => Promise<unknown>, success: string) => {
    startAction(async () => {
      try {
        await work()
        toast.success(success)
        setSelected(new Set())
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong")
      }
    })
  }

  // A page of the log is homogeneous: filed mail selects as conversations,
  // unfiled mail as the loose messages it is.
  const selection =
    filters.status === "unfiled"
      ? { projectId, emailIds: [...selected] }
      : { projectId, threadIds: [...selected] }

  // The packet covers the filtered log, not the page of it on screen.
  const exportQuery = correspondenceParams({ ...filters, page: 1 }).toString()
  const exportHref = `/projects/${projectId}/exports/correspondence${exportQuery ? `?${exportQuery}` : ""}`

  const pageCount = Math.max(1, Math.ceil(list.total / list.pageSize))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b bg-background/95 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 ? (
            <BulkBar
              count={selected.size}
              unfiled={filters.status === "unfiled"}
              acting={acting}
              onConfirm={() =>
                runBulk(
                  async () => unwrapAction(await confirmProjectEmailClassificationsAction(selection)),
                  "Classifications confirmed",
                )
              }
              onReclassify={(classification) =>
                runBulk(
                  async () =>
                    unwrapAction(await reclassifyProjectEmailsAction({ ...selection, classification })),
                  "Classification updated",
                )
              }
              onArchive={(archived) =>
                runBulk(
                  async () => unwrapAction(await archiveProjectEmailsAction({ ...selection, archived })),
                  archived ? "Taken out of the log" : "Restored to the log",
                )
              }
              onClear={() => setSelected(new Set())}
            />
          ) : (
            <>
              <SearchField projectId={projectId} filters={filters} />
              <CorrespondenceFilterMenu projectId={projectId} filters={filters} />
              <div className="ml-auto flex items-center gap-2">
                {filters.status === "filed" && list.total > 0 && (
                  <Button variant="outline" size="sm" className="h-8" asChild>
                    <a href={exportHref} target="_blank" rel="noreferrer">
                      <FileText className="size-4" />
                      Export
                    </a>
                  </Button>
                )}
                <CorrespondenceAddMenu inbox={inbox} />
              </div>
            </>
          )}
        </div>
      </div>

      {nothingOnFile ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No correspondence</EmptyTitle>
              <EmptyDescription>
                {inbox.address
                  ? "Forward or BCC mail to this project's address and it lands here."
                  : "Email filing isn't switched on for this deployment yet."}
              </EmptyDescription>
            </EmptyHeader>
            {inbox.address && (
              <EmptyContent>
                <code className="w-full break-all border bg-muted px-3 py-2 font-mono text-xs">
                  {inbox.address}
                </code>
              </EmptyContent>
            )}
          </Empty>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CorrespondenceTable
            filters={filters}
            list={list}
            openId={requestedId ?? target?.id ?? null}
            selected={selected}
            canWrite={canWrite}
            onOpen={openItem}
            onToggle={(item, checked) =>
              setSelected((current) => {
                const next = new Set(current)
                if (checked) next.add(item.id)
                else next.delete(item.id)
                return next
              })
            }
            onToggleAll={(checked) =>
              setSelected(checked ? new Set(list.items.map((item) => item.id)) : new Set())
            }
          />
        </div>
      )}

      {list.total > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {(list.page - 1) * list.pageSize + 1}–{Math.min(list.page * list.pageSize, list.total)} of{" "}
            {list.total}
            {filters.status === "unfiled" ? " unfiled" : list.total === 1 ? " conversation" : " conversations"}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={list.page <= 1}
                onClick={() =>
                  router.push(
                    correspondenceHref(projectId, filters, {
                      page: list.page === 2 ? null : String(list.page - 1),
                      email: null,
                      thread: null,
                    }),
                    { scroll: false },
                  )
                }
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <span className="px-1 tabular-nums">
                {list.page} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={list.page >= pageCount}
                onClick={() =>
                  router.push(
                    correspondenceHref(projectId, filters, {
                      page: String(list.page + 1),
                      email: null,
                      thread: null,
                    }),
                    { scroll: false },
                  )
                }
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <CorrespondenceDialog
        projectId={projectId}
        target={target}
        open={!dismissed && Boolean(target || requestedId)}
        loading={Boolean(requestedId) && requestedId !== target?.id}
        canWrite={canWrite}
        onOpenChange={(next) => !next && closeDialog()}
        onLink={setLinkEmailId}
      />

      <LinkDialog
        projectId={projectId}
        emailId={linkEmailId}
        onOpenChange={(open) => !open && setLinkEmailId(null)}
        onLinked={() => router.refresh()}
      />
    </div>
  )
}

function SearchField({
  projectId,
  filters,
}: {
  projectId: string
  filters: CorrespondenceFilterInput
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(filters.search ?? "")
  useEffect(() => setDraft(filters.search ?? ""), [filters.search])

  const submit = (value: string) => {
    router.push(correspondenceFilterHref(projectId, filters, { q: value.trim() || null }), { scroll: false })
  }

  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault()
        submit(draft)
      }}
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        name="q"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search mail"
        aria-label="Search correspondence"
        className="h-8 w-56 pl-8 pr-8 text-sm sm:w-72"
      />
      {draft && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear search"
          className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
          onClick={() => {
            setDraft("")
            submit("")
          }}
        >
          <X className="size-4" />
        </Button>
      )}
    </form>
  )
}

function BulkBar({
  count,
  unfiled,
  acting,
  onConfirm,
  onReclassify,
  onArchive,
  onClear,
}: {
  count: number
  unfiled: boolean
  acting: boolean
  onConfirm: () => void
  onReclassify: (classification: (typeof CORRESPONDENCE_CLASSIFICATIONS)[number]) => void
  onArchive: (archived: boolean) => void
  onClear: () => void
}) {
  return (
    <>
      <span className={cn("text-sm font-medium tabular-nums", acting && "opacity-70")}>{count} selected</span>
      {unfiled ? (
        <Button size="sm" variant="outline" className="h-8" disabled={acting} onClick={() => onArchive(false)}>
          <ArchiveRestore className="size-4" />
          Restore
        </Button>
      ) : (
        <>
          <Button size="sm" className="h-8" disabled={acting} onClick={onConfirm}>
            <Check className="size-4" />
            Confirm
          </Button>
          {/*
            A menu, not a select: this picks an action to run once, and a select
            would keep showing the last thing chosen as if it were the state of
            the selection.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8" disabled={acting}>
                Reclassify as…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {CORRESPONDENCE_CLASSIFICATIONS.map((value) => (
                <DropdownMenuItem key={value} onSelect={() => onReclassify(value)}>
                  {CLASSIFICATION_LABELS[value]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" className="h-8" disabled={acting} onClick={() => onArchive(true)}>
            <Archive className="size-4" />
            Unfile
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" className="ml-auto h-8" onClick={onClear}>
        Clear
      </Button>
    </>
  )
}
