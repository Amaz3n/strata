import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { requireAuth } from "@/lib/auth/context"

export async function AuthGuard({ children }: { children: ReactNode }) {
  try {
    await requireAuth()
  } catch {
    redirect("/auth/signin")
  }

  return <>{children}</>
}
