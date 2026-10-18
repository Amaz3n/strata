import { redirect } from "next/navigation"

export const instant = false

export default function BooksOpeningBalancesPage() {
  redirect("/settings/accounting/opening-balances")
}
