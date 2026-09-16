import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { normalizeFolderPath, type FolderChild } from "@/lib/services/files"

export async function listOfficeFolderChildren(parentPath?: string, orgId?: string): Promise<FolderChild[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("docs.read", context)
  const { data, error } = await context.supabase.rpc("list_office_document_children", {
    p_org_id: context.orgId,
    p_parent_path: normalizeFolderPath(parentPath) === "/" ? null : normalizeFolderPath(parentPath) ?? null,
  })
  if (error) throw new Error(`Failed to load office folders: ${error.message}`)
  return (data ?? []).map((row: { path: string; name: string; item_count: number }) => ({
    path: row.path, name: row.name, itemCount: Number(row.item_count),
  }))
}

export async function createOfficeFolder(folderPath: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("docs.upload", context)
  const path = normalizeFolderPath(folderPath)
  if (!path || path === "/") throw new Error("Folder path is required")
  const { error } = await context.supabase.from("org_document_folders").upsert({
    org_id: context.orgId, path, created_by: context.userId,
  }, { onConflict: "org_id,path", ignoreDuplicates: true })
  if (error) throw new Error(`Failed to create office folder: ${error.message}`)
  return path
}

export async function mutateOfficeFolder(folderPath: string, newName?: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission(newName === undefined ? "docs.delete" : "docs.upload", context)
  const path = normalizeFolderPath(folderPath)
  if (!path || path === "/") throw new Error("Cannot change the root folder")
  let newPath: string | null = null
  if (newName !== undefined) {
    const name = newName.trim()
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") throw new Error("Enter a valid folder name")
    newPath = `${path.slice(0, path.lastIndexOf("/"))}/${name}`
  }
  const { data, error } = await context.supabase.rpc("mutate_office_document_folder", {
    p_org_id: context.orgId, p_path: path, p_new_path: newPath,
  })
  if (error) throw new Error(error.message)
  return { affectedFiles: Number(data ?? 0) }
}
