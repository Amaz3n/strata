import { redirect } from "next/navigation"

export default function CrmProspectsPage() {
  redirect("/pipeline?view=prospects")
}
