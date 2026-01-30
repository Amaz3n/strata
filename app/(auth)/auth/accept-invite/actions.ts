"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { acceptInviteSchema } from "@/lib/validation/team"
import { getInviteDetailsByToken, acceptInviteByToken } from "@/lib/services/team"
import { createServerSupabaseClient } from "@/lib/supabase/server"

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

  // Get invite details first to have the email for auto-login
  const inviteDetails = await getInviteDetailsByToken(token)
  if (!inviteDetails) {
    return { error: "This invitation link has expired or is no longer valid." }
  }

  try {
    const result = await acceptInviteByToken(token, parsed.data.password, parsed.data.fullName)

    if (!result) {
      return { error: "This invitation link has expired or is no longer valid." }
    }

    // Auto-login the user with their new credentials
    const supabase = await createServerSupabaseClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: inviteDetails.email,
      password: parsed.data.password,
    })

    if (signInError) {
      // If auto-login fails, fall back to manual login
      console.error("Auto-login failed after invite acceptance", signInError)
      await setOrgCookie(result.orgId)
      redirect("/auth/signin?message=Account created successfully. Please sign in.")
    }

    await setOrgCookie(result.orgId)
  } catch (error) {
    console.error("Failed to accept invite", error)
    return { error: error instanceof Error ? error.message : "Something went wrong. Please try again." }
  }

  // Redirect to dashboard after successful auto-login
  redirect("/")
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
