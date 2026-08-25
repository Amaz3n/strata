"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { unwrapAction } from "@/lib/action-result"
import {
  LINKABLE_ENTITY_LABELS,
  LINKABLE_ENTITY_TYPES,
  type LinkableEntityType,
} from "@/lib/correspondence"
import type { CorrespondenceMessage, LinkTarget } from "@/lib/services/correspondence"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  linkProjectEmailAction,
  listCorrespondenceLinkTargetsAction,
} from "@/app/(app)/projects/[id]/correspondence/actions"

/** Records the picker shows before asking the reader to narrow the search. */
const VISIBLE_TARGETS = 50

export function LinkDialog({
  projectId,
  emailId,
  onOpenChange,
  onLinked,
}: {
  projectId: string
  /** Null closes the dialog; a message id opens it for that message. */
  emailId: string | null
  onOpenChange: (open: boolean) => void
  onLinked: (message: CorrespondenceMessage) => void
}) {
  const [entityType, setEntityType] = useState<LinkableEntityType>("change_event")
  const [search, setSearch] = useState("")
  const [targets, setTargets] = useState<LinkTarget[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!emailId) return
    let active = true
    setTargets(null)
    setLoadError(null)
    void listCorrespondenceLinkTargetsAction({ projectId, entityType, search: search.trim() || undefined }).then(
      (result) => {
        if (!active) return
        if (result.success) setTargets(result.data)
        else setLoadError(result.error)
      },
    )
    return () => {
      active = false
    }
  }, [emailId, entityType, projectId, search])

  const link = (entityId: string) => {
    if (!emailId) return
    startTransition(async () => {
      try {
        const message = unwrapAction(
          await linkProjectEmailAction({ projectId, emailId, entityType, entityId }),
        )
        toast.success(`Linked to ${LINKABLE_ENTITY_LABELS[entityType].toLowerCase()}`)
        onLinked(message)
        onOpenChange(false)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not link this message")
      }
    })
  }

  const visible = targets?.slice(0, VISIBLE_TARGETS) ?? []

  return (
    <Dialog open={Boolean(emailId)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link this message</DialogTitle>
          <DialogDescription>
            Attach it to the record it is about. A message can be linked to more than one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Select value={entityType} onValueChange={(value) => setEntityType(value as LinkableEntityType)}>
            <SelectTrigger className="w-40" aria-label="Record type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINKABLE_ENTITY_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {LINKABLE_ENTITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={search}
            placeholder="Search…"
            aria-label="Search records"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="max-h-80 overflow-y-auto border">
          {loadError ? (
            <p className="p-4 text-sm text-destructive">{loadError}</p>
          ) : targets === null ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : visible.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No {LINKABLE_ENTITY_LABELS[entityType].toLowerCase()} on this project matches.
            </p>
          ) : (
            <ul className="divide-y">
              {visible.map((target) => (
                <li key={target.id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => link(target.id)}
                    className="flex w-full items-center justify-between gap-3 p-2 text-left hover:bg-muted/50 disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate text-sm">{target.label}</span>
                    {target.sublabel && (
                      <span className="shrink-0 text-xs text-muted-foreground">{target.sublabel}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {targets && targets.length > VISIBLE_TARGETS && (
          <p className="text-xs text-muted-foreground">
            Showing {VISIBLE_TARGETS} of {targets.length}. Search to narrow the list.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
