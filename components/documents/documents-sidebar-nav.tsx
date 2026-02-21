"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import {
  FileText,
  FolderClosed,
  ChevronRight,
  Layers,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { listFoldersAction } from "@/app/(app)/files/actions"
import { listDrawingSetsAction } from "@/app/(app)/drawings/actions"
import type { DrawingSet } from "@/app/(app)/drawings/actions"

interface DocumentsSidebarNavProps {
  projectId: string
}

interface FolderNode {
  name: string
  path: string
  children: FolderNode[]
}

const EXPANDED_KEY = "docs-sidebar-expanded"

function buildFolderTreeFromPaths(folders: string[]): FolderNode[] {
  const root: FolderNode[] = []
  const pathMap = new Map<string, FolderNode>()

  const sorted = [...folders].sort()

  for (const path of sorted) {
    const parts = path.split("/").filter(Boolean)
    let currentPath = ""
    let parentNode: FolderNode | null = null

    for (const part of parts) {
      currentPath += `/${part}`

      let node = pathMap.get(currentPath)
      if (!node) {
        node = { name: part, path: currentPath, children: [] }
        pathMap.set(currentPath, node)
        if (parentNode) {
          parentNode.children.push(node)
        } else {
          root.push(node)
        }
      }
      parentNode = node
    }
  }

  return root
}

export function DocumentsSidebarNav({ projectId }: DocumentsSidebarNavProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentSetId = searchParams.get("set")
  const currentPath = searchParams.get("path") || ""

  const [folders, setFolders] = useState<string[]>([])
  const [drawingSets, setDrawingSets] = useState<DrawingSet[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set()
    try {
      const saved = localStorage.getItem(`${EXPANDED_KEY}-${projectId}`)
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch {
      return new Set()
    }
  })

  const fetchData = useCallback(async () => {
    try {
      const [foldersData, setsData] = await Promise.all([
        listFoldersAction(projectId),
        listDrawingSetsAction({ project_id: projectId }),
      ])
      setFolders(foldersData)
      setDrawingSets(setsData)
    } catch (error) {
      console.error("Failed to load sidebar nav data:", error)
    }
  }, [projectId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Listen for refresh events from content area mutations
  useEffect(() => {
    const handler = () => {
      fetchData()
    }
    window.addEventListener("docs-nav-refresh", handler)
    return () => window.removeEventListener("docs-nav-refresh", handler)
  }, [fetchData])

  const folderTree = useMemo(() => buildFolderTreeFromPaths(folders), [folders])

  const basePath = useMemo(() => {
    // Extract /projects/[id]/files from pathname
    const match = pathname.match(/^(\/projects\/[^/]+\/files)/)
    return match?.[1] ?? pathname
  }, [pathname])

  const navigateToRoot = useCallback(() => {
    router.push(basePath)
  }, [router, basePath])

  const navigateToFolder = useCallback(
    (path: string) => {
      const params = new URLSearchParams()
      params.set("path", path)
      router.push(`${basePath}?${params.toString()}`)
    },
    [router, basePath],
  )

  const navigateToSet = useCallback(
    (setId: string) => {
      const params = new URLSearchParams()
      params.set("set", setId)
      router.push(`${basePath}?${params.toString()}`)
    },
    [router, basePath],
  )

  const toggleFolder = useCallback(
    (path: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        if (typeof window !== "undefined") {
          localStorage.setItem(
            `${EXPANDED_KEY}-${projectId}`,
            JSON.stringify(Array.from(next)),
          )
        }
        return next
      })
    },
    [projectId],
  )

  // Auto-expand parent folders when navigating to a path
  useEffect(() => {
    if (!currentPath) return
    const parts = currentPath.split("/").filter(Boolean)
    const toExpand: string[] = []
    let acc = ""
    for (const part of parts.slice(0, -1)) {
      acc += `/${part}`
      toExpand.push(acc)
    }
    if (toExpand.length > 0) {
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const p of toExpand) {
          if (!next.has(p)) {
            next.add(p)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [currentPath])

  const isAllFilesActive = !currentSetId && !currentPath

  return (
    <>
      <SidebarGroup className="pt-3">
        <SidebarGroupLabel>Documents</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isAllFilesActive}
              onClick={navigateToRoot}
              tooltip="All Files"
            >
              <FileText />
              <span>All Files</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {folderTree.map((node) => (
            <FolderTreeItem
              key={node.path}
              node={node}
              currentPath={currentPath}
              expandedFolders={expandedFolders}
              onToggle={toggleFolder}
              onNavigate={navigateToFolder}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {drawingSets.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>Drawing Sets</SidebarGroupLabel>
          <SidebarMenu>
            {drawingSets.map((set) => (
              <SidebarMenuItem key={set.id}>
                <SidebarMenuButton
                  isActive={currentSetId === set.id}
                  onClick={() => navigateToSet(set.id)}
                  tooltip={set.title}
                >
                  <Layers />
                  <span className="truncate">{set.title}</span>
                </SidebarMenuButton>
                {(set.sheet_count ?? 0) > 0 && (
                  <SidebarMenuBadge>{set.sheet_count}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}
    </>
  )
}

function FolderTreeItem({
  node,
  currentPath,
  expandedFolders,
  onToggle,
  onNavigate,
}: {
  node: FolderNode
  currentPath: string
  expandedFolders: Set<string>
  onToggle: (path: string) => void
  onNavigate: (path: string) => void
}) {
  const isActive = currentPath === node.path
  const isExpanded = expandedFolders.has(node.path)
  const hasChildren = node.children.length > 0

  if (!hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          onClick={() => onNavigate(node.path)}
          tooltip={node.name}
        >
          <FolderClosed />
          <span className="truncate">{node.name}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Collapsible
      asChild
      open={isExpanded}
      onOpenChange={() => onToggle(node.path)}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={isActive} tooltip={node.name} onClick={() => onNavigate(node.path)}>
            <FolderClosed />
            <span className="truncate">{node.name}</span>
            <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <FolderSubItem
                key={child.path}
                node={child}
                currentPath={currentPath}
                expandedFolders={expandedFolders}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

function FolderSubItem({
  node,
  currentPath,
  expandedFolders,
  onToggle,
  onNavigate,
}: {
  node: FolderNode
  currentPath: string
  expandedFolders: Set<string>
  onToggle: (path: string) => void
  onNavigate: (path: string) => void
}) {
  const isActive = currentPath === node.path

  if (node.children.length === 0) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          isActive={isActive}
          onClick={() => onNavigate(node.path)}
        >
          <span className="truncate">{node.name}</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  const isExpanded = expandedFolders.has(node.path)

  return (
    <Collapsible
      asChild
      open={isExpanded}
      onOpenChange={() => onToggle(node.path)}
      className="group/collapsible"
    >
      <SidebarMenuSubItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton isActive={isActive} onClick={() => onNavigate(node.path)}>
            <span className="truncate">{node.name}</span>
            <ChevronRight className="ml-auto h-3 w-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <FolderSubItem
                key={child.path}
                node={child}
                currentPath={currentPath}
                expandedFolders={expandedFolders}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuSubItem>
    </Collapsible>
  )
}
