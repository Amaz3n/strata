import { MfaChallengeForm } from "@/components/auth/mfa-challenge-form"

export default function MfaPage() {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <MfaChallengeForm />
    </div>
  )
}
