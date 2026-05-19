"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import type { AppBreadcrumbItem } from "./app-header"

interface PageTitleContextType {
  title: string | undefined
  breadcrumbs: AppBreadcrumbItem[] | undefined
  fullBleed: boolean
  setTitle: (title: string) => void
  setBreadcrumbs: (breadcrumbs: AppBreadcrumbItem[]) => void
  setFullBleed: (value: boolean) => void
}

const PageTitleContext = createContext<PageTitleContextType | undefined>(undefined)

interface PageTitleProviderProps {
  children: React.ReactNode
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
}

type Scoped<T> = { path: string; value: T } | undefined

export function PageTitleProvider({ children, title: initialTitle, breadcrumbs: initialBreadcrumbs }: PageTitleProviderProps) {
  const pathname = usePathname()

  const [scopedTitle, setScopedTitle] = useState<Scoped<string>>(
    initialTitle ? { path: pathname, value: initialTitle } : undefined,
  )
  const [scopedBreadcrumbs, setScopedBreadcrumbs] = useState<Scoped<AppBreadcrumbItem[]>>(
    initialBreadcrumbs ? { path: pathname, value: initialBreadcrumbs } : undefined,
  )
  const [fullBleed, setFullBleed] = useState<boolean>(false)

  useEffect(() => {
    if (initialTitle) setScopedTitle({ path: pathname, value: initialTitle })
  }, [initialTitle, pathname])

  useEffect(() => {
    if (initialBreadcrumbs) setScopedBreadcrumbs({ path: pathname, value: initialBreadcrumbs })
  }, [initialBreadcrumbs, pathname])

  const setTitle = useCallback(
    (value: string) => setScopedTitle({ path: pathname, value }),
    [pathname],
  )

  const setBreadcrumbs = useCallback(
    (value: AppBreadcrumbItem[]) => setScopedBreadcrumbs({ path: pathname, value }),
    [pathname],
  )

  const title = scopedTitle?.path === pathname ? scopedTitle.value : undefined
  const breadcrumbs = scopedBreadcrumbs?.path === pathname ? scopedBreadcrumbs.value : undefined

  const value = useMemo(
    () => ({ title, breadcrumbs, fullBleed, setTitle, setBreadcrumbs, setFullBleed }),
    [title, breadcrumbs, fullBleed, setTitle, setBreadcrumbs],
  )

  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>
}

export function usePageTitle() {
  const context = useContext(PageTitleContext)
  if (context === undefined) {
    throw new Error("usePageTitle must be used within a PageTitleProvider")
  }
  return context
}
