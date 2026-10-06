import { redirect } from "next/navigation"

export const instant = false

export default function BooksCutoverPage() {
  redirect("/settings/accounting/setup")
}
