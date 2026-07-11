"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import type { AppBreadcrumbItem } from "./app-header"
import type { ProductTier, ProjectPosture } from "@/lib/product-tier"

export interface ProjectShellContext {
  id: string
  name: string
  href: string
  posture: ProjectPosture
}

interface PageTitleContextType {
  title: string | undefined
  breadcrumbs: AppBreadcrumbItem[] | undefined
  fullBleed: boolean
  projectContext: ProjectShellContext | null
  productTier: ProductTier
  progressBillingEnabled: boolean
  setTitle: (title: string) => void
  setBreadcrumbs: (breadcrumbs: AppBreadcrumbItem[]) => void
  setFullBleed: (value: boolean) => void
  setProjectContext: (ctx: ProjectShellContext | null) => void
}

const PageTitleContext = createContext<PageTitleContextType | undefined>(undefined)

interface PageTitleProviderProps {
  children: React.ReactNode
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  productTier?: ProductTier
  progressBillingEnabled?: boolean
}

type Scoped<T> = { path: string; value: T } | undefined

export function PageTitleProvider({
  children,
  title: initialTitle,
  breadcrumbs: initialBreadcrumbs,
  productTier = "residential",
  progressBillingEnabled = false,
}: PageTitleProviderProps) {
  const pathname = usePathname()

  const [scopedTitle, setScopedTitle] = useState<Scoped<string>>(
    initialTitle ? { path: pathname, value: initialTitle } : undefined,
  )
  const [scopedBreadcrumbs, setScopedBreadcrumbs] = useState<Scoped<AppBreadcrumbItem[]>>(
    initialBreadcrumbs ? { path: pathname, value: initialBreadcrumbs } : undefined,
  )
  const [fullBleed, setFullBleed] = useState<boolean>(false)
  const [projectContext, setProjectContext] = useState<ProjectShellContext | null>(null)

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
    () => ({
      title,
      breadcrumbs,
      fullBleed,
      projectContext,
      productTier,
      progressBillingEnabled,
      setTitle,
      setBreadcrumbs,
      setFullBleed,
      setProjectContext,
    }),
    [title, breadcrumbs, fullBleed, projectContext, productTier, progressBillingEnabled, setTitle, setBreadcrumbs],
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
