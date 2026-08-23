import { redirect } from "next/navigation"
import { connection } from "next/server"
export const instant = false

export default async function CompaniesPage() {
  await connection()
  redirect("/directory?kind=company")
}
