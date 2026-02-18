"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import {
  clearPlatformOrgContext,
  endImpersonationSession,
  findUserByEmail,
  setPlatformOrgContext,
  startImpersonationSession,
} from "@/lib/services/platform-session"
import { provisionOrganization } from "@/lib/services/provisioning"
import { setPlatformOrganizationStatus } from "@/lib/services/platform-access"

const enterOrgContextSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  reason: z.string().max(300).optional(),
})

const startImpersonationSchema = z.object({
  targetEmail: z.string().email("Valid user email is required"),
  reason: z.string().min(8, "Reason must be at least 8 characters"),
  orgId: z.string().uuid().optional(),
  expiresInMinutes: z.coerce.number().min(5).max(240).optional(),
})

const provisionPlatformOrgSchema = z.object({
  orgName: z.string().min(2, "Organization name is required"),
  slug: z.string().min(2, "Slug is required"),
  billingModel: z.enum(["subscription", "license"]),
  planCode: z.string().optional(),
  fullName: z.string().min(2, "Primary contact name is required"),
  primaryEmail: z.string().email("Valid email is required"),
  trialDays: z.coerce.number().optional(),
})

const setOrganizationStatusSchema = z.object({
  orgId: z.string().uuid("Invalid organization id"),
  status: z.enum(["active", "archived"]),
  reason: z.string().max(300).optional(),
})

export async function enterOrgContextAction(formData: FormData) {
  const parsed = enterOrgContextSchema.safeParse({
    orgId: formData.get("orgId"),
    reason: formData.get("reason"),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors[0]?.message ?? "Invalid context request")
  }

  const { user } = await requireAuth()
  await requirePermission("platform.org.access", { userId: user.id })
  await setPlatformOrgContext(parsed.data.orgId, parsed.data.reason)

  revalidatePath("/")
  redirect("/")
}

export async function clearOrgContextAction() {
  const { user } = await requireAuth()
  await requirePermission("platform.org.access", { userId: user.id })
  await clearPlatformOrgContext()

  revalidatePath("/")
  redirect("/platform")
}

export async function startImpersonationAction(
  prevState: { error?: string; message?: string },
  formData: FormData,
) {
  const parsed = startImpersonationSchema.safeParse({
    targetEmail: formData.get("targetEmail"),
    reason: formData.get("reason"),
    orgId: formData.get("orgId") || undefined,
    expiresInMinutes: formData.get("expiresInMinutes") || undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid impersonation input" }
  }

  const { user } = await requireAuth()
  await requirePermission("impersonation.start", { userId: user.id })

  const target = await findUserByEmail(parsed.data.targetEmail)
  if (!target?.id) {
    return { error: "No user found for that email." }
  }

  if (target.id === user.id) {
    return { error: "You cannot impersonate your own account." }
  }

  try {
    await startImpersonationSession({
      targetUserId: target.id,
      orgId: parsed.data.orgId,
      reason: parsed.data.reason,
      expiresInMinutes: parsed.data.expiresInMinutes,
    })
  } catch (error: any) {
    return { error: error?.message ?? "Unable to start impersonation session." }
  }

  revalidatePath("/")
  revalidatePath("/platform")
  return {
    message: `Impersonation session started for ${target.full_name ?? target.email ?? target.id}.`,
  }
}

export async function endImpersonationAction() {
  const { user } = await requireAuth()
  await requirePermission("impersonation.end", { userId: user.id })
  await endImpersonationSession()

  revalidatePath("/")
  revalidatePath("/platform")
  redirect("/platform")
}

export async function provisionPlatformOrgAction(prevState: { error?: string; message?: string }, formData: FormData) {
  const parsed = provisionPlatformOrgSchema.safeParse({
    orgName: formData.get("orgName"),
    slug: formData.get("slug") ?? formData.get("orgSlug"),
    billingModel: formData.get("billingModel") ?? "subscription",
    planCode: formData.get("planCode"),
    fullName: formData.get("fullName"),
    primaryEmail: formData.get("primaryEmail"),
    trialDays: formData.get("trialDays"),
  })

  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Please check the form fields." }
  }

  const { user } = await requireAuth()
  await requireAnyPermission(["billing.manage", "platform.billing.manage"], { userId: user.id })

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
  } catch (error: any) {
    console.error("Failed to provision organization from platform", error)
    return { error: error?.message ?? "Failed to provision organization." }
  }

  revalidatePath("/platform")
  revalidatePath("/admin")
  return { message: "Organization provisioned successfully." }
}

export async function setOrganizationStatusAction(formData: FormData) {
  const parsed = setOrganizationStatusSchema.safeParse({
    orgId: formData.get("orgId"),
    status: formData.get("status"),
    reason: formData.get("reason"),
  })

  if (!parsed.success) {
    throw new Error(parsed.error.errors[0]?.message ?? "Invalid status update request.")
  }

  const { user } = await requireAuth()
  await requireAnyPermission(["platform.billing.manage", "platform.support.write"], { userId: user.id })

  await setPlatformOrganizationStatus({
    orgId: parsed.data.orgId,
    status: parsed.data.status,
    reason: parsed.data.reason,
    actorUserId: user.id,
  })

  revalidatePath("/platform")
  revalidatePath("/admin/customers")
  revalidatePath("/")
}
