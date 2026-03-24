"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { signInExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ExternalAccessLogin() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    if (!email.trim()) {
      toast.error("Email is required")
      return
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }

    startTransition(async () => {
      try {
        await signInExternalPortalAccountAction({
          email,
          password,
        })
        toast.success("Signed in")
        router.refresh()
      } catch (error: any) {
        toast.error(error?.message ?? "Unable to sign in")
      }
    })
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10 sm:px-6">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="relative overflow-hidden border border-border bg-card p-8 sm:p-10">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.14),transparent_45%),linear-gradient(135deg,hsl(var(--muted)/0.3),transparent_60%)]" />
          <div className="relative space-y-6">
            <Badge variant="outline" className="w-fit border-primary/30 bg-primary/10 text-primary">
              External workspace
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
                One Arc sign-in for every project this builder has shared with you.
              </h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                Once you claim access from an invite link, you can come back here to reopen client portals, sub portals,
                and bid workspaces from one place.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-border/70 bg-background/80 p-4">
                <ShieldCheck className="mb-3 h-5 w-5 text-primary" />
                <p className="text-sm font-medium">Account-based access</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use the same email from your invite to keep everything connected.
                </p>
              </div>
              <div className="border border-border/70 bg-background/80 p-4">
                <KeyRound className="mb-3 h-5 w-5 text-primary" />
                <p className="text-sm font-medium">Claim first, then return</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  If you are new here, open any project or bid link first to claim your Arc account.
                </p>
              </div>
            </div>
          </div>
        </div>

        <Card className="border-border/80">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">Sign in to Arc</CardTitle>
            <p className="text-sm text-muted-foreground">
              Use the email and password tied to your external workspace.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="external-access-email">Email</Label>
              <Input
                id="external-access-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="external-access-password">Password</Label>
              <Input
                id="external-access-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your Arc password"
                autoComplete="current-password"
              />
            </div>

            <Button className="w-full" onClick={handleSubmit} disabled={isPending}>
              {isPending ? "Signing in..." : "Open workspace"}
              {!isPending ? <ArrowRight className="h-4 w-4" /> : null}
            </Button>

            <p className="text-xs leading-5 text-muted-foreground">
              Tip: if a builder just sent your first invite, open that secure link first. You will be prompted to claim
              your Arc account before entering the portal.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
