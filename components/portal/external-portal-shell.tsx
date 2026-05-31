"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"
import { type LucideIcon, ShieldCheck, ArrowRight, Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authenticateExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import type { ExternalPortalWorkspaceContext, Project } from "@/lib/types"

export interface ExternalPortalTab<TTab extends string> {
  id: TTab
  label: string
  icon?: LucideIcon
  indicator?: ReactNode
}

interface ExternalPortalShellProps<TTab extends string> {
  orgName: string
  project: Project
  workspace?: ExternalPortalWorkspaceContext | null
  logoUrl?: string | null
  isMobile: boolean
  activeTab: TTab
  onTabChange: (tab: TTab) => void
  tabs: ExternalPortalTab<TTab>[]
  desktopTabs?: ExternalPortalTab<TTab>[]
  renderTab: (tab: TTab) => ReactNode
  mobileNav: ReactNode
  pinVerified?: boolean
  pinGate?: ReactNode
  token?: string
  tokenType?: "portal" | "bid"
  email?: string
  suggestedFullName?: string
}

export function ExternalPortalShell<TTab extends string>({
  orgName,
  project,
  workspace = null,
  logoUrl = null,
  isMobile,
  activeTab,
  onTabChange,
  tabs,
  desktopTabs,
  renderTab,
  mobileNav,
  pinVerified = true,
  pinGate = null,
  token,
  tokenType,
  email = "",
  suggestedFullName = "",
}: ExternalPortalShellProps<TTab>) {
  const router = useRouter()
  const resolvedDesktopTabs = desktopTabs ?? tabs
  const visibleTabIds = (isMobile ? tabs : resolvedDesktopTabs).map((tab) => tab.id)

  const [showClaimModal, setShowClaimModal] = useState(false)
  const [claimEmail, setClaimEmail] = useState(email)
  const [claimFullName, setClaimFullName] = useState(suggestedFullName)
  const [claimPassword, setClaimPassword] = useState("")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (email) setClaimEmail(email)
  }, [email])

  useEffect(() => {
    if (suggestedFullName) setClaimFullName(suggestedFullName)
  }, [suggestedFullName])

  useEffect(() => {
    if (!visibleTabIds.includes(activeTab)) {
      onTabChange(visibleTabIds[0])
    }
  }, [activeTab, onTabChange, visibleTabIds])

  const handleClaimAccount = () => {
    if (!claimEmail.trim()) {
      toast.error("Email is required")
      return
    }
    if (!claimFullName.trim()) {
      toast.error("Full name is required")
      return
    }
    if (claimPassword.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }
    if (!token || !tokenType) return

    startTransition(async () => {
      try {
        await authenticateExternalPortalAccountAction({
          token,
          token_type: tokenType,
          mode: "claim",
          email: claimEmail,
          full_name: claimFullName,
          password: claimPassword,
        })
        toast.success("Account claimed successfully!")
        setShowClaimModal(false)
        router.refresh()
      } catch (error: any) {
        toast.error(error?.message ?? "Unable to claim account")
      }
    })
  }

  if (!pinVerified) {
    return <>{pinGate}</>
  }

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans">
      <PortalHeader orgName={orgName} project={project} workspace={workspace} logoUrl={logoUrl} />

      {workspace === null && token && tokenType && (
        <div className="bg-primary/5 border-b border-border/60 px-4 py-2 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0 text-center sm:text-left">
          <div className="flex items-center gap-2 text-xs">
            <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
            <span className="text-muted-foreground">
              You are viewing this portal via a direct link. <strong className="text-foreground font-semibold">Claim your account</strong> to see all your invites and documents in one workspace.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowClaimModal(true)}
            className="h-7 text-xs px-3 border-primary/20 bg-background hover:bg-primary/5 hover:text-primary transition-all shrink-0 font-medium"
          >
            Claim Free Account <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      )}

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">{renderTab(activeTab)}</main>
          {mobileNav}
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-6">
          <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as TTab)}>
            <TabsList className="w-full justify-start mb-6 h-11">
              {resolvedDesktopTabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <TabsTrigger key={tab.id} value={tab.id} className="gap-2 relative">
                    {Icon ? <Icon className="h-4 w-4" /> : null}
                    {tab.label}
                    {tab.indicator}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            {resolvedDesktopTabs.map((tab) => (
              <TabsContent key={tab.id} value={tab.id}>
                {renderTab(tab.id)}
              </TabsContent>
            ))}
          </Tabs>
        </main>
      )}

      {showClaimModal && (
        <Dialog open={showClaimModal} onOpenChange={setShowClaimModal}>
          <DialogContent className="max-w-md">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-bold">Claim your Arc Account</DialogTitle>
              <DialogDescription>
                Create an account using your invited email. You'll be able to view all current and future portals in a centralized dashboard.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="claim-email">Email Address</Label>
                <Input
                  id="claim-email"
                  type="email"
                  value={claimEmail}
                  onChange={(e) => setClaimEmail(e.target.value)}
                  placeholder="name@company.com"
                  disabled={!!email}
                  className="bg-muted/30"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-fullname">Full Name</Label>
                <Input
                  id="claim-fullname"
                  type="text"
                  value={claimFullName}
                  onChange={(e) => setClaimFullName(e.target.value)}
                  placeholder="John Doe"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-password">Password</Label>
                <Input
                  id="claim-password"
                  type="password"
                  value={claimPassword}
                  onChange={(e) => setClaimPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" onClick={() => setShowClaimModal(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={handleClaimAccount} disabled={isPending}>
                {isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Claiming...
                  </>
                ) : (
                  "Create Account"
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
