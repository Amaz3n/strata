"use client"

import type React from "react"
import { useEffect } from "react"

export type UiSize = "compact" | "default" | "comfortable"

export const UI_SIZE_STORAGE_KEY = "arc-ui-size"
export const UI_SIZE_CHANGE_EVENT = "arc-ui-size-change"
export const DEFAULT_UI_SIZE: UiSize = "default"

export const uiSizeOptions: Array<{
  value: UiSize
  label: string
  description: string
}> = [
  {
    value: "compact",
    label: "Compact",
    description: "More information on screen.",
  },
  {
    value: "default",
    label: "Default",
    description: "Balanced spacing and type.",
  },
  {
    value: "comfortable",
    label: "Comfortable",
    description: "Larger type and controls.",
  },
]

export function isUiSize(value: string | null): value is UiSize {
  return value === "compact" || value === "default" || value === "comfortable"
}

export function applyUiSize(size: UiSize) {
  document.documentElement.dataset.uiSize = size
}

export function getStoredUiSize(): UiSize {
  if (typeof window === "undefined") return DEFAULT_UI_SIZE
  try {
    const stored = window.localStorage.getItem(UI_SIZE_STORAGE_KEY)
    return isUiSize(stored) ? stored : DEFAULT_UI_SIZE
  } catch {
    return DEFAULT_UI_SIZE
  }
}

export function setStoredUiSize(size: UiSize) {
  try {
    window.localStorage.setItem(UI_SIZE_STORAGE_KEY, size)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  applyUiSize(size)
  window.dispatchEvent(new CustomEvent<UiSize>(UI_SIZE_CHANGE_EVENT, { detail: size }))
}

export function PersonalizationProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyUiSize(getStoredUiSize())

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== UI_SIZE_STORAGE_KEY) return
      applyUiSize(isUiSize(event.newValue) ? event.newValue : DEFAULT_UI_SIZE)
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [])

  return children
}
