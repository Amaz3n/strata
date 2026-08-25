"use client"

import { useEffect, useState } from "react"

import { scheduleLoadingReveal } from "@/lib/navigation/loading-delay"

/**
 * Holds the visible mark and its polite announcement behind one shared delay.
 * Until it elapses this renders nothing at all — there is no status node for a
 * screen reader to read out on a navigation that has already finished.
 */
export function DelayedLoadingStatus({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => scheduleLoadingReveal(() => setRevealed(true)), [])

  if (!revealed) return null

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <div className="arc-loading-presence">{children}</div>
    </div>
  )
}
