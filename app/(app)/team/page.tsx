import { redirect } from "next/navigation"

// The team surface lives in Settings. This route is kept only as a redirect so
// old links and bookmarks land in the right place.
export default function TeamPage() {
  redirect("/settings?tab=team")
}
