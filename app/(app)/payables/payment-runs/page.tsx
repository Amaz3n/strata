import { redirect } from "next/navigation"

// Compatibility redirect; the destination owns its navigation contract.
export const instant = false


export default async function PaymentRunsPage() {
  redirect("/payables")
}
