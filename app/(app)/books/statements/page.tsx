import { redirect } from "next/navigation"

export const instant = false

export default function BooksStatementsPage() { redirect("/reports?collection=statements") }
