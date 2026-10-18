import { redirect } from "next/navigation"
import { connection } from "next/server"
import { Suspense, type ReactNode } from "react"

import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

export const instant = true

async function BooksAccess() {
  await connection()
  if (!(await isBooksWorkspaceEnabled())) {
    redirect("/settings?tab=accounting&returnTo=%2Fbooks")
  }
  return null
}

export default function BooksLayout({ children }: { children: ReactNode }) {
  // Each page's readers and mutations enforce the fresh workspace and permission
  // gates. The layout redirect must not hold their public destination shells.
  return <><Suspense fallback={null}><BooksAccess /></Suspense>{children}</>
}
