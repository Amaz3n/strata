import { redirect } from "next/navigation"
export const instant = false

// "My Work" was merged into the org-wide Tasks page (tasks + approvals in one
// personal hub). Keep this route as a redirect for existing bookmarks/links.
export default function MyWorkPage() {
  redirect("/tasks")
}
