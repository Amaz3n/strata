"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { acceptInviteSchema } from "@/lib/validation/team"
import { getInviteDetailsByToken, acceptInviteByToken } from "@/lib/services/team"

export interface AcceptInviteState {
  error?: string
}

export async function acceptInviteAction(
  prevState: AcceptInviteState,
  formData: FormData
): Promise<AcceptInviteState> {
  const token = formData.get("token") as string

  if (!token) {
    return { error: "Invalid invitation link." }
  }

  const parsed = acceptInviteSchema.safeParse({
    fullName: formData.get("fullName"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  })

  if (!parsed.success) {
    const firstError = parsed.error.errors.at(0)?.message ?? "Please check the form fields."
    return { error: firstError }
  }

  try {
    const result = await acceptInviteByToken(token, parsed.data.password, parsed.data.fullName)

    if (!result) {
      return { error: "This invitation link has expired or is no longer valid." }
    }

    await setOrgCookie(result.orgId)
  } catch (error) {
    console.error("Failed to accept invite", error)
    return { error: error instanceof Error ? error.message : "Something went wrong. Please try again." }
  }

  redirect("/auth/signin?message=Account created successfully. Please sign in.")
}

export async function getInviteDetailsAction(token: string): Promise<{
  orgName: string
  email: string
} | null> {
  if (!token) {
    return null
  }

  const details = await getInviteDetailsByToken(token)
  if (!details) {
    return null
  }

  return {
    orgName: details.orgName,
    email: details.email,
  }
}

async function setOrgCookie(orgId: string) {
  const cookieStore = await cookies()
  if (typeof cookieStore.set === "function") {
    cookieStore.set({
      name: "org_id",
      value: orgId,
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    })
  }
}
