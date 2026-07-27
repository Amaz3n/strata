"use client"

import { ChevronDown, ChevronUp, Plus, Trash2 } from "@/components/icons"
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
import type { FeatureFlagOrganization } from "@/lib/services/admin"
import type {
  AdminReleaseNote,
  ReleaseNoteArea,
  ReleaseNoteItem,
  ReleaseNoteItemType,
  ReleaseNoteVisibility,
} from "@/lib/services/release-notes"

import { AREA_LABELS, AREA_ORDER, ITEM_TYPE_META, ITEM_TYPE_ORDER } from "./release-meta"

export type EditorState = {
  id?: string
  slug: string
  slugTouched: boolean
  title: string
  summary: string
  body: string
  version: string
  area: ReleaseNoteArea
  items: ReleaseNoteItem[]
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

export const emptyEditor: EditorState = {
  slug: "",
  slugTouched: false,
  title: "",
  summary: "",
  body: "",
  version: "",
  area: "general",
  items: [],
  visibility: "badge",
  href: "",
  ctaLabel: "",
  orgId: "__all",
  audienceRoles: "",
  audiencePermissions: "",
  audienceFeatures: "",
  isPublished: true,
  publishedAt: "",
  expiresAt: "",
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
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

/** `2026-07-23T14:05:00Z` → `2026-07-23T14:05`, the shape `datetime-local` expects. */
function toDateTimeLocal(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromDateTimeLocal(value: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function editorFromNote(note: AdminReleaseNote): EditorState {
  return {
    id: note.id,
    slug: note.slug,
    slugTouched: true,
    title: note.title,
    summary: note.summary,
    body: note.body ?? "",
    version: note.version ?? "",
    area: note.area,
    items: note.items,
    visibility: note.visibility,
    href: note.href ?? "",
    ctaLabel: note.ctaLabel ?? "",
    orgId: note.orgId ?? "__all",
    audienceRoles: toCsv(note.audienceRoles),
    audiencePermissions: toCsv(note.audiencePermissions),
    audienceFeatures: toCsv(note.audienceFeatures),
    isPublished: note.isPublished,
    publishedAt: toDateTimeLocal(note.publishedAt || null),
    expiresAt: toDateTimeLocal(note.expiresAt),
  }
}

export function inputFromEditor(form: EditorState) {
  return {
    slug: form.slug.trim(),
    title: form.title.trim(),
    summary: form.summary.trim(),
    body: form.body.trim() || null,
    version: form.version.trim() || null,
    area: form.area,
    items: form.items
      .filter((item) => item.title.trim())
      .map((item) => ({
        type: item.type,
        title: item.title.trim(),
        detail: item.detail?.trim() || null,
        href: item.href?.trim() || null,
      })),
    visibility: form.visibility,
    href: form.href.trim() || null,
    ctaLabel: form.ctaLabel.trim() || null,
    orgId: form.orgId === "__all" ? null : form.orgId,
    audienceRoles: fromCsv(form.audienceRoles),
    audiencePermissions: fromCsv(form.audiencePermissions),
    audienceFeatures: fromCsv(form.audienceFeatures),
    isPublished: form.isPublished,
    publishedAt: fromDateTimeLocal(form.publishedAt),
    expiresAt: fromDateTimeLocal(form.expiresAt),
  }
}

function ItemRow({
  item,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  item: ReleaseNoteItem
  index: number
  total: number
  onChange: (item: ReleaseNoteItem) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <li className="grid gap-2 border-b border-border p-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <Select
          value={item.type}
          onValueChange={(type: ReleaseNoteItemType) => onChange({ ...item, type })}
        >
          <SelectTrigger className="h-8 w-32" aria-label={`Feature ${index + 1} type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ITEM_TYPE_ORDER.map((type) => (
              <SelectItem key={type} value={type}>
                {ITEM_TYPE_META[type].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="h-8"
          placeholder="What shipped"
          aria-label={`Feature ${index + 1} title`}
          value={item.title}
          onChange={(event) => onChange({ ...item, title: event.target.value })}
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Move feature up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ChevronUp className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Move feature down"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Remove feature"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="flex gap-2">
        <Input
          className="h-8"
          placeholder="Optional one-line detail"
          aria-label={`Feature ${index + 1} detail`}
          value={item.detail ?? ""}
          onChange={(event) => onChange({ ...item, detail: event.target.value || null })}
        />
        <Input
          className="h-8 w-40 shrink-0"
          placeholder="Link (/billing)"
          aria-label={`Feature ${index + 1} link`}
          value={item.href ?? ""}
          onChange={(event) => onChange({ ...item, href: event.target.value || null })}
        />
      </div>
    </li>
  )
}

export function ReleaseEditor({
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
  function updateItems(items: ReleaseNoteItem[]) {
    onChange({ ...form, items })
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= form.items.length) return
    const items = [...form.items]
    const [moved] = items.splice(index, 1)
    items.splice(target, 0, moved)
    updateItems(items)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.id ? "Edit release" : "New release"}</DialogTitle>
          <DialogDescription>
            One release per ship date. Give it a headline, then list the features that
            went out with it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="grid gap-2">
              <Label htmlFor="release-title">Headline</Label>
              <Input
                id="release-title"
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
              <Label htmlFor="release-version">
                Version <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="release-version"
                placeholder="2.14"
                value={form.version}
                onChange={(event) => onChange({ ...form, version: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="release-summary">Summary</Label>
            <Textarea
              id="release-summary"
              rows={2}
              value={form.summary}
              onChange={(event) => onChange({ ...form, summary: event.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="release-body">
              Details <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="release-body"
              rows={3}
              placeholder="Longer explanation. Leave a blank line between paragraphs."
              value={form.body}
              onChange={(event) => onChange({ ...form, body: event.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Features in this release</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  updateItems([
                    ...form.items,
                    { type: "new", title: "", detail: null, href: null },
                  ])
                }
              >
                <Plus data-icon="inline-start" />
                Add feature
              </Button>
            </div>

            {form.items.length === 0 ? (
              <p className="border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                No features listed. The release will show just its headline and summary.
              </p>
            ) : (
              <ul className="border border-border">
                {form.items.map((item, index) => (
                  <ItemRow
                    key={index}
                    item={item}
                    index={index}
                    total={form.items.length}
                    onChange={(next) =>
                      updateItems(form.items.map((current, i) => (i === index ? next : current)))
                    }
                    onMove={(direction) => moveItem(index, direction)}
                    onRemove={() => updateItems(form.items.filter((_, i) => i !== index))}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Area</Label>
              <Select
                value={form.area}
                onValueChange={(area: ReleaseNoteArea) => onChange({ ...form, area })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AREA_ORDER.map((area) => (
                    <SelectItem key={area} value={area}>
                      {AREA_LABELS[area]}
                    </SelectItem>
                  ))}
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
              <Label htmlFor="release-href">
                Link <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="release-href"
                placeholder="/billing"
                value={form.href}
                onChange={(event) => onChange({ ...form, href: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="release-cta">Link label</Label>
              <Input
                id="release-cta"
                placeholder="Open Billing"
                value={form.ctaLabel}
                onChange={(event) => onChange({ ...form, ctaLabel: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="release-slug">Slug</Label>
              <Input
                id="release-slug"
                value={form.slug}
                onChange={(event) =>
                  onChange({ ...form, slug: event.target.value, slugTouched: true })
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Workspace</Label>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="release-published-at">
                Publish date <span className="text-muted-foreground">(blank = now)</span>
              </Label>
              <Input
                id="release-published-at"
                type="datetime-local"
                value={form.publishedAt}
                onChange={(event) => onChange({ ...form, publishedAt: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="release-expires-at">
                Expires <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="release-expires-at"
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => onChange({ ...form, expiresAt: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="release-roles">Roles</Label>
              <Input
                id="release-roles"
                placeholder="owner, admin"
                value={form.audienceRoles}
                onChange={(event) => onChange({ ...form, audienceRoles: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="release-permissions">Permissions</Label>
              <Input
                id="release-permissions"
                placeholder="invoices.manage"
                value={form.audiencePermissions}
                onChange={(event) =>
                  onChange({ ...form, audiencePermissions: event.target.value })
                }
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="release-features">Feature flags</Label>
              <Input
                id="release-features"
                placeholder="qbo_sync"
                value={form.audienceFeatures}
                onChange={(event) => onChange({ ...form, audienceFeatures: event.target.value })}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Comma-separated. Leave blank to show this release to everyone in the workspace.
          </p>

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
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save release"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
