"use client"

import React from "react"
import { usePageTitle } from "./page-title-context"
import type { AppBreadcrumbItem } from "./app-header"

interface PageLayoutProps {
  children: React.ReactNode
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
}

function PageLayoutInner({ children, title, breadcrumbs }: PageLayoutProps) {
  const { setTitle, setBreadcrumbs } = usePageTitle()

  React.useEffect(() => {
    if (title) {
      setTitle(title)
    }
  }, [title, setTitle])

  React.useEffect(() => {
    if (breadcrumbs) {
      setBreadcrumbs(breadcrumbs)
    }
  }, [breadcrumbs, setBreadcrumbs])

  return <>{children}</>
}

export function PageLayout(props: PageLayoutProps) {
  return <PageLayoutInner {...props} />
}


