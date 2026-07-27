"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { format } from "date-fns"

import { markReleaseNotesSeenAction } from "@/app/actions/release-notes"
import {
  createReleaseNoteAction,
  deleteReleaseNoteAction,
  updateReleaseNoteAction,
} from "@/app/(app)/whats-new/actions"
import { ArrowRight, PenLine, Plus, Trash2 } from "@/components/icons"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useToast } from "@/hooks/use-toast"
import type { FeatureFlagOrganization } from "@/lib/services/admin"
import type {
  AdminReleaseNote,
  ReleaseNote,
  ReleaseNoteArea,
} from "@/lib/services/release-notes"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

import {
  ReleaseEditor,
  editorFromNote,
  emptyEditor,
  inputFromEditor,
  type EditorState,
} from "./release-editor"
import { ReleaseItemGroups } from "./release-items"
import { AREA_LABELS, AREA_ORDER } from "./release-meta"

const ALL_AREAS = "all"

type FeedNote = ReleaseNote | AdminReleaseNote

function isDraft(note: FeedNote) {
  return "isPublished" in note && !note.isPublished
}

function parseDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function ReleaseEntry({
  note,
  unseen,
  canManage,
  onEdit,
  onDelete,
}: {
  note: FeedNote
  unseen: boolean
  canManage: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const publishedOn = parseDate(note.publishedAt)
  const draft = isDraft(note)

  return (
    <article
      data-release-id={note.id}
      className="group grid scroll-mt-6 gap-x-10 gap-y-4 border-t border-border py-10 first:border-t-0 first:pt-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
    >
      {/*
        Date, version and area live in the gutter so the reading column starts with the title.
        The gutter sticks while its release is on screen, which is what the month rail used to do.
      */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 self-start sm:sticky sm:top-6 sm:block">
        <div className="relative">
          {unseen && (
            <span
              aria-hidden
              className="absolute -left-3.5 top-[0.45rem] size-1.5 bg-primary sm:-left-4"
            />
          )}
          {publishedOn ? (
            <time
              dateTime={publishedOn.toISOString()}
              className={cn(
                "text-sm tabular-nums",
                unseen ? "font-medium text-foreground" : "text-foreground/70",
              )}
            >
              {format(publishedOn, "MMM d, yyyy")}
            </time>
          ) : (
            <span className="text-sm text-muted-foreground">Unscheduled</span>
          )}
        </div>

        <p className="text-xs text-muted-foreground sm:mt-1.5">
          {AREA_LABELS[note.area]}
          {note.version && (
            <span className="tabular-nums before:px-1.5 before:content-['·']">
              {note.version}
            </span>
          )}
        </p>

        {(draft || unseen) && (
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:mt-1.5">
            {draft ? "Draft" : "New"}
          </p>
        )}

        {canManage && (
          <div className="ml-auto flex items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:mt-3 sm:opacity-0">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={`Edit ${note.title}`}
              onClick={onEdit}
            >
              <PenLine className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={`Delete ${note.title}`}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="min-w-0 max-w-2xl">
        <h3 className="text-xl font-medium leading-snug tracking-tight text-foreground">
          {note.title}
        </h3>

        <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-foreground/85">
          {note.summary}
        </p>

        {note.body && (
          <div className="mt-3 flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
            {note.body.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        )}

        {note.items.length > 0 && (
          <div className="mt-6">
            <ReleaseItemGroups items={note.items} detailed />
          </div>
        )}

        {note.href && (
          <Link
            href={note.href}
            className="mt-6 inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {note.ctaLabel ?? "Open"}
            <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>

    </article>
  )
}

type ReaderProps = {
  notes: ReleaseNote[]
  canManage?: false
  organizations?: undefined
}

type ManageProps = {
  notes: AdminReleaseNote[]
  canManage: true
  organizations: FeatureFlagOrganization[]
}

export function ReleaseNotesPage(props: ReaderProps | ManageProps) {
  const canManage = props.canManage === true
  const organizations = props.organizations ?? []
  const [notes, setNotes] = useState<FeedNote[]>(props.notes)
  const [area, setArea] = useState<ReleaseNoteArea | typeof ALL_AREAS>(ALL_AREAS)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AdminReleaseNote | null>(null)
  const [busy, startTransition] = useTransition()
  const [, startSeenTransition] = useTransition()
  const { toast } = useToast()

  const feedRef = useRef<HTMLDivElement>(null)

  /**
   * Visiting the page marks everything seen, so the "new since your last visit" set has to be
   * captured on the first render — before that effect runs — and then held for the session.
   */
  const unseenIdsRef = useRef<Set<string> | null>(null)
  if (unseenIdsRef.current === null) {
    unseenIdsRef.current = new Set(
      canManage
        ? []
        : notes.filter((note) => !isDraft(note) && !note.seenAt).map((note) => note.id),
    )
  }
  const unseenIds = unseenIdsRef.current

  const readerNoteIds = useMemo(
    () => (canManage ? [] : notes.map((note) => note.id)),
    [canManage, notes],
  )

  useEffect(() => {
    if (canManage || readerNoteIds.length === 0) return

    startSeenTransition(() => {
      markReleaseNotesSeenAction(readerNoteIds).catch((error) => {
        console.error("Unable to mark release notes seen", error)
      })
    })

    window.dispatchEvent(
      new CustomEvent("arc-release-notes-unread-change", { detail: { unreadCount: 0 } }),
    )
  }, [canManage, readerNoteIds])

  const drafts = useMemo(() => notes.filter(isDraft), [notes])
  const published = useMemo(() => notes.filter((note) => !isDraft(note)), [notes])

  // Only areas that actually shipped something get a chip — six greyed-out buttons taught
  // nobody the taxonomy, and a filter with a single option is noise.
  const areaCounts = useMemo(() => {
    const counts = new Map<ReleaseNoteArea, number>()
    for (const note of published) {
      counts.set(note.area, (counts.get(note.area) ?? 0) + 1)
    }
    return AREA_ORDER.filter((candidate) => counts.has(candidate)).map((candidate) => ({
      area: candidate,
      count: counts.get(candidate) ?? 0,
    }))
  }, [published])

  const visible = useMemo(
    () => (area === ALL_AREAS ? published : published.filter((note) => note.area === area)),
    [published, area],
  )

  const unseenCount = useMemo(
    () => published.filter((note) => unseenIds.has(note.id)).length,
    [published, unseenIds],
  )

  function jumpToFirstUnseen() {
    const first = published.find((note) => unseenIds.has(note.id))
    if (!first) return
    setArea(ALL_AREAS)
    feedRef.current
      ?.querySelector<HTMLElement>(`[data-release-id="${first.id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  function saveEditor() {
    if (!editor) return
    const input = inputFromEditor(editor)

    startTransition(async () => {
      try {
        if (editor.id) {
          const updated = unwrapAction(await updateReleaseNoteAction(editor.id, input))
          setNotes((current) =>
            current.map((note) => (note.id === updated.id ? updated : note)),
          )
          toast({ title: "Release updated" })
        } else {
          const created = unwrapAction(await createReleaseNoteAction(input))
          setNotes((current) => [created, ...current])
          toast({ title: "Release published" })
        }
        setEditor(null)
      } catch (error) {
        toast({
          title: "Couldn't save release",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      }
    })
  }

  function confirmDelete() {
    if (!pendingDelete) return
    const target = pendingDelete

    startTransition(async () => {
      try {
        unwrapAction(await deleteReleaseNoteAction(target.id))
        setNotes((current) => current.filter((note) => note.id !== target.id))
        toast({ title: "Release deleted" })
      } catch (error) {
        toast({
          title: "Couldn't delete release",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      } finally {
        setPendingDelete(null)
      }
    })
  }

  function renderEntry(note: FeedNote) {
    const adminNote = "isPublished" in note ? note : null

    return (
      <ReleaseEntry
        key={note.id}
        note={note}
        unseen={unseenIds.has(note.id)}
        canManage={canManage && adminNote !== null}
        onEdit={() => {
          if (adminNote) setEditor(editorFromNote(adminNote))
        }}
        onDelete={() => {
          if (adminNote) setPendingDelete(adminNote)
        }}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl pb-16">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="max-w-xl">
          <p className="text-sm text-muted-foreground">
            Improvements and new workflows shipped into your Arc workspace.
          </p>
          {unseenCount > 0 && (
            <button
              type="button"
              onClick={jumpToFirstUnseen}
              className="mt-2 inline-flex items-center gap-2 text-sm text-foreground hover:underline"
            >
              <span aria-hidden className="size-1.5 bg-primary" />
              {unseenCount} new since your last visit
            </button>
          )}
        </div>

        {canManage && (
          <Button size="sm" onClick={() => setEditor({ ...emptyEditor })}>
            <Plus data-icon="inline-start" />
            New release
          </Button>
        )}
      </header>

      {areaCounts.length > 1 && (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={area}
          onValueChange={(next) =>
            setArea(next ? (next as ReleaseNoteArea | typeof ALL_AREAS) : ALL_AREAS)
          }
          className="mt-6 max-w-full overflow-x-auto"
          aria-label="Filter updates by area"
        >
          <ToggleGroupItem value={ALL_AREAS} className="flex-none px-3">
            All
            <span className="ml-1.5 tabular-nums opacity-60">{published.length}</span>
          </ToggleGroupItem>
          {areaCounts.map(({ area: candidate, count }) => (
            <ToggleGroupItem key={candidate} value={candidate} className="flex-none px-3">
              {AREA_LABELS[candidate]}
              <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {canManage && drafts.length > 0 && (
        <section className="mt-10">
          <h2 className="border-b border-border pb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Drafts
          </h2>
          <div className="mt-8 flex flex-col">{drafts.map(renderEntry)}</div>
        </section>
      )}

      {visible.length === 0 ? (
        <div className="mt-10 border-t border-border py-20 text-center">
          <p className="text-sm font-medium text-foreground">
            {published.length === 0 ? "Nothing here yet" : "No updates in this area"}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {published.length === 0
              ? "New Arc releases will show up here as they ship."
              : "Try a different filter to see what else shipped."}
          </p>
        </div>
      ) : (
        <div ref={feedRef} className="mt-12 flex flex-col">
          {visible.map(renderEntry)}
        </div>
      )}

      {canManage && editor && (
        <ReleaseEditor
          form={editor}
          organizations={organizations}
          busy={busy}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this release?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.title}&rdquo; and everything listed under it will be removed
              from What&apos;s New for everyone. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                confirmDelete()
              }}
              disabled={busy}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
