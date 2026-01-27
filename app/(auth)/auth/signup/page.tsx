import { SignUpForm } from "@/components/auth/sign-up-form"

export default function SignUpPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Create workspace</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Start with Arc</h2>
        <p className="text-sm text-white/60">
          We will create your organization, membership, and session using Supabase auth.
        </p>
      </div>
      <SignUpForm />
    </div>
  )
}
