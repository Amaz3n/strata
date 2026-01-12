"use client"

import { useEffect } from "react"

export function ServiceWorkerRegister() {
  const enabled = process.env.NEXT_PUBLIC_FEATURE_DRAWINGS_OFFLINE === "true"

  useEffect(() => {
    if (!enabled) return
    if (typeof window === "undefined") return
    if (!("serviceWorker" in navigator)) return

    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("[sw] registration failed:", err))
  }, [enabled])

  return null
}

