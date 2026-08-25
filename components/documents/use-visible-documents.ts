"use client"

import { useMemo } from "react"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { useDocuments, buildFolderTree } from "./documents-context"
import type { FolderNode } from "./types"

export interface VisibleFolder {
  type: "folder"
  path: string
  name: string
  itemCount: number
}

export interface VisibleDocuments {
  folderTree: FolderNode[]
  /** Child folders of the current path (top-level folders at the root). */
  currentFolders: VisibleFolder[]
  /** Files belonging to the current view, after the client-side path filter. */
  filteredFiles: FileWithUrls[]
  /** Whether folders belong in this view at all — they are hidden while searching or filtering. */
  showFolders: boolean
  hasFilters: boolean
}

function findFolderNode(nodes: FolderNode[], targetPath: string): FolderNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    const found = findFolderNode(node.children, targetPath)
    if (found) return found
  }
  return null
}

function toVisibleFolder(node: FolderNode): VisibleFolder {
  return {
    type: "folder",
    path: node.path,
    name: node.name,
    itemCount: node.itemCount,
  }
}

function normalizeFilePath(folderPath?: string | null): string {
  if (!folderPath) return ""
  return folderPath.startsWith("/") ? folderPath : `/${folderPath}`
}

/**
 * Derives what the current documents view should show.
 *
 * Shared by the desktop and mobile layouts so the two cannot drift — the path
 * filter and folder-visibility rules live here only.
 */
export function useVisibleDocuments(): VisibleDocuments {
  const { files, folders, folderItemCounts, currentPath, quickFilter, searchQuery } =
    useDocuments()

  const folderTree = useMemo(
    () => buildFolderTree(folders, files, folderItemCounts),
    [folders, files, folderItemCounts]
  )

  const currentFolders = useMemo(() => {
    if (!currentPath) {
      return folderTree.map(toVisibleFolder)
    }
    const currentNode = findFolderNode(folderTree, currentPath)
    if (!currentNode) return []
    return currentNode.children.map(toVisibleFolder)
  }, [folderTree, currentPath])

  // Files arrive already filtered by quickFilter and searchQuery from the server;
  // only the folder scope still needs applying on the client.
  const filteredFiles = useMemo(() => {
    if (currentPath && !searchQuery) {
      const normalizedPath = currentPath.replace(/\/+/g, "/")
      return files.filter((file) => normalizeFilePath(file.folder_path) === normalizedPath)
    }
    if (!currentPath && !searchQuery && quickFilter === "all") {
      return files.filter((file) => !file.folder_path || file.folder_path === "/")
    }
    return files
  }, [files, currentPath, searchQuery, quickFilter])

  const showFolders = quickFilter === "all" && (!searchQuery || Boolean(currentPath))
  const hasFilters =
    quickFilter !== "all" || Boolean(searchQuery) || Boolean(currentPath)

  return { folderTree, currentFolders, filteredFiles, showFolders, hasFilters }
}
