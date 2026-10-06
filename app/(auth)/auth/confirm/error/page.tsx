import Link from "next/link"
import { ArrowLeft } from "lucide-react"

export default function ConfirmationErrorPage() {
  return (
    <div className="flex flex-col gap-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Invalid or expired link</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Request a new invite or reset link to continue.
        </p>
      </div>
      <Link href="/auth/signin" className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" />
        Back to sign in
      </Link>
    </div>
  )
}
