"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { authenticateExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface PortalClaimAccountProps {
  token: string
  tokenType: "portal" | "bid"
  /** Prefilled from the invite; locked when present so the grant still matches. */
  email?: string
  suggestedFullName?: string
}

/**
 * Offers a free account to someone who arrived on a direct link, so their
 * portals collect in one workspace. Deliberately a quiet header affordance —
 * it is an upsell, and the sub came here to do a job.
 */
export function PortalClaimAccount({
  token,
  tokenType,
  email = "",
  suggestedFullName = "",
}: PortalClaimAccountProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [claimEmail, setClaimEmail] = useState(email)
  const [fullName, setFullName] = useState(suggestedFullName)
  const [password, setPassword] = useState("")
  const [isPending, startTransition] = useTransition()

  const submit = () => {
    if (!claimEmail.trim()) {
      toast.error("Email is required")
      return
    }
    if (!fullName.trim()) {
      toast.error("Full name is required")
      return
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }

    startTransition(async () => {
      try {
        await authenticateExternalPortalAccountAction({
          token,
          token_type: tokenType,
          mode: "claim",
          email: claimEmail,
          full_name: fullName,
          password,
        })
        toast.success("Account created")
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to claim account")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="hidden sm:inline-flex">
          Save my access
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save your access</DialogTitle>
          <DialogDescription>
            Create a free account with your invited email and every portal you are invited to
            collects in one place — no more hunting for links in email.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="claim-email">Email</Label>
            <Input
              id="claim-email"
              type="email"
              value={claimEmail}
              onChange={(event) => setClaimEmail(event.target.value)}
              placeholder="name@company.com"
              disabled={!!email || isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-name">Full name</Label>
            <Input
              id="claim-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Your name"
              disabled={isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-password">Password</Label>
            <Input
              id="claim-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              disabled={isPending}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
            Not now
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Create account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
