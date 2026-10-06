"use server"

import { addOptionConfigurationRule, removeOptionConfigurationRule, listOptionConfigurationRules, searchConfigurationTargets } from "@/lib/services/configuration-rules"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { discoverCatalogGroupCategories } from "@/lib/services/catalog-group-categories"
import { reviewCatalogGroupCategories } from "@/lib/services/catalog-group-publication"
import { selectionGroupSchema } from "@/lib/validation/selections"

import { createHash } from "node:crypto"

import { actionError, unwrapAction, type ActionResult } from "@/lib/action-result"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { buildFilesPublicUrl } from "@/lib/storage/files-storage"
import {
  archiveCatalogEntity,
  cloneOrgGroupsToCommunity,
  findCatalogImageByChecksum,
  listModelOptions,
  setCatalogPrice,
  upsertAppointment,
  upsertCategory,
  upsertOption,
  upsertPackage,
  publishCatalogPrices,
  upsertSelectionGroup,
  CATALOG_IMAGE_FOLDER,
  type CatalogImage,
  type ModelOptionList,
} from "@/lib/services/option-catalog"
import { recomputeCommunityCutoffs, overrideGroupCutoff, revertCutoffToSchedule } from "@/lib/services/selection-cutoffs"
import { createPostCutoffSelectionChangeOrder } from "@/lib/services/selection-change-orders"
import { confirmSelectionGroup, selectProjectOption, selectProjectPackage } from "@/lib/services/selections"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { discoverCatalogPackageMembers } from "@/lib/services/catalog-package-members"
import { listArchivedCatalogPackages, listPendingCatalogPublications, listCatalogPublicationHistory, recoverCatalogPublicationRequest } from "@/lib/services/catalog-publication-history"
import { acknowledgeCatalogPublication, cancelCatalogPublication, inspectCatalogPublication } from "@/lib/services/catalog-publication-reconciliation"

async function run<T>(operation: () => Promise<T>, paths: string[] = []): Promise<ActionResult<T>> {
  try {
    const data = await operation()
    revalidatePath("/design-studio")
    for (const path of paths) revalidatePath(path)
    return { success: true, data }
  } catch (error) {
    return actionError(error)
  }
}

export async function upsertCategoryAction(input: unknown) {
  return run(() => upsertCategory(input as Parameters<typeof upsertCategory>[0]), ["/design-studio/catalog"])
}

export async function upsertOptionAction(input: unknown) {
  return run(() => upsertOption(input as Parameters<typeof upsertOption>[0]), ["/design-studio/catalog"])
}

/** Catalogue options the project's 3D model can apply, for the drawings workspace. Read-only, so nothing is revalidated. */
export async function loadModelOptionsAction(projectId: string): Promise<ActionResult<ModelOptionList>> {
  try {
    return { success: true, data: await listModelOptions(projectId) }
  } catch (error) {
    return actionError(error)
  }
}

export async function upsertPackageAction(input: unknown) {
  return run(() => upsertPackage(input as Parameters<typeof upsertPackage>[0]), ["/design-studio/catalog"])
}

export async function publishCatalogPricesAction(input: unknown) {
  return run(() => publishCatalogPrices(input), ["/design-studio/catalog"])
}

export async function inspectCatalogPublicationAction(input: unknown) {
  return run(() => inspectCatalogPublication(input))
}

export async function acknowledgeCatalogPublicationAction(input: unknown) {
  return run(() => acknowledgeCatalogPublication(input), ["/design-studio/catalog", "/design-studio/rules"])
}

export async function setCatalogPriceAction(input: unknown) {
  return run(() => setCatalogPrice(input as Parameters<typeof setCatalogPrice>[0]), ["/design-studio/catalog"])
}

export async function upsertSelectionGroupAction(input: unknown) {
  return run(async () => {
    const saved = await upsertSelectionGroup(selectionGroupSchema.extend({ expectedOrgId: z.string().uuid(), expectedActorId: z.string().uuid() }).parse(input))
    if (saved.community_id) {
      const { orgId } = await requireOrgContext()
      await recomputeCommunityCutoffs(saved.community_id, orgId)
    }
    return saved
  }, ["/design-studio/rules"])
}

export async function upsertAppointmentAction(input: unknown) {
  return run(() => upsertAppointment(input as Parameters<typeof upsertAppointment>[0]))
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * Option photography, uploaded straight to R2 through the shared files pipeline
 * rather than pasted in as a URL. The stored address is the public CDN one, not
 * the session-guarded `/api/files` route, because the buyer portal renders these
 * images to a token holder who has no org membership.
 */
export async function uploadOptionImageAction(formData: FormData): Promise<ActionResult<CatalogImage>> {
  return run(async () => {
    const context = await requireOrgContext()
    await requirePermission("selections.catalog.manage", context)

    const file = formData.get("file")
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose an image to upload")
    if (!file.type.startsWith("image/")) throw new Error("Option photography must be an image file")
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`Images must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB — this one is ${(file.size / 1024 / 1024).toFixed(1)} MB`)
    }

    const checksum = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex")
    const existing = await findCatalogImageByChecksum(checksum)
    if (existing) return existing

    const upload = new FormData()
    upload.set("file", file)
    upload.set("category", "photos")
    upload.set("visibility", "public")
    upload.set("folderPath", CATALOG_IMAGE_FOLDER)
    const uploaded = unwrapAction(await uploadFileAction(upload))
    const url = buildFilesPublicUrl(uploaded.storage_path)
    if (!url) throw new Error("File storage is not configured to serve public image URLs")
    return { fileId: uploaded.id, url, fileName: uploaded.file_name }
  }, ["/design-studio/catalog"])
}

