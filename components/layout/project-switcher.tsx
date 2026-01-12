"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronsUpDown, FolderOpen, Loader2, Search } from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { Project } from "@/lib/types"

function isArchived(status?: Project["status"]) {
  return status === "completed" || status === "cancelled"
}

function getProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

interface ProjectSwitcherProps {
  currentProjectId?: string
  currentProjectLabel?: string
}

export function ProjectSwitcher({ currentProjectId, currentProjectLabel }: ProjectSwitcherProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [query, setQuery] = useState("")
  const [isPending, startTransition] = useTransition()
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const resolvedProjectId = currentProjectId ?? getProjectIdFromPath(pathname) ?? undefined

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

  const currentLabel =
    currentProjectLabel ??
    projects.find((project) => project.id === resolvedProjectId)?.name ??
    "Select project"

  const displayLabel = !isLoading && projects.length === 0 ? "No projects" : currentLabel

  const handleSelect = (projectId: string) => {
    startTransition(() => {
      const targetPath = (() => {
        const id = resolvedProjectId
        if (!id) return `/projects/${projectId}`

        const nextPath = pathname.replace(`/projects/${id}`, `/projects/${projectId}`)
        return nextPath
      })()

      const search = searchParams.toString()
      router.push(search ? `${targetPath}?${search}` : targetPath)
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-foreground/80">
        <span className="truncate max-w-[160px]">{displayLabel}</span>
        {isPending || isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-2">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Switch project
        </DropdownMenuLabel>
        <div className="relative px-2 pb-2">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a project..."
            className="pl-9 h-8"
          />
        </div>
        <div className="max-h-72 overflow-auto px-2">
          {activeProjects.length > 0 && (
            <div className="space-y-1">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Active projects
              </p>
              {activeProjects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  className="flex items-center gap-2"
                  onSelect={() => handleSelect(project.id)}
                >
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                  {project.id === resolvedProjectId && (
                    <span className="ml-auto text-[10px] text-muted-foreground">Current</span>
                  )}
                </DropdownMenuItem>
              ))}
            </div>
          )}
          {archivedProjects.length > 0 && (
            <div className="space-y-1 pt-3">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Archived projects
              </p>
              {archivedProjects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  className="flex items-center gap-2 text-muted-foreground"
                  onSelect={() => handleSelect(project.id)}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="truncate">{project.name}</span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
          {loadError && (
            <div className="px-2 py-3 text-xs text-destructive whitespace-pre-wrap">
              {loadError}
            </div>
          )}
          {!isLoading && !loadError && filtered.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground">No projects found.</div>
          )}
        </div>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem onSelect={() => router.push("/projects")} className="text-sm">
          All Projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
