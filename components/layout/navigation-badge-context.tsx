"use client"

import React, { createContext, useContext, useEffect, useState } from "react"

/**
 * Sidebar badge counts, delivered out-of-band.
 *
 * These numbers are decoration on the shell: the nav tree is identical with or
 * without them, so making the layout await them just delays first paint on every
 * navigation. The layout starts the query and hands the unresolved promise down
 * here; the chrome renders immediately at zero and the counts land when they land.
 */
export interface NavigationBadgeValues {
  pipelineBadgeCount: number
  myWorkBadgeCount: number
  readyToBillBadgeCount: number
  projectReviewBadgeCounts: Record<string, number>
  whatsNewUnreadCount: number
}

export const EMPTY_NAVIGATION_BADGES: NavigationBadgeValues = {
  pipelineBadgeCount: 0,
  myWorkBadgeCount: 0,
  readyToBillBadgeCount: 0,
  projectReviewBadgeCounts: {},
  whatsNewUnreadCount: 0,
}

const NavigationBadgeContext = createContext<NavigationBadgeValues>(EMPTY_NAVIGATION_BADGES)

export function NavigationBadgeProvider({
  valuesPromise,
  children,
}: {
  valuesPromise: Promise<NavigationBadgeValues>
  children: React.ReactNode
}) {
  // Seeded empty and never reset: a navigation produces a fresh promise, and
  // holding the previous counts until it resolves keeps badges from flickering
  // to zero mid-navigation.
  const [values, setValues] = useState<NavigationBadgeValues>(EMPTY_NAVIGATION_BADGES)

  useEffect(() => {
    let active = true
    valuesPromise.then((next) => {
      if (active) setValues(next)
    })
    return () => {
      active = false
    }
  }, [valuesPromise])

  return (
    <NavigationBadgeContext.Provider value={values}>{children}</NavigationBadgeContext.Provider>
  )
}

export function useNavigationBadges() {
  return useContext(NavigationBadgeContext)
}
