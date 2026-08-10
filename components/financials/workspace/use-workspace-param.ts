"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"

/**
 * URL-addressable workspace selection (?bill=…, ?expense=…).
 *
 * Opening the workspace pushes a history entry so the browser Back button closes
 * the takeover instead of leaving the page; switching records while open replaces
 * in place; closing from the UI pops the entry we pushed. Deep links (arriving
 * with the param already set) never push, so Back still leaves as expected.
 */
export function useWorkspaceParam(param: string): [string | null, (id: string | null) => void] {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlId = searchParams.get(param)
  const [selectedId, setSelectedId] = useState<string | null>(urlId)
  const pushedRef = useRef(false)

  // Follow browser navigation (Back/Forward, external pushes). Button actions
  // update selectedId immediately; the effect only synchronizes genuine URL
  // changes and never owns a history side effect.
  useEffect(() => {
    setSelectedId(urlId)
    if (!urlId) pushedRef.current = false
  }, [urlId])

  const open = useCallback(
    (id: string | null) => {
      if (typeof window === "undefined") return

      const params = new URLSearchParams(window.location.search)
      const currentId = params.get(param)
      if (id === currentId && id === selectedId) return

      // Render the workspace transition immediately. Keeping this outside a
      // functional state updater is important: React may replay updaters, but a
      // browser history mutation must happen exactly once.
      setSelectedId(id)

      if (id) params.set(param, id)
      else params.delete(param)
      const query = params.toString()
      const url = query ? `${pathname}?${query}` : pathname

      if (id && !currentId) {
        window.history.pushState(window.history.state, "", url)
        pushedRef.current = true
      } else if (!id && currentId && pushedRef.current) {
        pushedRef.current = false
        window.history.back()
      } else {
        window.history.replaceState(window.history.state, "", url)
      }
    },
    [param, pathname, selectedId],
  )

  return [selectedId, open]
}
