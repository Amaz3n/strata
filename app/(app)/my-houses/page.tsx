import { redirect } from "next/navigation"

// "My Houses" was merged into Home, which now composes itself from the bands
// the viewer is accountable for — a superintendent's assigned houses lead it.
// Keep this route as a redirect for existing bookmarks and notification links.
export default function MyHousesPage() {
  redirect("/")
}
