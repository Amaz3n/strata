"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"

import { recordDemoPageViewAction } from "@/app/(app)/tracking/actions"

import { unwrapAction } from "@/lib/action-result"

const VIEW_THROTTLE_MS = 5 * 60 * 1000

export function DemoUsageTracker() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname) return

    const key = `arc:demo-page-view:${pathname}`
    const lastTracked = Number(window.sessionStorage.getItem(key) ?? 0)
    if (Number.isFinite(lastTracked) && Date.now() - lastTracked < VIEW_THROTTLE_MS) return

    window.sessionStorage.setItem(key, String(Date.now()))
    void recordDemoPageViewAction(pathname).then(unwrapAction).catch(() => {
      window.sessionStorage.removeItem(key)
    })
  }, [pathname])

  return null
}
