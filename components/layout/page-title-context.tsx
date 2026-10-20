"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import type { AppBreadcrumbItem } from "./app-header"
import type { BusinessProfile } from "@/lib/business-profile"
import { BUILDER_SURFACE, type WorkspaceSurface } from "@/lib/workspace-surface"
import type { ProductTier, ProjectPosture } from "@/lib/product-tier"
import type { ProjectNavigationItem } from "@/lib/types"

export interface ProjectShellContext {
  id: string
  name: string
  href: string
  posture: ProjectPosture
  contextLabel?: string
  contextHref?: string
  /** The project's navigation facts, from its own layout: the switcher's list is capped. */
  navigation: ProjectNavigationItem
}

interface PageTitleContextType {
  title: string | undefined
  breadcrumbs: AppBreadcrumbItem[] | undefined
  fullBleed: boolean
  projectContext: ProjectShellContext | null
  productTier: ProductTier
  /** What this workspace includes: plan features and business profile. */
  workspaceSurface: WorkspaceSurface
  businessProfile: BusinessProfile
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
  workspaceSurface?: WorkspaceSurface
}

type Scoped<T> = { path: string; value: T } | undefined

export function PageTitleProvider({
  children,
  title: initialTitle,
  breadcrumbs: initialBreadcrumbs,
  productTier = "residential",
  workspaceSurface = BUILDER_SURFACE,
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
      workspaceSurface,
      businessProfile: workspaceSurface.profile,
      setTitle,
      setBreadcrumbs,
      setFullBleed,
      setProjectContext,
    }),
    [title, breadcrumbs, fullBleed, projectContext, productTier, workspaceSurface, setTitle, setBreadcrumbs],
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

/** The project the shell is on: from the switcher's capped list, or from the project's own layout when it is outside it. */
export function useShellProject(projects: ProjectNavigationItem[], projectId: string | null | undefined) {
  const { projectContext } = usePageTitle()
  return useMemo(
    () => projects.find((project) => project.id === projectId)
      ?? (projectContext && projectContext.id === projectId ? projectContext.navigation : undefined),
    [projects, projectId, projectContext],
  )
}
