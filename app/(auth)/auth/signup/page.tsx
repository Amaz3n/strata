import { redirect } from "next/navigation"
import { connection } from "next/server"

// Compatibility redirect only; there is no destination UI to validate.
export const instant = {
  unstable_disableValidation: true,
}

export default async function SignUpPage() {
  await connection()
  redirect("/auth/signin?reason=invite-only")
}
