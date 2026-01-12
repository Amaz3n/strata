"use client"

import type React from "react"
import { PageTitleProvider } from "./page-title-context"

interface PageLayoutProps {
  children: React.ReactNode
  title?: string
}

export function PageLayout({ children, title }: PageLayoutProps) {
  return (
    <PageTitleProvider title={title}>
      {children}
    </PageTitleProvider>
  )
}


