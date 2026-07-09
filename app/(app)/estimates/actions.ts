"use server"

import { revalidatePath } from "next/cache"

import { randomUUID } from "crypto"

import type { Estimate } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"
import { buildOrgScopedPath, createFilesDownloadUrl, uploadFilesObject } from "@/lib/storage/files-storage"
import {
  createEstimate,
  createEstimateVersion,
  duplicateEstimate,
  reviseEstimate,
  updateEstimateStatus,
} from "@/lib/services/estimates"
import {
  sendEstimate,
  getEstimateShareLink,
  getEstimateBuilderSigningLink,
  addBuilderEstimateComment,
  countersignEstimate,
  listEstimateComments,
} from "@/lib/services/estimate-portal"
import { estimateInputSchema } from "@/lib/validation/estimates"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listEstimatesAction(): Promise<Array<Estimate & { recipient_name?: string | null }>> {
      const { supabase, orgId } = await requireOrgContext()

      const { data, error } = await supabase
        .from("estimates")
        .select("*, recipient:contacts(id, full_name)")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })

      if (error) {
        console.error("Failed to list estimates", error.message)
        return []
      }

      return (data ?? []).map((row: any) => ({
        ...(row as Estimate),
        recipient_name: row.recipient?.full_name ?? null,
      }))
}

export async function createEstimateAction(input: unknown) {
  return run(async () => {
      const parsed = estimateInputSchema.parse(input)
      const { estimate } = await createEstimate({
        ...parsed,
        project_id: parsed.project_id ?? null,
        prospect_id: parsed.prospect_id ?? null,
        recipient_contact_id: parsed.recipient_contact_id ?? null,
        lines: parsed.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })),
      })
      revalidatePath("/estimates")
      return estimate
  })
}

const PHOTO_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

/**
 * Uploads a single estimate gallery photo to org-scoped R2 storage and returns
 * its storage path plus a short-lived preview URL for the builder's sheet.
 */
export async function uploadEstimatePhotoAction(formData: FormData) {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()

      const raw = formData.get("photo")
      const file = raw instanceof File ? raw : null
      if (!file) return { error: "Choose an image to upload." }

      const ext = PHOTO_MIME_EXT[file.type]
      if (!ext) return { error: "Use PNG, JPG, WEBP, or GIF." }
      if (file.size > 15 * 1024 * 1024) return { error: "Images must be 15MB or smaller." }

      const path = buildOrgScopedPath(orgId, "estimates", "photos", `${randomUUID()}.${ext}`)
      const bytes = Buffer.from(await file.arrayBuffer())

      try {
        await uploadFilesObject({ supabase, orgId, path, bytes, contentType: file.type, cacheControl: "private, max-age=31536000" })
        const { downloadUrl } = await createFilesDownloadUrl({ supabase, orgId, path, expiresIn: 3600 })
        return { path, url: downloadUrl }
      } catch (error: any) {
        console.error("Failed to upload estimate photo", error)
        return { error: error?.message ?? "Failed to upload image." }
      }
  })
}

export async function listEstimateTemplatesAction() {
      const { supabase, orgId } = await requireOrgContext()
      const { data, error } = await supabase
        .from("estimate_templates")
        .select("id, org_id, name, description, lines, is_default, created_at, updated_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })

      if (error) {
        console.error("Failed to list estimate templates", error.message)
        return []
      }

      return data ?? []
}

export async function duplicateEstimateAction(estimateId: string) {
  return run(async () => {
      const estimate = await duplicateEstimate({ estimateId })
      revalidatePath("/estimates")
      return estimate
  })
}

export async function updateEstimateStatusAction(estimateId: string, status: "draft" | "sent" | "approved" | "rejected") {
  return run(async () => {
      const estimate = await updateEstimateStatus({ estimateId, status })
      revalidatePath("/estimates")
      return estimate
  })
}


export async function sendEstimateAction(estimateId: string, message?: string) {
  return run(async () => {
      const result = await sendEstimate({ estimateId, message })
      revalidatePath("/estimates")
      return result
  })
}

export async function getEstimateShareLinkAction(estimateId: string) {
      return getEstimateShareLink({ estimateId })
}

export async function getEstimateBuilderSigningLinkAction(estimateId: string) {
      return getEstimateBuilderSigningLink({ estimateId })
}

export async function reviseEstimateAction(estimateId: string) {
  return run(async () => {
      const estimate = await reviseEstimate({ estimateId })
      revalidatePath("/estimates")
      return estimate
  })
}

export async function createEstimateVersionAction(estimateId: string, input: unknown) {
  return run(async () => {
      const parsed = estimateInputSchema.parse(input)
      const estimate = await createEstimateVersion({
        estimateId,
        input: {
          ...parsed,
          lines: parsed.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })),
        },
      })
      revalidatePath("/estimates")
      revalidatePath("/pipeline")
      return estimate
  })
}

