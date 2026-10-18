"use client"

import { useEffect, useState } from "react"

// Null keeps server rendering independent of the browser-only token fragment.
export function useAuthHash() {
  const [hash, setHash] = useState<string | null>(null)
  useEffect(() => {
    const updateHash = () => setHash(window.location.hash)
    updateHash()
    window.addEventListener("hashchange", updateHash)
    window.addEventListener("popstate", updateHash)
    return () => {
      window.removeEventListener("hashchange", updateHash)
      window.removeEventListener("popstate", updateHash)
    }
  }, [])
  return hash
}
