import { redirect } from "next/navigation"

// Compatibility redirect; the destination owns its navigation contract.
export const instant = false


export default function BooksTransactionsPage() {
  redirect("/books/banking")
}
