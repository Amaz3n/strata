import type React from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { getCurrentUserAction } from "../actions/user"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Fetch user data once at the layout level for the persistent shell
  const currentUser = await getCurrentUserAction()

  return (
    <SidebarProvider suppressHydrationWarning>
      <AppSidebar user={currentUser} />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <PageTitleProvider>
          <AppHeader />
          <div className="flex flex-1 flex-col gap-4 p-4 pt-6 min-w-0 overflow-x-hidden">
            {children}
          </div>
        </PageTitleProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}
