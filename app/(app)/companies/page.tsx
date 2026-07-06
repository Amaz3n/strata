import { redirect } from "next/navigation"

export default function CompaniesPage() {
  redirect("/directory?view=companies")
}
