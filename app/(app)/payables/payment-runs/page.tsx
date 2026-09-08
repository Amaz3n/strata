import { redirect } from "next/navigation"

export default async function PaymentRunsPage() {
  redirect("/payables")
}
