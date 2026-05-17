"use client"

import React, { createContext, useContext, useEffect } from "react"
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

export function PageTitleProvider({ children, title: initialTitle, breadcrumbs: initialBreadcrumbs }: PageTitleProviderProps) {
  const [title, setTitle] = React.useState<string | undefined>(initialTitle)
  const [breadcrumbs, setBreadcrumbs] = React.useState<AppBreadcrumbItem[] | undefined>(initialBreadcrumbs)
  const [fullBleed, setFullBleed] = React.useState<boolean>(false)

  useEffect(() => {
    if (initialTitle) {
      setTitle(initialTitle)
    }
  }, [initialTitle])

  useEffect(() => {
    if (initialBreadcrumbs) {
      setBreadcrumbs(initialBreadcrumbs)
    }
  }, [initialBreadcrumbs])

  return (
    <PageTitleContext.Provider value={{ title, breadcrumbs, fullBleed, setTitle, setBreadcrumbs, setFullBleed }}>
      {children}
    </PageTitleContext.Provider>
  )
}

export function usePageTitle() {
  const context = useContext(PageTitleContext)
  if (context === undefined) {
    throw new Error("usePageTitle must be used within a PageTitleProvider")
  }
  return context
}


