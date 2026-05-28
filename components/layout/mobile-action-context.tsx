"use client"

import React, { createContext, useCallback, useContext, useMemo, useState } from "react"
import type { LucideIcon } from "@/components/icons"

export interface MobileAction {
  label: string
  icon?: LucideIcon
  onAction: () => void
}

interface MobileActionContextType {
  action: MobileAction | null
  setAction: (action: MobileAction | null) => void
}

const MobileActionContext = createContext<MobileActionContextType | undefined>(undefined)

/**
 * Lets a page register a single contextual primary action (e.g. "Add prospect")
 * that the mobile bottom nav renders as a square button beside the menu bar.
 * The registering page is responsible for clearing the action on unmount.
 */
export function MobileActionProvider({ children }: { children: React.ReactNode }) {
  const [action, setActionState] = useState<MobileAction | null>(null)
  const setAction = useCallback((next: MobileAction | null) => setActionState(next), [])
  const value = useMemo(() => ({ action, setAction }), [action, setAction])
  return <MobileActionContext.Provider value={value}>{children}</MobileActionContext.Provider>
}

export function useMobileAction() {
  const context = useContext(MobileActionContext)
  if (context === undefined) {
    throw new Error("useMobileAction must be used within a MobileActionProvider")
  }
  return context
}
