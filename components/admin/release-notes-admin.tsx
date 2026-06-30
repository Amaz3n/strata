"use client"

import { useMemo, useState, useTransition } from "react"
import { PenLine, Plus, Sparkles } from "@/components/icons"

import {
  createReleaseNoteAction,
  updateReleaseNoteAction,
} from "@/app/(app)/admin/release-notes/actions"
import { Badge } from "@/components/ui/badge"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import type {
  AdminReleaseNote,
  ReleaseNoteCategory,
  ReleaseNoteVisibility,
} from "@/lib/services/release-notes"
import type { FeatureFlagOrganization } from "@/lib/services/admin"

type FormState = {
  id?: string
  slug: string
  title: string
  summary: string
  body: string
  category: ReleaseNoteCategory
  visibility: ReleaseNoteVisibility
  href: string
  ctaLabel: string
  orgId: string
  audienceRoles: string
  audiencePermissions: string
  audienceFeatures: string
  isPublished: boolean
  publishedAt: string
  expiresAt: string
}

const emptyForm: FormState = {
  slug: "",
  title: "",
  summary: "",
  body: "",
  category: "improved",
  visibility: "badge",
  href: "",
  ctaLabel: "",
  orgId: "__all",
  audienceRoles: "",
  audiencePermissions: "",
  audienceFeatures: "",
  isPublished: false,
  publishedAt: "",
  expiresAt: "",
}

function toCsv(values: string[]) {
  return values.join(", ")
}

function fromCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function fromDateTimeLocal(value: string) {
  return value ? new Date(value).toISOString() : null
}

function formatDate(value: string | null) {
  if (!value) return "Draft"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Draft"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function formFromNote(note: AdminReleaseNote): FormState {
  return {
    id: note.id,
    slug: note.slug,
    title: note.title,
    summary: note.summary,
    body: note.body ?? "",
    category: note.category,
    visibility: note.visibility,
    href: note.href ?? "",
    ctaLabel: note.ctaLabel ?? "",
    orgId: note.orgId ?? "__all",
    audienceRoles: toCsv(note.audienceRoles),
    audiencePermissions: toCsv(note.audiencePermissions),
    audienceFeatures: toCsv(note.audienceFeatures),
    isPublished: note.isPublished,
    publishedAt: toDateTimeLocal(note.publishedAt),
    expiresAt: toDateTimeLocal(note.expiresAt),
  }
}

function inputFromForm(form: FormState) {
  return {
    slug: form.slug,
    title: form.title,
    summary: form.summary,
    body: form.body || null,
    category: form.category,
    visibility: form.visibility,
    href: form.href || null,
    ctaLabel: form.ctaLabel || null,
    orgId: form.orgId === "__all" ? null : form.orgId,
    audienceRoles: fromCsv(form.audienceRoles),
    audiencePermissions: fromCsv(form.audiencePermissions),
    audienceFeatures: fromCsv(form.audienceFeatures),
    isPublished: form.isPublished,
    publishedAt: fromDateTimeLocal(form.publishedAt),
    expiresAt: fromDateTimeLocal(form.expiresAt),
  }
}

