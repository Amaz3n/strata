"use client"

import { useState, useTransition, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { unlockDocumentSigningAction } from "../actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function UnlockSigningClient({ token }: { token: string }) {
  const router = useRouter()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        const result = await unlockDocumentSigningAction({ token, code })
        if (!result.success) { setError(result.error || "Unable to verify this access code."); return }
        setCode("")
        router.refresh()
      } catch { setError("Unable to verify the access code. Try again shortly.") }
    })
  }
  return <main className="flex min-h-screen items-center justify-center bg-background p-4">
    <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6">
      <h1 className="text-xl font-semibold">Enter your access code</h1>
      <p className="text-sm text-muted-foreground">The sender protected this document with a code. Contact them through your usual channel if you have not received it.</p>
      <Label htmlFor="signing-access-code">Access code</Label>
      <Input id="signing-access-code" type="password" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} maxLength={128} required autoFocus />
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending || !code.trim()}>{pending ? "Verifying…" : "Open document"}</Button>
    </form>
  </main>
}