export async function archiveCatalogEntityAction(input: unknown) {
  const schema = z.object({ type: z.enum(["category", "option", "package"]), id: z.string().uuid(), archived: z.boolean().optional() })
  return run(() => archiveCatalogEntity(schema.parse(input)), ["/design-studio/catalog"])
}

export async function cloneOrgGroupsAction(communityId: string) {
  return run(() => cloneOrgGroupsToCommunity(z.string().uuid().parse(communityId)), ["/design-studio/rules"])
}

export async function overrideGroupCutoffAction(input: unknown) {
  return run(() => overrideGroupCutoff(input as Parameters<typeof overrideGroupCutoff>[0]))
}

export async function revertGroupCutoffAction(input: unknown) {
  const parsed = z.object({ projectId: z.string().uuid(), groupId: z.string().uuid() }).parse(input)
  return run(() => revertCutoffToSchedule(parsed))
}

export async function createPostCutoffChangeOrderAction(input: unknown) {
  return run(() => createPostCutoffSelectionChangeOrder(input as Parameters<typeof createPostCutoffSelectionChangeOrder>[0]))
}

const sheetSelectionSchema = z.object({
  projectId: z.string().uuid(),
  selectionId: z.string().uuid(),
  optionId: z.string().uuid(),
})

/**
 * Choosing an option during an appointment. The lock rules (structural after
 * signature, past cutoff) live in the service and raise SelectionLockError, so
 * the sheet surfaces the reason rather than silently failing.
 */
export async function chooseOptionAction(input: unknown) {
  const parsed = sheetSelectionSchema.parse(input)
  return run(async () => {
    const { orgId } = await requireOrgContext()
    await selectProjectOption({ orgId, ...parsed })
    return { selectionId: parsed.selectionId }
  }, [`/design-studio/sheet/${parsed.projectId}`, `/projects/${parsed.projectId}/selections`])
}

export async function applyPackageAction(input: unknown) {
  const parsed = z.object({ projectId: z.string().uuid(), packageId: z.string().uuid() }).parse(input)
  return run(async () => {
    const { orgId } = await requireOrgContext()
    return selectProjectPackage({ orgId, ...parsed })
  }, [`/design-studio/sheet/${parsed.projectId}`, `/projects/${parsed.projectId}/selections`])
}

export async function confirmGroupAction(input: unknown) {
  const parsed = z.object({ projectId: z.string().uuid(), groupId: z.string().uuid() }).parse(input)
  return run(async () => {
    const context = await requireOrgContext()
    await requirePermission("design_studio.manage", context)
    return confirmSelectionGroup({ orgId: context.orgId, ...parsed })
  }, [`/design-studio/sheet/${parsed.projectId}`, `/projects/${parsed.projectId}/selections`, "/starts"])
}


export async function listOptionConfigurationRulesAction(optionId: string) {
  try { return { success: true as const, data: await listOptionConfigurationRules(optionId) } } catch (error) { return actionError(error) }
}
export async function searchConfigurationTargetsAction(input: unknown) {
  try { return { success: true as const, data: await searchConfigurationTargets(input) } } catch (error) { return actionError(error) }
}
export async function addOptionConfigurationRuleAction(input: unknown) {
  return run(() => addOptionConfigurationRule(input), ["/design-studio/catalog"])
}
export async function removeOptionConfigurationRuleAction(input: unknown) {
  return run(() => removeOptionConfigurationRule(input), ["/design-studio/catalog"])
}

export async function cancelCatalogPublicationAction(input: unknown) {
  return run(() => cancelCatalogPublication(input), ["/design-studio/catalog", "/design-studio/rules"])
}

export async function listCatalogPublicationHistoryAction(input: unknown) {
  return run(() => listCatalogPublicationHistory(input))
}

export async function recoverCatalogPublicationRequestAction(input: unknown) {
  return run(() => recoverCatalogPublicationRequest(input))
}

export async function listPendingCatalogPublicationsAction(input: unknown) {
  return run(() => listPendingCatalogPublications(input))
}

export async function listArchivedCatalogPackagesAction(input: unknown) {
  return run(() => listArchivedCatalogPackages(input))
}

export async function discoverCatalogPackageMembersAction(input: unknown) {
  return run(() => discoverCatalogPackageMembers(input))
}

export async function reviewCatalogGroupCategoriesAction(input: unknown) {
  return run(() => reviewCatalogGroupCategories(input))
}

export async function discoverCatalogGroupCategoriesAction(input: unknown) {
  return run(() => discoverCatalogGroupCategories(input))
}
