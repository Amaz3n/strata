import { redirect } from "next/navigation"
export const instant = false

export default function ContactsPage() {
  redirect("/directory?view=people")
}
