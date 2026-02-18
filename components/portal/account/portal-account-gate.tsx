"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { authenticateExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface PortalAccountGateProps {
  token: string
  tokenType: "portal" | "bid"
  orgName: string
  projectName: string
}

export function PortalAccountGate({ token, tokenType, orgName, projectName }: PortalAccountGateProps) {
  const router = useRouter()
  const [mode, setMode] = useState<"claim" | "login">("claim")
  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState("")
  const [password, setPassword] = useState("")
  const [isPending, startTransition] = useTransition()

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
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Account Access Required</CardTitle>
          <p className="text-sm text-muted-foreground">
            {orgName} requires an account to view {projectName}.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={mode === "claim" ? "default" : "outline"} onClick={() => setMode("claim")} type="button">
              Claim Access
            </Button>
            <Button variant={mode === "login" ? "default" : "outline"} onClick={() => setMode("login")} type="button">
              Sign In
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
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
            {isPending ? "Please wait..." : mode === "claim" ? "Create Account & Continue" : "Sign In & Continue"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
