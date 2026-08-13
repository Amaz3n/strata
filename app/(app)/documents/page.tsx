import { redirect } from "next/navigation"
export const instant = false

// desk-rule: reachable via dashboard/search/feature flows only, not workspace nav.
export default function FilesPage() {
  redirect("/projects")
}
