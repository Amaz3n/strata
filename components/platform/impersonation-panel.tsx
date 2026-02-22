"use client"

import { useActionState } from "react"
import { useRouter } from "next/navigation"

import { startImpersonationAction } from "@/app/(app)/platform/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, CheckCircle } from "@/components/icons"

interface OrgOption {
  id: string
  name: string
}

const initialState = { error: undefined, message: undefined }

export function ImpersonationPanel({ orgs }: { orgs: OrgOption[] }) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(startImpersonationAction, initialState)

  return (
    <form
      action={async (formData) => {
        await formAction(formData)
        router.refresh?.()
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="targetEmail">Target user email</Label>
          <Input id="targetEmail" name="targetEmail" type="email" placeholder="user@customer.com" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgId">Organization context (optional)</Label>
          <select
            id="orgId"
            name="orgId"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            defaultValue=""
          >
            <option value="">No org override</option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="reason">Reason</Label>
          <Input id="reason" name="reason" placeholder="Investigating customer report #1234" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="expiresInMinutes">Session duration (minutes)</Label>
          <Input id="expiresInMinutes" name="expiresInMinutes" type="number" min={5} max={240} defaultValue={60} />
        </div>
      </div>

      {state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{state.error}</span>
        </div>
      )}

      {state.message && !state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle className="mt-0.5 h-4 w-4" />
          <span>{state.message}</span>
        </div>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? "Starting..." : "Start impersonation"}
      </Button>
    </form>
  )
}
