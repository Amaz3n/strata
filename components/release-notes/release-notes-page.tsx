"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { format } from "date-fns"

import { markReleaseNotesSeenAction } from "@/app/actions/release-notes"
import {
  createReleaseNoteAction,
  deleteReleaseNoteAction,
  updateReleaseNoteAction,
} from "@/app/(app)/admin/release-notes/actions"
import {
  ArrowRight,
  PenLine,
  Phone,
  Plus,
  Shield,
  Sparkles,
  Trash2,
  TrendingUp,
  Wrench,
} from "@/components/icons"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import type { FeatureFlagOrganization } from "@/lib/services/admin"
import type {
  AdminReleaseNote,
  ReleaseNote,
  ReleaseNoteCategory,
  ReleaseNoteVisibility,
} from "@/lib/services/release-notes"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

const CATEGORY_META: Record<
  ReleaseNoteCategory,
  { label: string; icon: typeof Sparkles; className: string }
> = {
  new: {
    label: "New",
    icon: Sparkles,
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  improved: {
    label: "Improved",
    icon: TrendingUp,
    className: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  fixed: {
    label: "Fixed",
    icon: Wrench,
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  admin: {
    label: "Admin",
    icon: Shield,
    className: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  mobile: {
    label: "Mobile",
    icon: Phone,
    className: "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
}

function CategoryBadge({ category }: { category: ReleaseNoteCategory }) {
  const meta = CATEGORY_META[category]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 border px-2 py-0.5 text-[11px] font-medium",
        meta.className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

function formatDayHeading(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Recently"
  return format(date, "MMMM d, yyyy")
}

function dayKey(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown"
  return format(date, "yyyy-MM-dd")
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
}

// ── Editor ──────────────────────────────────────────────────────────────────

type EditorState = {
  id?: string
  slug: string
  slugTouched: boolean
  title: string
  summary: string
  body: string
  category: ReleaseNoteCategory
  visibility: ReleaseNoteVisibility
  href: string
  ctaLabel: string
  orgId: string
  isPublished: boolean
  // preserved as-is (edited on the full admin page, not here)
  audienceRoles: string[]
  audiencePermissions: string[]
  audienceFeatures: string[]
  publishedAt: string | null
  expiresAt: string | null
}

const emptyEditor: EditorState = {
  slug: "",
  slugTouched: false,
  title: "",
  summary: "",
  body: "",
  category: "new",
  visibility: "quiet",
  href: "",
  ctaLabel: "",
  orgId: "__all",
  isPublished: true,
  audienceRoles: [],
  audiencePermissions: [],
  audienceFeatures: [],
  publishedAt: null,
  expiresAt: null,
}

function editorFromNote(note: AdminReleaseNote): EditorState {
  return {
    id: note.id,
    slug: note.slug,
    slugTouched: true,
    title: note.title,
    summary: note.summary,
    body: note.body ?? "",
    category: note.category,
    visibility: note.visibility,
    href: note.href ?? "",
    ctaLabel: note.ctaLabel ?? "",
    orgId: note.orgId ?? "__all",
    isPublished: note.isPublished,
    audienceRoles: note.audienceRoles,
    audiencePermissions: note.audiencePermissions,
    audienceFeatures: note.audienceFeatures,
    publishedAt: note.publishedAt || null,
    expiresAt: note.expiresAt,
  }
}

function inputFromEditor(form: EditorState) {
  return {
    slug: form.slug.trim(),
    title: form.title.trim(),
    summary: form.summary.trim(),
    body: form.body.trim() || null,
    category: form.category,
    visibility: form.visibility,
    href: form.href.trim() || null,
    ctaLabel: form.ctaLabel.trim() || null,
    orgId: form.orgId === "__all" ? null : form.orgId,
    audienceRoles: form.audienceRoles,
    audiencePermissions: form.audiencePermissions,
    audienceFeatures: form.audienceFeatures,
    isPublished: form.isPublished,
    publishedAt: form.publishedAt,
    expiresAt: form.expiresAt,
  }
}

function EntryEditor({
  form,
  organizations,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  form: EditorState
  organizations: FeatureFlagOrganization[]
  busy: boolean
  onChange: (form: EditorState) => void
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit entry" : "New entry"}</DialogTitle>
          <DialogDescription>
            {form.id
              ? "Update how this entry reads on What's New."
              : "Publish an update to every workspace's What's New feed."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="entry-title">Title</Label>
            <Input
              id="entry-title"
              value={form.title}
              onChange={(event) => {
                const title = event.target.value
                onChange({
                  ...form,
                  title,
                  slug: form.slugTouched ? form.slug : slugify(title),
                })
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="entry-summary">Summary</Label>
            <Textarea
              id="entry-summary"
              rows={3}
              value={form.summary}
              onChange={(event) => onChange({ ...form, summary: event.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="entry-body">
              Details <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="entry-body"
              rows={4}
              placeholder="Longer explanation. Leave a blank line between paragraphs."
              value={form.body}
              onChange={(event) => onChange({ ...form, body: event.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(category: ReleaseNoteCategory) => onChange({ ...form, category })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="improved">Improved</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="mobile">Mobile</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Visibility</Label>
              <Select
                value={form.visibility}
                onValueChange={(visibility: ReleaseNoteVisibility) =>
                  onChange({ ...form, visibility })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quiet">Quiet — feed only</SelectItem>
                  <SelectItem value="badge">Badge — counts as unread</SelectItem>
                  <SelectItem value="announce">Announce — opens once in-app</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="entry-href">
                Link <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="entry-href"
                placeholder="/billing"
                value={form.href}
                onChange={(event) => onChange({ ...form, href: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="entry-cta">Link label</Label>
              <Input
                id="entry-cta"
                placeholder="Open Billing"
                value={form.ctaLabel}
                onChange={(event) => onChange({ ...form, ctaLabel: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="entry-slug">Slug</Label>
              <Input
                id="entry-slug"
                value={form.slug}
                onChange={(event) =>
                  onChange({ ...form, slug: event.target.value, slugTouched: true })
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Audience</Label>
              <Select value={form.orgId} onValueChange={(orgId) => onChange({ ...form, orgId })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All organizations</SelectItem>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <label className="flex items-center justify-between gap-4 border border-border p-3">
            <span className="space-y-1">
              <span className="block text-sm font-medium">Published</span>
              <span className="block text-xs text-muted-foreground">
                Off keeps this as a draft only you can see here.
              </span>
            </span>
            <Switch
              checked={form.isPublished}
              onCheckedChange={(isPublished) => onChange({ ...form, isPublished })}
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Reader ───────────────────────────────────────────────────────────────────

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
  const [notes, setNotes] = useState(props.notes)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AdminReleaseNote | null>(null)
  const [busy, startTransition] = useTransition()
  const [, startSeenTransition] = useTransition()
  const { toast } = useToast()

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

  const groups = useMemo(() => {
    const ordered: { key: string; label: string; notes: (ReleaseNote | AdminReleaseNote)[] }[] = []
    const index = new Map<string, number>()

    for (const note of notes) {
      const isDraft = canManage && !(note as AdminReleaseNote).isPublished
      const key = isDraft ? "__drafts" : dayKey(note.publishedAt)
      const label = isDraft ? "Drafts" : formatDayHeading(note.publishedAt)

      if (!index.has(key)) {
        index.set(key, ordered.length)
        ordered.push({ key, label, notes: [] })
      }
      ordered[index.get(key)!].notes.push(note)
    }

    // Drafts always sink to the bottom.
    ordered.sort((a, b) => {
      if (a.key === "__drafts") return 1
      if (b.key === "__drafts") return -1
      return 0
    })

    return ordered
  }, [notes, canManage])

  function saveEditor() {
    if (!editor) return
    const input = inputFromEditor(editor)

    startTransition(async () => {
      try {
        if (editor.id) {
          const updated = unwrapAction(await updateReleaseNoteAction(editor.id, input))
          setNotes((current) =>
            (current as AdminReleaseNote[]).map((note) =>
              note.id === updated.id ? updated : note,
            ),
          )
          toast({ title: "Entry updated" })
        } else {
          const created = unwrapAction(await createReleaseNoteAction(input))
          setNotes((current) => [created, ...(current as AdminReleaseNote[])])
          toast({ title: "Entry published" })
        }
        setEditor(null)
      } catch (error) {
        toast({
          title: "Couldn't save entry",
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
        toast({ title: "Entry deleted" })
      } catch (error) {
        toast({
          title: "Couldn't delete entry",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      } finally {
        setPendingDelete(null)
      }
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="flex items-end justify-between gap-4 pb-2">
        <p className="text-sm text-muted-foreground">
          Improvements and new workflows shipped into your Arc workspace.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditor({ ...emptyEditor })}>
            <Plus data-icon="inline-start" />
            New entry
          </Button>
        )}
      </header>

      {notes.length === 0 ? (
        <div className="mt-8 border border-border bg-card p-10 text-center">
          <h2 className="text-base font-medium">Nothing here yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            New Arc updates will show up here as they ship.
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col">
          {groups.map((group) => (
            <section
              key={group.key}
              className="grid gap-x-10 gap-y-5 border-t border-border py-8 first:border-t-0 first:pt-2 md:grid-cols-[9rem_minmax(0,1fr)]"
            >
              <div className="md:sticky md:top-24 md:self-start">
                <time className="text-sm font-medium text-foreground">{group.label}</time>
              </div>

              <div className="flex flex-col gap-8">
                {group.notes.map((note) => (
                  <article key={note.id} className="group flex flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <CategoryBadge category={note.category} />
                      {canManage && (
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            aria-label="Edit entry"
                            onClick={() => setEditor(editorFromNote(note as AdminReleaseNote))}
                          >
                            <PenLine className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            aria-label="Delete entry"
                            onClick={() => setPendingDelete(note as AdminReleaseNote)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      )}
                    </div>

                    <h2 className="text-base font-medium leading-snug text-foreground">
                      {note.title}
                    </h2>
                    <p className="text-sm leading-relaxed text-muted-foreground">{note.summary}</p>

                    {note.body && (
                      <div className="mt-1 flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
                        {note.body.split(/\n{2,}/).map((paragraph, i) => (
                          <p key={i}>{paragraph}</p>
                        ))}
                      </div>
                    )}

                    {note.href && (
                      <Link
                        href={note.href}
                        className="mt-1 inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
                      >
                        {note.ctaLabel ?? "Open"}
                        <ArrowRight className="size-3.5" />
                      </Link>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {canManage && editor && (
        <EntryEditor
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
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{pendingDelete?.title}&rdquo; will be removed from What&apos;s New for everyone.
              This can&apos;t be undone.
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
