import { redirect } from "next/navigation"

import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

// Workspace availability is organization/session data. A synthetic anonymous
// build sample cannot decide it; real sessions remain validated in dev.
export const instant = {
  unstable_disableBuildValidation: true,
}

export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  if (!(await isBooksWorkspaceEnabled())) {
    redirect("/settings?tab=accounting&returnTo=%2Fbooks")
  }
  return children
}
