export interface FolderViewState {
  paths: string[]
  counts: Record<string, number>
}

export function folderParent(path: string): string {
  return path.slice(0, path.lastIndexOf("/"))
}

/** Replace one authoritative child listing, dropping vanished branches but keeping other loaded parents. */
export function reconcileFolderChildren(
  previous: FolderViewState,
  parent: string,
  children: ReadonlyArray<{ path: string; itemCount: number }>,
): FolderViewState {
  const childPaths = new Set(children.map((child) => child.path))
  const prefix = parent ? `${parent}/` : "/"
  const keepPath = (path: string) => {
    if (!path.startsWith(prefix)) return true
    const immediateChild = prefix + path.slice(prefix.length).split("/")[0]
    return childPaths.has(immediateChild)
  }
  const paths = new Set(previous.paths.filter(keepPath))
  if (parent) paths.add(parent)
  const counts = Object.fromEntries(Object.entries(previous.counts).filter(([path]) => keepPath(path)))
  for (const child of children) {
    paths.add(child.path)
    counts[child.path] = child.itemCount
  }
  return { paths: Array.from(paths).sort(), counts }
}

export function isCurrentViewRequest(key: string, generation: number, activeKey: string, activeGeneration: number) {
  return key === activeKey && generation === activeGeneration
}

export function appendUniqueFiles<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const seen = new Set(previous.map((file) => file.id))
  return [...previous, ...incoming.filter((file) => {
    if (seen.has(file.id)) return false
    seen.add(file.id)
    return true
  })]
}
