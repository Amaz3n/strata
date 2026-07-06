"use client"

import { cn } from "@/lib/utils"
import type { DayCompleteness } from "./day-aggregate"

/**
 * Four arc segments — weather, manpower, narrative, photos — always drawn in
 * the same clock positions so a glance tells you *what* is missing, not just
 * how much. Fully complete renders as one unbroken emerald ring.
 */
export function CompletenessRing({
  completeness,
  size = 16,
  strokeWidth = 2,
  className,
}: {
  completeness: DayCompleteness
  size?: number
  strokeWidth?: number
  className?: string
}) {
  const { segments, done, total } = completeness
  const complete = done === total
  const r = (size - strokeWidth) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r

  if (complete) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={cn("text-emerald-500", className)}
        aria-label="Complete report"
      >
        <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
      </svg>
    )
  }

  // Each segment gets an equal share of the circle minus a fixed gap.
  const gap = circumference * 0.06
  const segLength = circumference / total - gap

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-label={`${done} of ${total} recorded`}
    >
      {segments.map((seg, i) => (
        <circle
          key={seg.key}
          cx={c}
          cy={c}
          r={r}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${segLength} ${circumference - segLength}`}
          strokeDashoffset={-(i * (segLength + gap)) + circumference / 4}
          className={seg.done ? "stroke-primary" : "stroke-border"}
        />
      ))}
    </svg>
  )
}
