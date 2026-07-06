import { redirect } from "next/navigation"

// desk-rule: reachable via dashboard/search/feature flows only, not workspace nav.
export default function FilesPage() {
  redirect("/projects")
}
