"use server"

import { z } from "zod"

import { requireOrgMembership } from "@/lib/auth/context"
import { sendEmail } from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const SUPPORT_RECIPIENTS = ["agustin@arcnaples.com", "gabi@arcnaples.com"]

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
    .select("name")
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

  const rows = [
    ["Topic", topicLabel],
    ["Organization", `${orgName} (${orgId})`],
    ["Requester", `${requesterName}${requesterEmail ? ` <${requesterEmail}>` : ""}`],
    ["Page", currentPage],
  ]

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="margin:0 0 16px;font-size:18px">New Arc support request</h2>
      <table style="border-collapse:collapse;margin-bottom:20px">
        <tbody>
          ${rows
            .map(
              ([label, value]) => `
                <tr>
                  <td style="padding:4px 16px 4px 0;color:#6b7280;font-size:13px">${escapeHtml(label)}</td>
                  <td style="padding:4px 0;font-size:13px">${escapeHtml(value)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
      <div style="white-space:pre-wrap;border-left:3px solid #111827;padding-left:12px">${escapeHtml(parsed.data.message)}</div>
    </div>
  `

  const sent = await sendEmail({
    to: SUPPORT_RECIPIENTS,
    subject: `[Arc Support] ${topicLabel} - ${orgName}`,
    html,
    text: [
      "New Arc support request",
      `Topic: ${topicLabel}`,
      `Organization: ${orgName} (${orgId})`,
      `Requester: ${requesterName}${requesterEmail ? ` <${requesterEmail}>` : ""}`,
      `Page: ${currentPage}`,
      "",
      parsed.data.message,
    ].join("\n"),
    replyTo: requesterEmail,
  })

  if (!sent) {
    return {
      success: false,
      error: "We couldn't send the message. Please email agustin@arcnaples.com or gabi@arcnaples.com.",
    }
  }

  return { success: true }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
