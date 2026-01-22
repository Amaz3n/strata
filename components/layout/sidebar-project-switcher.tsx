"use client"

import * as React from "react"
import { useEffect, useMemo, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import {
  ChevronsUpDown,
  Loader2,
  Search,
  ChevronLeft,
} from "@/components/icons"
import { ProjectAvatar } from "@/components/ui/project-avatar"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { Project } from "@/lib/types"

function isArchived(status?: Project["status"]) {
  return status === "completed" || status === "cancelled"
}

interface SidebarProjectSwitcherProps {
  projectId: string
}

export function SidebarProjectSwitcher({ projectId }: SidebarProjectSwitcherProps) {
  const { isMobile, state } = useSidebar()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [query, setQuery] = useState("")
  const [isPending, startTransition] = useTransition()
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

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

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(term))
  }, [projects, query])

  const activeProjects = filtered.filter((project) => !isArchived(project.status))
  const archivedProjects = filtered.filter((project) => isArchived(project.status))

  const currentProject = projects.find((p) => p.id === projectId)

  const handleSelect = (targetProjectId: string) => {
    startTransition(() => {
      const nextPath = pathname.replace(`/projects/${projectId}`, `/projects/${targetProjectId}`)
      const search = searchParams.toString()
      router.push(search ? `${nextPath}?${search}` : nextPath)
    })
  }

  const renderCurrent = () => {
    if (isLoading) {
      return (
        <>
          <Skeleton className="size-4 rounded shrink-0" />
          {state !== "collapsed" && (
            <Skeleton className="h-4 w-28" />
          )}
        </>
      )
    }

    if (!currentProject) {
      return (
        <>
          <div className="size-4 rounded bg-muted shrink-0" />
          {state !== "collapsed" && (
            <>
              <span className="truncate text-sm">Select project</span>
              <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
            </>
          )}
        </>
      )
    }

    return (
      <>
        <ProjectAvatar projectId={currentProject.id} size="sm" />
        {state !== "collapsed" && (
          <>
            <span className="truncate text-sm font-medium">{currentProject.name}</span>
            {isPending ? (
              <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
            )}
          </>
        )}
      </>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {renderCurrent()}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-72 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Switch Project
            </DropdownMenuLabel>

            <div className="px-2 py-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a project..."
                  className="pl-8 h-8"
                />
              </div>
            </div>

            <div className="max-h-64 overflow-auto">
              {loadError && (
                <div className="text-destructive px-2 py-3 text-xs whitespace-pre-wrap">
                  {loadError}
                </div>
              )}

              {activeProjects.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-[11px] uppercase tracking-wide">
                    Active
                  </DropdownMenuLabel>
                  {activeProjects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 p-2"
                      onSelect={() => handleSelect(project.id)}
                    >
                      <ProjectAvatar projectId={project.id} size="sm" />
                      <span className="truncate flex-1">{project.name}</span>
                      {project.id === projectId && (
                        <DropdownMenuShortcut>Current</DropdownMenuShortcut>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {archivedProjects.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-[11px] uppercase tracking-wide mt-2">
                    Archived
                  </DropdownMenuLabel>
                  {archivedProjects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      className="gap-2 p-2 text-muted-foreground"
                      onSelect={() => handleSelect(project.id)}
                    >
                      <ProjectAvatar projectId={project.id} size="sm" className="opacity-50" />
                      <span className="truncate flex-1">{project.name}</span>
                      {project.id === projectId && (
                        <DropdownMenuShortcut>Current</DropdownMenuShortcut>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {!isLoading && !loadError && filtered.length === 0 && (
                <div className="text-muted-foreground px-2 py-3 text-sm">
                  No projects found.
                </div>
              )}
            </div>

            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2" asChild>
              <Link href="/projects" className="flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <ChevronLeft className="size-4" />
                </div>
                <div className="font-medium">All Projects</div>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
