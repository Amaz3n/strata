"use server"

import { z } from "zod"

import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import {
  createReleaseNote,
  deleteReleaseNote,
  updateReleaseNote,
  type ReleaseNoteInput,
} from "@/lib/services/release-notes"

const categorySchema = z.enum(["new", "improved", "fixed", "admin", "mobile"])
const visibilitySchema = z.enum(["quiet", "badge", "announce"])

const releaseNoteSchema = z.object({
  slug: z.string().trim().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(3).max(140),
  summary: z.string().trim().min(10).max(500),
  body: z.string().trim().max(2000).optional().nullable(),
  category: categorySchema,
  visibility: visibilitySchema,
  href: z.string().trim().max(300).optional().nullable(),
  ctaLabel: z.string().trim().max(80).optional().nullable(),
  orgId: z.string().uuid().optional().nullable(),
  audienceRoles: z.array(z.string().trim().min(1)).default([]),
  audiencePermissions: z.array(z.string().trim().min(1)).default([]),
  audienceFeatures: z.array(z.string().trim().min(1)).default([]),
  isPublished: z.boolean(),
  publishedAt: z.string().optional().nullable(),
  expiresAt: z.string().optional().nullable(),
})

async function requireReleaseNotesAdmin() {
  await requireAnyPermissionGuard([
    "platform.feature_flags.manage",
    "features.manage",
  ])
}

function parseInput(input: unknown): ReleaseNoteInput {
  const parsed = releaseNoteSchema.parse(input)
  return {
    ...parsed,
    href: parsed.href || null,
    ctaLabel: parsed.ctaLabel || null,
    orgId: parsed.orgId || null,
    publishedAt: parsed.publishedAt || null,
    expiresAt: parsed.expiresAt || null,
  }
}

export async function createReleaseNoteAction(input: unknown) {
  await requireReleaseNotesAdmin()
  return createReleaseNote(parseInput(input))
}

export async function updateReleaseNoteAction(id: string, input: unknown) {
  await requireReleaseNotesAdmin()
  return updateReleaseNote(id, parseInput(input))
}

export async function deleteReleaseNoteAction(id: string) {
  await requireReleaseNotesAdmin()
  await deleteReleaseNote(z.string().uuid().parse(id))
  return { success: true }
}
