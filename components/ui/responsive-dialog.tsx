"use client"

import { useEffect, useState, type ReactNode } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/components/ui/use-mobile"
import { cn } from "@/lib/utils"

interface ResponsiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** Applied to the dialog surface only; the drawer is always full width. */
  className?: string
  children: ReactNode
}

/**
 * A dialog on pointer devices, a bottom drawer on touch. Short tasks launched
 * from a page the reader is already on belong over that page, and on a phone a
 * centered modal with a keyboard open is unusable.
 *
 * Children are rendered inside a flex column that already owns the header, so a
 * scrolling body plus a pinned footer works in both forms.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
}: ResponsiveDialogProps) {
  const isMobile = useIsMobile()
  // `useIsMobile` reports false until its effect runs, so rendering before then
  // would mount the dialog and immediately swap it for the drawer — a visible
  // flash on any surface that opens this on load.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="mx-auto flex max-h-[94vh] max-w-lg flex-col outline-none">
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : null}
          </DrawerHeader>
          {children}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("flex max-h-[90vh] max-w-xl flex-col gap-0 p-0", className)}>
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