export function ReleaseNotesAdmin({
  initialNotes,
  organizations,
}: {
  initialNotes: AdminReleaseNote[]
  organizations: FeatureFlagOrganization[]
}) {
  const [notes, setNotes] = useState(initialNotes)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, startTransition] = useTransition()
  const { toast } = useToast()

  const orgNames = useMemo(
    () => new Map(organizations.map((org) => [org.id, org.name])),
    [organizations],
  )

  function save() {
    if (!form) return
    const input = inputFromForm(form)

    startTransition(async () => {
      try {
        if (form.id) {
          const updated = await updateReleaseNoteAction(form.id, input)
          setNotes((current) => current.map((note) => (note.id === updated.id ? updated : note)))
          toast({ title: "Release note updated" })
        } else {
          const created = await createReleaseNoteAction(input)
          setNotes((current) => [created, ...current])
          toast({ title: "Release note created" })
        }
        setForm(null)
      } catch (error) {
        toast({
          title: "Unable to save release note",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        })
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Published Updates</h2>
          <p className="text-sm text-muted-foreground">
            Create targeted entries for badges, quiet changelog items, or one-time announcements.
          </p>
        </div>
        <Button onClick={() => setForm({ ...emptyForm })}>
          <Plus data-icon="inline-start" />
          New update
        </Button>
      </div>

      <div className="overflow-hidden border border-border bg-card">
        {notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No release notes have been created yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {notes.map((note) => (
              <div key={note.id} className="grid gap-4 p-4 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={note.isPublished ? "default" : "outline"}>
                      {note.isPublished ? "Published" : "Draft"}
                    </Badge>
                    <Badge variant="secondary">{note.visibility}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(note.publishedAt)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {note.orgId ? orgNames.get(note.orgId) ?? "Targeted org" : "All orgs"}
                    </span>
                  </div>
                  <div>
                    <div className="truncate font-medium">{note.title}</div>
                    <div className="truncate text-sm text-muted-foreground">{note.summary}</div>
                  </div>
                </div>
                <Button variant="outline" onClick={() => setForm(formFromNote(note))}>
                  <PenLine data-icon="inline-start" />
                  Edit
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={Boolean(form)} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <div className="flex h-10 w-10 items-center justify-center border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="size-5" />
            </div>
            <DialogTitle>{form?.id ? "Edit Release Note" : "New Release Note"}</DialogTitle>
            <DialogDescription>
              Announce meaningful updates without interrupting normal project work.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="release-title">Title</Label>
                <Input
                  id="release-title"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="release-slug">Slug</Label>
                <Input
                  id="release-slug"
                  value={form.slug}
                  placeholder="2026-06-29-daily-logs-refresh"
                  onChange={(event) => setForm({ ...form, slug: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="release-summary">Summary</Label>
                <Textarea
                  id="release-summary"
                  value={form.summary}
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="release-body">Body</Label>
                <Textarea
                  id="release-body"
                  value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={(category: ReleaseNoteCategory) => setForm({ ...form, category })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
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
                    onValueChange={(visibility: ReleaseNoteVisibility) => setForm({ ...form, visibility })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quiet">Quiet</SelectItem>
                      <SelectItem value="badge">Badge</SelectItem>
                      <SelectItem value="announce">Announce</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="release-href">CTA URL</Label>
                  <Input
                    id="release-href"
                    value={form.href}
                    placeholder="/whats-new"
                    onChange={(event) => setForm({ ...form, href: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="release-cta">CTA label</Label>
                  <Input
                    id="release-cta"
                    value={form.ctaLabel}
                    placeholder="Open workspace"
                    onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Organization</Label>
                  <Select value={form.orgId} onValueChange={(orgId) => setForm({ ...form, orgId })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">All organizations</SelectItem>
                      {organizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="release-permissions">Permissions</Label>
                  <Input
                    id="release-permissions"
                    value={form.audiencePermissions}
                    placeholder="invoice.read, daily_log.read"
                    onChange={(event) => setForm({ ...form, audiencePermissions: event.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="release-roles">Roles</Label>
                  <Input
                    id="release-roles"
                    value={form.audienceRoles}
                    placeholder="owner, admin"
                    onChange={(event) => setForm({ ...form, audienceRoles: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="release-features">Feature keys</Label>
                  <Input
                    id="release-features"
                    value={form.audienceFeatures}
                    placeholder="billing_autopilot"
                    onChange={(event) => setForm({ ...form, audienceFeatures: event.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="release-published-at">Published at</Label>
                  <Input
                    id="release-published-at"
                    type="datetime-local"
                    value={form.publishedAt}
                    onChange={(event) => setForm({ ...form, publishedAt: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="release-expires-at">Expires at</Label>
                  <Input
                    id="release-expires-at"
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                  />
                </div>
              </div>

              <label className="flex items-center justify-between gap-4 border border-border p-3">
                <span className="space-y-1">
                  <span className="block text-sm font-medium">Published</span>
                  <span className="block text-xs text-muted-foreground">
                    Published entries become visible when their date arrives.
                  </span>
                </span>
                <Switch
                  checked={form.isPublished}
                  onCheckedChange={(isPublished) => setForm({ ...form, isPublished })}
                />
              </label>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button onClick={save} disabled={busy}>{busy ? "Saving..." : "Save update"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
