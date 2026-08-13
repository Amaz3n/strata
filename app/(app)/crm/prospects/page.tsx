import { redirect } from "next/navigation"
export const instant = false

export default function CrmProspectsPage() {
  redirect("/pipeline?view=prospects")
}
