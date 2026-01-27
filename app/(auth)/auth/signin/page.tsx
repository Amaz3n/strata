import { LoginForm } from "@/components/auth/login-form"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"

export default function SignInPage() {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-sm">
        <InviteHashHandler />
        <LoginForm />
      </div>
    </div>
  )
}
