"use server"

import { z } from "zod"

import { requireOrgMembership } from "@/lib/auth/context"
import { createPlatformSupportIssue } from "@/lib/services/platform-bugs"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const supportRequestSchema = z.object({
  topic: z.enum(["account", "billing", "project", "technical", "feedback", "other"]),
  message: z.string().trim().min(10, "Add a little more detail before sending.").max(4000),
  pageUrl: z.string().trim().max(500).optional(),
})

const TOPIC_LABELS: Record<z.infer<typeof supportRequestSchema>["topic"], string> = {
  account: "Account access",
  billing: "Billing",
  project: "Project/workflow help",
  technical: "Technical issue",
  feedback: "Product feedback",
  other: "Other",
}

export async function sendSupportRequestAction(input: z.input<typeof supportRequestSchema>) {
  const parsed = supportRequestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Unable to send support request.",
    }
  }

  const { user, orgId } = await requireOrgMembership()
  const service = createServiceSupabaseClient()
  const { data: org } = await service
    .from("orgs")
    .select("name, slug")
    .eq("id", orgId)
    .maybeSingle()

  const topicLabel = TOPIC_LABELS[parsed.data.topic]
  const requesterName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email ||
    "Unknown user"
  const requesterEmail = user.email ?? null
  const orgName = org?.name ?? "Unknown organization"
  const currentPage = parsed.data.pageUrl || "Not provided"

  try {
    const issue = await createPlatformSupportIssue({
      userId: user.id,
      orgId,
      orgName,
      requesterName,
      requesterEmail,
      topicKey: parsed.data.topic,
      topicLabel,
      message: parsed.data.message,
      pageUrl: currentPage,
    })

    return { success: true, issueKey: issue.issueKey }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "We couldn't create the support issue.",
    }
  }
}
