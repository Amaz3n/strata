import { Suspense } from "react"
import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"

export default function SignInPage() {
  return (
    <>
      <Suspense>
        <InviteHashHandler />
      </Suspense>
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  )
}
