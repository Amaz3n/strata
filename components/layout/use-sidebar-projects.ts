"use client"

import { useEffect, useState } from "react"

import type { Project } from "@/lib/types"

type SidebarProjectsSnapshot = {
  projects: Project[]
  isLoading: boolean
  loadError: string | null
}

let snapshot: SidebarProjectsSnapshot = {
  projects: [],
  isLoading: true,
  loadError: null,
}
let loaded = false
let browserListeners = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

async function loadProjects() {
  if (snapshot.isLoading && loaded) return
  if (snapshot.isLoading && !loaded && listeners.size > 1) return

  snapshot = { ...snapshot, isLoading: true }
  emit()

  try {
    const response = await fetch("/api/projects", { cache: "no-store" })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Project fetch failed (${response.status}): ${text}`)
    }
    const payload = await response.json()
    snapshot = {
      projects: payload?.projects ?? [],
      isLoading: false,
      loadError: null,
    }
    loaded = true
  } catch (error) {
    console.error("Failed to load projects", error)
    snapshot = {
      projects: [],
      isLoading: false,
      loadError: error instanceof Error ? error.message : "Unknown error",
    }
    loaded = true
  }
  emit()
}

export function useSidebarProjects() {
  const [state, setState] = useState(snapshot)

  useEffect(() => {
    const listener = () => setState(snapshot)
    listeners.add(listener)
    listener()
    if (!loaded) void loadProjects()

    if (typeof window !== "undefined" && browserListeners === 0) {
      window.addEventListener("arc-org-change", loadProjects)
    }
    browserListeners += 1

    return () => {
      listeners.delete(listener)
      browserListeners = Math.max(0, browserListeners - 1)
      if (typeof window !== "undefined") {
        if (browserListeners === 0) {
          window.removeEventListener("arc-org-change", loadProjects)
        }
      }
    }
  }, [])

  return state
}
