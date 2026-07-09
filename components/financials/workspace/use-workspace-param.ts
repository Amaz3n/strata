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

  // Follow browser navigation (Back/Forward, external pushes).
  useEffect(() => {
    setSelectedId(urlId)
    if (!urlId) pushedRef.current = false
  }, [urlId])

  const open = useCallback(
    (id: string | null) => {
      setSelectedId((current) => {
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search)
          if (id) params.set(param, id)
          else params.delete(param)
          const query = params.toString()
          const url = query ? `${pathname}?${query}` : pathname

          if (id && !current) {
            window.history.pushState(null, "", url)
            pushedRef.current = true
          } else if (!id && current && pushedRef.current) {
            pushedRef.current = false
            window.history.back()
          } else {
            window.history.replaceState(null, "", url)
          }
        }
        return id
      })
    },
    [param, pathname],
  )

  return [selectedId, open]
}
