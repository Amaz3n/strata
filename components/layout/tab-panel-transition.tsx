"use client"

import { usePathname } from "next/navigation"

/**
 * Wraps the region a set of route-backed tabs render into, so switching tabs
 * reads as one surface changing its contents.
 *
 * Keyed on the *real* pathname, not the optimistic one: the optimistic path
 * updates on click, which would replay the entrance over the outgoing tab. The
 * real path changes when the new tab commits, which is the frame the animation
 * belongs to.
 *
 * This only does anything because the surrounding layout survives the
 * navigation. Nothing above this point re-mounts — header, tab strip and scroll
 * position are all continuous — so the animation has a stable frame to happen
 * inside of instead of being one more thing that flashes on a full re-render.
 */
export function TabPanelTransition({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const pathname = usePathname()
  return (
    <div key={pathname} className={className}>
      {children}
    </div>
  )
}
