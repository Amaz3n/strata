'use client'

import type * as React from 'react'
import { toast as sonner } from 'sonner'

/**
 * The `useToast()` call shape many surfaces were written against, rendered by the one
 * toaster the app mounts (Sonner, in app/layout.tsx). It used to feed a second toast store
 * whose viewport was never mounted, so every message sent through it was invisible.
 */
type Toast = {
  title?: React.ReactNode
  description?: React.ReactNode
  /** "destructive" renders as an error. */
  variant?: 'default' | 'destructive'
  /** One follow-up, e.g. Undo. */
  action?: { label: string; onClick: () => void }
}

function toast({ title, description, variant, action }: Toast) {
  const options = { description, action }
  const id = variant === 'destructive' ? sonner.error(title, options) : sonner(title, options)
  return { id, dismiss: () => sonner.dismiss(id) }
}

function useToast() {
  return { toast, dismiss: (toastId?: string | number) => sonner.dismiss(toastId) }
}

export { useToast, toast }