/** Loads an estimate plus its line items so the builder can revise it in the estimate sheet. */
export async function getEstimateForEditAction(estimateId: string) {
      const { supabase, orgId } = await requireOrgContext()
      const { data, error } = await supabase
        .from("estimates")
        .select("*, items:estimate_items(*), recipient:contacts(id, full_name, email)")
        .eq("org_id", orgId)
        .eq("id", estimateId)
        .maybeSingle()

      if (error || !data) {
        throw new Error(`Estimate not found: ${error?.message ?? "missing"}`)
      }

      const metadata = (data.metadata as Record<string, any> | null) ?? {}
      const adHocRecipient = (metadata.recipient as { name?: string | null; email?: string | null } | null) ?? null
      const items = [...((data.items as any[]) ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      // Resolve photo storage paths to short-lived preview URLs for the revise sheet.
      const rawPhotos = Array.isArray(metadata.photos) ? (metadata.photos as any[]) : []
      const photos = (
        await Promise.all(
          rawPhotos.map(async (photo) => {
            const path = typeof photo?.path === "string" ? photo.path : null
            if (!path) return null
            try {
              const { downloadUrl } = await createFilesDownloadUrl({ supabase, orgId, path, expiresIn: 3600 })
              return { path, url: downloadUrl, caption: typeof photo.caption === "string" ? photo.caption : null }
            } catch {
              return { path, url: null, caption: typeof photo.caption === "string" ? photo.caption : null }
            }
          }),
        )
      ).filter((p): p is { path: string; url: string | null; caption: string | null } => p !== null)

      const pricingRaw = metadata.display?.pricing
      const pricing_display =
        pricingRaw === "subtotals" || pricingRaw === "lump_sum" ? pricingRaw : "itemized"

      return {
        id: data.id as string,
        title: (data.title as string) ?? "",
        version: (data.version as number) ?? 1,
        summary: typeof metadata.summary === "string" ? metadata.summary : "",
        terms: typeof metadata.terms === "string" ? metadata.terms : "",
        intro: typeof metadata.intro === "string" ? metadata.intro : "",
        pricing_display: pricing_display as "itemized" | "subtotals" | "lump_sum",
        photos,
        valid_until: (data.valid_until as string | null) ?? null,
        decision_note: (data.decision_note as string | null) ?? null,
        recipient_contact_id: (data.recipient_contact_id as string | null) ?? null,
        recipient_name: (data.recipient as any)?.full_name ?? adHocRecipient?.name ?? null,
        recipient_email: (data.recipient as any)?.email ?? adHocRecipient?.email ?? null,
        lines: items.map((item: any) => ({
          description: (item.description as string) ?? "",
          quantity: (item.quantity as number) ?? 1,
          unit_cost_cents: (item.unit_cost_cents as number) ?? 0,
          cost_code_id: (item.cost_code_id as string | null) ?? null,
          item_type: (item.item_type === "group" ? "group" : "line") as "line" | "group",
          is_optional: item.metadata?.is_optional === true,
          is_allowance: item.metadata?.is_allowance === true,
        })),
      }
}

export async function listEstimateCommentsAction(estimateId: string) {
      return listEstimateComments(estimateId)
}

export async function addEstimateCommentAction(estimateId: string, body: string) {
  return run(async () => {
      await addBuilderEstimateComment({ estimateId, body })
      revalidatePath("/estimates")
  })
}

export async function countersignEstimateAction(estimateId: string, signerName?: string) {
      const result = await countersignEstimate({ estimateId, signerName })
      revalidatePath("/estimates")
      revalidatePath("/pipeline")
      if (result.signatureDocumentId) {
        revalidatePath("/signatures")
      }
      return result
}
