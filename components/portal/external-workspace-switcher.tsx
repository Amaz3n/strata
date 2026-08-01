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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ExternalPortalWorkspaceContext, ExternalPortalWorkspaceItem } from "@/lib/types"

interface ExternalWorkspaceSwitcherProps {
  workspace: ExternalPortalWorkspaceContext
}

/** Past this many projects under one builder the menu stops being scannable. */
const MAX_ITEMS_PER_ORG = 8

function groupByOrg(items: ExternalPortalWorkspaceItem[]) {
  const groups = new Map<string, { orgName: string; items: ExternalPortalWorkspaceItem[] }>()
  for (const item of items) {
    const existing = groups.get(item.org_id)
    if (existing) {
      existing.items.push(item)
      continue
    }
    groups.set(item.org_id, { orgName: item.org_name, items: [item] })
  }
  return Array.from(groups.entries()).map(([orgId, group]) => ({ orgId, ...group }))
}

function ProjectItem({
  item,
  isCurrent,
}: {
  item: ExternalPortalWorkspaceItem
  isCurrent: boolean
}) {
  return (
    <DropdownMenuItem asChild>
      <Link href={item.href} className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.project_name}</span>
          {item.subtitle ? (
            <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
          ) : null}
        </span>
        {isCurrent ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
      </Link>
    </DropdownMenuItem>
  )
}

/**
 * Switching between builders and their projects happens here, in place, so the
 * hub at /access is only ever needed as a signed-in landing page — not as a
 * detour you take to change projects.
 */
export function ExternalWorkspaceSwitcher({ workspace }: ExternalWorkspaceSwitcherProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const currentItem = workspace.items.find((item) => item.href === pathname) ?? workspace.items[0]

  // Identity means "who am I signed in as": the person and the company they
  // represent. The builder is already the masthead and must not repeat here.
  const personName = workspace.identity.full_name || workspace.identity.email
  const representing = currentItem?.company_name ?? currentItem?.contact_name ?? null
  const secondaryLine =
    representing && representing !== personName ? representing : workspace.identity.email

  const orgGroups = groupByOrg(workspace.items)
  // One builder needs no nesting — a submenu holding the only group is a click
  // that buys nothing.
  const isSingleOrg = orgGroups.length <= 1

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[220px] gap-2">
          <LayoutGrid className="size-4 shrink-0" />
          <span className="truncate">{currentItem ? currentItem.project_name : "Projects"}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="space-y-1">
          <p className="truncate text-sm font-medium">{personName}</p>
          {secondaryLine !== personName ? (
            <p className="truncate text-xs font-normal text-muted-foreground">{secondaryLine}</p>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {isSingleOrg
          ? orgGroups[0]?.items
              .slice(0, MAX_ITEMS_PER_ORG)
              .map((item) => (
                <ProjectItem key={item.id} item={item} isCurrent={item.href === pathname} />
              ))
          : orgGroups.map((group) => {
              const visible = group.items.slice(0, MAX_ITEMS_PER_ORG)
              const hidden = group.items.length - visible.length
              const holdsCurrent = group.items.some((item) => item.href === pathname)

              return (
                <DropdownMenuSub key={group.orgId}>
                  <DropdownMenuSubTrigger>
                    <span className="min-w-0 flex-1 truncate">{group.orgName}</span>
                    <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {group.items.length}
                    </span>
                    {holdsCurrent ? <Check className="ml-1.5 size-4 shrink-0 text-primary" /> : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-72">
                    {visible.map((item) => (
                      <ProjectItem key={item.id} item={item} isCurrent={item.href === pathname} />
                    ))}
                    {hidden > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                          <Link href="/access">{hidden} more…</Link>
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )
            })}

        {isSingleOrg && (orgGroups[0]?.items.length ?? 0) > MAX_ITEMS_PER_ORG ? (
          <DropdownMenuItem asChild>
            <Link href="/access">
              {(orgGroups[0]?.items.length ?? 0) - MAX_ITEMS_PER_ORG} more…
            </Link>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isPending}
          onSelect={(event) => {
            event.preventDefault()
            startTransition(async () => {
              try {
                await signOutExternalPortalAccountAction()
                router.push("/access")
                router.refresh()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Unable to sign out")
              }
            })
          }}
        >
          <LogOut className="size-4" />
          {isPending ? "Signing out..." : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
