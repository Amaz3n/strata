"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Check, ChevronsUpDown, LayoutGrid, LogOut } from "lucide-react"
import { useTransition } from "react"
import { toast } from "sonner"

import { signOutExternalPortalAccountAction } from "@/app/actions/external-portal-auth"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ExternalPortalWorkspaceContext } from "@/lib/types"

interface ExternalWorkspaceSwitcherProps {
  workspace: ExternalPortalWorkspaceContext
}

export function ExternalWorkspaceSwitcher({ workspace }: ExternalWorkspaceSwitcherProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const currentItem = workspace.items.find((item) => item.href === pathname) ?? workspace.items[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[220px] gap-2">
          <LayoutGrid className="h-4 w-4 shrink-0" />
          <span className="truncate">{currentItem ? currentItem.project_name : "Workspace"}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="space-y-1">
          <p className="truncate text-sm font-medium">{workspace.account.full_name || workspace.account.email}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{workspace.org.name}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspace.items.map((item) => {
          const isCurrent = item.href === pathname
          return (
            <DropdownMenuItem key={item.id} asChild>
              <Link href={item.href} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{item.project_name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {item.label}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p>
                </div>
                {isCurrent ? <Check className="mt-0.5 h-4 w-4 text-primary" /> : null}
              </Link>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/access">
            <LayoutGrid className="h-4 w-4" />
            View workspace hub
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isPending}
          onSelect={(event) => {
            event.preventDefault()
            startTransition(async () => {
              try {
                await signOutExternalPortalAccountAction()
                router.push("/access")
                router.refresh()
              } catch (error: any) {
                toast.error(error?.message ?? "Unable to sign out")
              }
            })
          }}
        >
          <LogOut className="h-4 w-4" />
          {isPending ? "Signing out..." : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
