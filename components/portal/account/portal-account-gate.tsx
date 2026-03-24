"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, FolderOpenDot, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { authenticateExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface PortalAccountGateProps {
  token: string
  tokenType: "portal" | "bid"
  orgName: string
  projectName: string
  defaultMode?: "claim" | "login"
  initialEmail?: string
  suggestedFullName?: string
  emailLocked?: boolean
  hasExistingAccount?: boolean
}

export function PortalAccountGate({
  token,
  tokenType,
  orgName,
  projectName,
  defaultMode = "claim",
  initialEmail = "",
  suggestedFullName = "",
  emailLocked = false,
  hasExistingAccount = false,
}: PortalAccountGateProps) {
  const router = useRouter()
  const [mode, setMode] = useState<"claim" | "login">(defaultMode)
  const [email, setEmail] = useState(initialEmail)
  const [fullName, setFullName] = useState(suggestedFullName)
  const [password, setPassword] = useState("")
  const [isPending, startTransition] = useTransition()
  const showModeToggle = !emailLocked || hasExistingAccount

  const title = hasExistingAccount ? "Sign in to Arc" : "Claim your Arc account"
  const description = hasExistingAccount
    ? `${orgName} found an Arc account for this invite. Sign in to open ${projectName}.`
    : emailLocked
      ? `${orgName} invited ${initialEmail} to access ${projectName}. Create your Arc account to continue.`
      : `${orgName} requires an Arc account to view ${projectName}.`

  const handleSubmit = () => {
    if (!email.trim()) {
      toast.error("Email is required")
      return
    }
    if (mode === "claim" && !fullName.trim()) {
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
          mode,
          email,
          full_name: mode === "claim" ? fullName : undefined,
          password,
        })
        toast.success("Access granted")
        router.refresh()
      } catch (error: any) {
        toast.error(error?.message ?? "Unable to continue")
      }
    })
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="relative overflow-hidden border border-border bg-card p-8 sm:p-10">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_40%),linear-gradient(135deg,hsl(var(--muted)/0.3),transparent_60%)]" />
          <div className="relative space-y-6">
            <Badge variant="outline" className="w-fit border-primary/30 bg-primary/10 text-primary">
              {tokenType === "bid" ? "Bid portal invite" : "Project portal invite"}
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>
            </div>

            <div className="border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Invite</p>
              <p className="mt-2 text-lg font-medium">{projectName}</p>
              <p className="text-sm text-muted-foreground">{orgName}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-border/70 bg-background/80 p-4">
                <ShieldCheck className="mb-3 h-5 w-5 text-primary" />
                <p className="text-sm font-medium">Secure access</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your invite stays tied to your account instead of a one-off link.
                </p>
              </div>
              <div className="border border-border/70 bg-background/80 p-4">
                <FolderOpenDot className="mb-3 h-5 w-5 text-primary" />
                <p className="text-sm font-medium">Your Arc hub</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Once you are in, you can come back and open every shared project from one workspace.
                </p>
              </div>
            </div>
          </div>
        </div>

        <Card className="w-full">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-xl">{title}</CardTitle>
              <Badge variant="outline">{tokenType === "bid" ? "Bid portal" : "Project portal"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{description}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{projectName}</p>
              <p className="text-muted-foreground">{orgName}</p>
            </div>

            {showModeToggle && (
              <div className="grid grid-cols-2 gap-2">
                <Button variant={mode === "claim" ? "default" : "outline"} onClick={() => setMode("claim")} type="button">
                  Claim Access
                </Button>
                <Button variant={mode === "login" ? "default" : "outline"} onClick={() => setMode("login")} type="button">
                  Sign In
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={emailLocked}
              />
              {emailLocked && (
                <p className="text-xs text-muted-foreground">
                  This invite is locked to the email above.
                </p>
              )}
            </div>

            {mode === "claim" && (
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Contractor" />
              </div>
            )}

            <div className="space-y-2">
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
            </div>

            <Button className="w-full" onClick={handleSubmit} disabled={isPending}>
              {isPending
                ? "Please wait..."
                : mode === "claim"
                  ? hasExistingAccount
                    ? "Confirm Account & Continue"
                    : "Claim Account & Continue"
                  : "Sign In & Continue"}
              {!isPending ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
