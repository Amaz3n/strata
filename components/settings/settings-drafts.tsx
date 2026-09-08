"use client"

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"

export interface InvoiceSettingsDraft {
  billingEmail: string
  address: string
  defaultPaymentTermsDays: number
  defaultInvoiceNote: string
}

type DraftStore = {
  get: (orgId: string) => InvoiceSettingsDraft | undefined
  set: (orgId: string, draft: InvoiceSettingsDraft) => void
  clear: (orgId: string) => void
}
const Context = createContext<DraftStore | null>(null)

/** Session-local drafts survive section changes and SPA back/forward; never persisted to disk. */
export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, InvoiceSettingsDraft>())
  const store = useMemo<DraftStore>(
    () => ({
      get: (orgId) => drafts.current.get(orgId),
      set: (orgId, draft) => {
        drafts.current.set(orgId, draft)
      },
      clear: (orgId) => {
        drafts.current.delete(orgId)
      },
    }),
    [],
  )
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!drafts.current.size) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [])
  return <Context.Provider value={store}>{children}</Context.Provider>
}

export function useSettingsDrafts() {
  const store = useContext(Context)
  if (!store) throw new Error("Settings drafts require SettingsDraftProvider")
  return store
}
