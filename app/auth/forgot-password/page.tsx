import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-white/60">Reset access</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Send a reset link</h2>
        <p className="text-sm text-white/60">
          We will email you a secure link to create a new password. The link expires shortly for safety.
        </p>
      </div>
      <ForgotPasswordForm />
    </div>
  )
}
