import { redirect } from "next/navigation"

import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  if (!(await isBooksWorkspaceEnabled())) {
    redirect("/settings?tab=accounting&returnTo=%2Fbooks")
  }
  return children
}
