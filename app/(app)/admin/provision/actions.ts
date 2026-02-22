"use server"

import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { provisionOrganization } from "@/lib/services/provisioning"
import { requireAnyPermission } from "@/lib/services/permissions"

const provisionSchema = z.object({
  orgName: z.string().min(2, "Organization name is required"),
  slug: z.string().min(2, "Slug is required"),
  billingModel: z.enum(["subscription", "license"]),
  planCode: z.string().optional(),
  fullName: z.string().min(2, "Primary contact name is required"),
  primaryEmail: z.string().email("Valid email is required"),
  trialDays: z.coerce.number().optional(),
})

export async function provisionOrgAction(_prevState: { error?: string; message?: string }, formData: FormData) {
  const parsed = provisionSchema.safeParse({
    orgName: formData.get("orgName"),
    slug: formData.get("slug") ?? formData.get("orgSlug"),
    billingModel: formData.get("billingModel") ?? "subscription",
    planCode: formData.get("planCode"),
    fullName: formData.get("fullName"),
    primaryEmail: formData.get("primaryEmail"),
    trialDays: formData.get("trialDays"),
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  const { user } = await requireAuth()
  try {
    await requireAnyPermission(["billing.manage", "platform.billing.manage"], { userId: user.id })
  } catch {
    return { error: "You do not have access to provision organizations." }
  }

  try {
    await provisionOrganization({
      name: parsed.data.orgName,
      slug: parsed.data.slug,
      billingModel: parsed.data.billingModel,
      planCode: parsed.data.planCode,
      primaryEmail: parsed.data.primaryEmail,
      primaryName: parsed.data.fullName,
      trialDays: parsed.data.trialDays,
      createdBy: user.id,
    })

    return { message: "Organization provisioned successfully." }
  } catch (error: any) {
    console.error("Failed to provision organization:", error)
    return { error: error?.message ?? "Failed to provision organization." }
  }
}
