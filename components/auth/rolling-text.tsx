"use client"

import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/** How long the outgoing letters stay mounted once a change starts. */
const SETTLE_MS = 700
const CHAR_IN_DELAY_MS = 90
const CHAR_IN_STEP_MS = 14
const CHAR_OUT_STEP_MS = 10

/**
 * Text that changes by rolling: when `text` changes, the old letters lift away
 * while the new ones rise in, one after another. Screen readers get the plain
 * text; the animated letters are hidden from them.
 */
export function RollingText({ text, className }: { text: string; className?: string }) {
  const [roll, setRoll] = useState<{ current: string; previous: string | null; id: number }>({
    current: text,
    previous: null,
    id: 0,
  })

  // Remember the outgoing text while rendering, so the change paints on the same frame.
  if (text !== roll.current) {
    setRoll({ current: text, previous: roll.current, id: roll.id + 1 })
  }

  useEffect(() => {
    if (roll.previous === null) return
    const timer = window.setTimeout(
      () => setRoll((latest) => (latest.id === roll.id ? { ...latest, previous: null } : latest)),
      SETTLE_MS + roll.current.length * CHAR_IN_STEP_MS,
    )
    return () => window.clearTimeout(timer)
  }, [roll])

  if (roll.previous === null) {
    return <span className={cn("auth-roll", className)}>{roll.current}</span>
  }

  return (
    <span className={cn("auth-roll", className)}>
      <span className="sr-only">{roll.current}</span>
      <Letters key={`in-${roll.id}`} text={roll.current} direction="in" />
      <Letters key={`out-${roll.id}`} text={roll.previous} direction="out" />
    </span>
  )
}

function Letters({ text, direction }: { text: string; direction: "in" | "out" }) {
  let index = 0
  return (
    <span className={direction === "in" ? "auth-roll-in" : "auth-roll-out"} aria-hidden>
      {text.split(/(\s+)/).map((part, partIndex) => {
        if (!part) return null
        if (/^\s+$/.test(part)) return " "
        return (
          <span key={partIndex} className="auth-roll-word">
            {Array.from(part).map((char, charIndex) => {
              const k = index++
              const delay = direction === "in" ? CHAR_IN_DELAY_MS + k * CHAR_IN_STEP_MS : k * CHAR_OUT_STEP_MS
              return (
                <span key={charIndex} className="auth-roll-char" style={{ animationDelay: `${delay}ms` }}>
                  {char}
                </span>
              )
            })}
          </span>
        )
      })}
    </span>
  )
}
