import { redirect } from "next/navigation"
import { connection } from "next/server"

// Redirect-only aliases have no destination UI to prerender or prefetch.
export const instant = false

export default async function ProspectsPage() {
  await connection()
  redirect("/pipeline?view=prospects")
}
