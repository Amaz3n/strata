"use client"

import { useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  ChevronsUpDown,
  Loader2,
} from "@/components/icons"
import { ProjectAvatar } from "@/components/ui/project-avatar"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import type { Project } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useHydrated } from "@/hooks/use-hydrated"

function isArchived(status?: Project["status"]) {
  return status === "completed" || status === "cancelled"
}

function formatProjectStatus(status?: Project["status"]) {
  return (status ?? "active").replace("_", " ")
}

interface SidebarProjectSwitcherProps {
  projectId?: string
}

function getProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

export function SidebarProjectSwitcher({ projectId }: SidebarProjectSwitcherProps) {
  const { isMobile, state } = useSidebar()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [isPending, startTransition] = useTransition()
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const hydrated = useHydrated()
  const pathProjectId = getProjectIdFromPath(pathname)
  const resolvedProjectId = projectId ?? pathProjectId ?? undefined

  useEffect(() => {
    let mounted = true
    async function loadProjects() {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" })
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Project fetch failed (${response.status}): ${text}`)
        }
        const payload = await response.json()
        if (mounted) {
          setProjects(payload?.projects ?? [])
          setLoadError(null)
        }
      } catch (error) {
        console.error("Failed to load projects", error)
        if (mounted) {
          setProjects([])
          setLoadError(error instanceof Error ? error.message : "Unknown error")
        }
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    loadProjects()
    return () => {
      mounted = false
    }
  }, [])

  const sortedProjects = [...projects].sort((a, b) => {
    const activeRank = Number(isArchived(a.status)) - Number(isArchived(b.status))
    if (activeRank !== 0) return activeRank
    return a.name.localeCompare(b.name)
  })

  const currentProject = projects.find((p) => p.id === resolvedProjectId)

  const handleSelect = (targetProjectId: string) => {
    startTransition(() => {
      const nextPath = pathProjectId
        ? pathname.replace(`/projects/${pathProjectId}`, `/projects/${targetProjectId}`)
        : `/projects/${targetProjectId}`
      const search = searchParams.toString()
      router.push(search ? `${nextPath}?${search}` : nextPath)
    })
  }

  const renderCurrent = () => {
    if (isLoading) {
      return (
        <>
          <Skeleton className="size-6 shrink-0 rounded-none" />
          {state !== "collapsed" && (
            <Skeleton className="h-4 w-28" />
          )}
        </>
      )
    }

    if (!currentProject) {
      return (
        <>
          <div className="size-6 shrink-0 rounded-none border border-border/70 bg-muted/40" />
          {state !== "collapsed" && (
            <>
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm font-medium">No project</span>
              <ChevronsUpDown className="ml-auto size-4" />
            </>
          )}
        </>
      )
    }

    return (
      <>
        <ProjectAvatar projectId={currentProject.id} size="lg" className="rounded-none" />
        {state !== "collapsed" && (
          <>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm font-medium">{currentProject.name}</span>
            {isPending ? (
              <Loader2 className="ml-auto size-4 animate-spin" />
            ) : (
              <ChevronsUpDown className="ml-auto size-4" />
            )}
          </>
        )}
      </>
    )
  }

  if (!hydrated) {
    return (
      <SidebarMenu className="w-full">
        <SidebarMenuItem className="w-full">
          <SidebarMenuButton className="h-10 group-data-[collapsible=icon]:justify-center">
            {renderCurrent()}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <SidebarMenu className="w-full">
      <SidebarMenuItem className="w-full">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-10 min-w-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              {renderCurrent()}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-max min-w-[max(19rem,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-1.5rem)] rounded-none border-border/80 bg-popover/95 p-2 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/85"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="px-2 pb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Switch project
            </DropdownMenuLabel>

            {loadError && (
              <div className="px-2 py-3 text-xs whitespace-pre-wrap text-destructive">
                {loadError}
              </div>
            )}

            {!loadError && !isLoading && sortedProjects.length === 0 && (
              <div className="px-2 py-3 text-sm text-muted-foreground">No projects found.</div>
            )}

            <div className="max-h-72 overflow-auto">
              {sortedProjects.map((project) => {
                const archived = isArchived(project.status)
                const isCurrent = project.id === resolvedProjectId
                return (
                  <DropdownMenuItem
                    key={project.id}
                    className={cn(
                      "group min-w-0 gap-3 rounded-none border border-transparent px-2.5 py-2.5 transition-colors",
                      "hover:bg-accent/40",
                      isCurrent && "border-primary/60 bg-primary/10 hover:bg-primary/15"
                    )}
                    onSelect={() => handleSelect(project.id)}
                  >
                    <ProjectAvatar
                      projectId={project.id}
                      size="md"
                      className={cn("shrink-0 rounded-none", archived && "opacity-55")}
                    />
                    <div className="flex-1">
                      <div className={cn("whitespace-nowrap text-sm font-medium", isCurrent && "font-semibold")}>
                        {project.name}
                      </div>
                      <div className={cn("whitespace-nowrap text-xs capitalize", isCurrent ? "text-foreground/70" : "text-muted-foreground")}>
                        {formatProjectStatus(project.status)}
                      </div>
                    </div>
                  </DropdownMenuItem>
                )
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
