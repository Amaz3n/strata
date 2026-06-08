"use client"

import { useState, useTransition } from "react"
import type { FormEvent } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { sendSupportRequestAction } from "@/app/actions/support"
import { signOutAction } from "@/app/(auth)/auth/actions"
import {
  ChevronsUpDown,
  CircleHelp,
  HardHat,
  LogOut,
  Mail,
  Send,
  Settings,
} from "@/components/icons"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { User } from "@/lib/types"
import { useHydrated } from "@/hooks/use-hydrated"

const supportTopics = [
  { value: "account", label: "Account access" },
  { value: "billing", label: "Billing" },
  { value: "project", label: "Project/workflow help" },
  { value: "technical", label: "Technical issue" },
  { value: "feedback", label: "Product feedback" },
  { value: "other", label: "Other" },
] as const

type SupportTopic = (typeof supportTopics)[number]["value"]

export function NavUser({
  user,
  canAccessPlatform,
}: {
  user?: User | null
  canAccessPlatform?: boolean
}) {
  const { isMobile, state } = useSidebar()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [signingOut, startSignOut] = useTransition()
  const [supportOpen, setSupportOpen] = useState(false)
  const hydrated = useHydrated()
  const currentUrl = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`
  const settingsHref = `/settings?tab=profile&returnTo=${encodeURIComponent(currentUrl)}`

  const initials =
    user?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("") || "?"

  if (!hydrated) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="group-data-[collapsible=icon]:justify-center"
          >
            <Avatar className="h-6 w-6 rounded-none">
              <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
              <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
            {state !== "collapsed" && (
              <div className="flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
              </div>
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              <Avatar className="h-6 w-6 rounded-none">
                <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
                <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {state !== "collapsed" && (
                <>
                  <div className="flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </>
              )}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-max min-w-[max(16rem,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-1.5rem)] rounded-none border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/85"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="px-2 pb-2 pt-1 text-left font-normal">
              <div className="flex items-center gap-3 text-sm">
                <Avatar className="h-8 w-8 rounded-none border border-sidebar-border/70">
                  <AvatarImage src={user?.avatar_url} alt={user?.full_name ?? "User"} />
                  <AvatarFallback className="rounded-none bg-sidebar-primary text-sidebar-primary-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user?.full_name ?? "Signed In"}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user?.email ?? ""}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {canAccessPlatform && (
                <DropdownMenuItem className="rounded-none px-2.5 py-2.5 font-medium text-cyan-600 dark:text-cyan-400" asChild>
                  <Link href="/platform">
                    <HardHat className="size-4" />
                    Platform
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="rounded-none px-2.5 py-2.5" asChild>
                <Link href={settingsHref}>
                  <Settings />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem className="rounded-none px-2.5 py-2.5" asChild>
                <Link href="/help">
                  <CircleHelp />
                  Help Center
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-none px-2.5 py-2.5"
                onSelect={() => setSupportOpen(true)}
              >
                <Mail />
                Contact Support
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-none px-2.5 py-2.5 text-destructive"
              onSelect={(event) => {
                event.preventDefault()
                startSignOut(async () => {
                  await signOutAction()
                })
              }}
            >
              <LogOut />
              {signingOut ? "Signing out..." : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SupportRequestDialog
          open={supportOpen}
          onOpenChange={setSupportOpen}
          pageUrl={currentUrl}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function SupportRequestDialog({
  open,
  onOpenChange,
  pageUrl,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pageUrl: string
}) {
  const [topic, setTopic] = useState<SupportTopic>("technical")
  const [message, setMessage] = useState("")
  const [pending, startTransition] = useTransition()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    startTransition(async () => {
      try {
        const result = await sendSupportRequestAction({ topic, message, pageUrl })

        if (!result.success) {
          toast.error("Unable to send support request", {
            description: result.error,
          })
          return
        }

        toast.success("Support request sent")
        setMessage("")
        setTopic("technical")
        onOpenChange(false)
      } catch (error) {
        toast.error("Unable to send support request", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Contact Support</DialogTitle>
            <DialogDescription>
              Send a message to Arc support and include what you were working on.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="support-topic">Topic</Label>
            <Select value={topic} onValueChange={(value) => setTopic(value as SupportTopic)}>
              <SelectTrigger id="support-topic" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportTopics.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="support-message">Message</Label>
            <Textarea
              id="support-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Tell us what happened and what you expected."
              rows={5}
              disabled={pending}
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || message.trim().length < 10}>
              <Send className="size-4" />
              {pending ? "Sending..." : "Send message"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
