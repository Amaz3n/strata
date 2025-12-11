"use client"

import { toast as baseToast } from "sonner"

type ToastArgs = { title?: string; description?: string }

export function useToast() {
  return {
    toast({ title, description }: ToastArgs) {
      baseToast(title ?? description ?? "Notification", {
        description: description ?? undefined,
      })
    },
  }
}




