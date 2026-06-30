"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"

import {
  dismissReleaseNoteAnnouncementAction,
  markReleaseNoteAnnouncedAction,
} from "@/app/actions/release-notes"
import { ArrowRight, Sparkles } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ReleaseNote } from "@/lib/services/release-notes"

const STORAGE_PREFIX = "arc.releaseNotes.announced."

export function ReleaseNotesAnnouncement({
  announcement,
}: {
  announcement: ReleaseNote | null
}) {
  const [open, setOpen] = useState(false)
  const [, startTransition] = useTransition()
  const storageKey = useMemo(
    () => (announcement ? `${STORAGE_PREFIX}${announcement.id}` : null),
    [announcement],
  )

  useEffect(() => {
    if (!announcement || !storageKey) return

    try {
      if (window.localStorage.getItem(storageKey)) return
      window.localStorage.setItem(storageKey, "shown")
    } catch {
      // Storage can be disabled; database state still prevents repeat prompts.
    }

    setOpen(true)
    startTransition(() => {
      markReleaseNoteAnnouncedAction(announcement.id).catch((error) => {
        console.error("Unable to mark release note announced", error)
      })
    })
  }, [announcement, storageKey])

  if (!announcement) return null
  const currentAnnouncement = announcement

  function close(dismiss = false) {
    setOpen(false)
    if (!dismiss) return

    startTransition(() => {
      dismissReleaseNoteAnnouncementAction(currentAnnouncement.id).catch((error) => {
        console.error("Unable to dismiss release note announcement", error)
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close(true))}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center border border-primary/20 bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <DialogTitle>{currentAnnouncement.title}</DialogTitle>
          <DialogDescription className="leading-6">
            {currentAnnouncement.summary}
          </DialogDescription>
        </DialogHeader>

        {currentAnnouncement.body && (
          <p className="text-sm leading-6 text-foreground/85">{currentAnnouncement.body}</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(true)}>
            Not now
          </Button>
          <Button asChild onClick={() => close()}>
            <Link href={currentAnnouncement.href ?? "/whats-new"}>
              {currentAnnouncement.ctaLabel ?? "See what's new"}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
