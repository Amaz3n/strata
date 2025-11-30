import type { User } from "@/lib/types"
import { getAuthContext } from "@/lib/auth/context"

export async function getCurrentUserProfile(): Promise<User | null> {
  const { supabase, user } = await getAuthContext()

  if (!user) {
    return null
  }

  const { data, error } = await supabase
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle()

  if (error) {
    console.error("Failed to load user profile", error)
    return null
  }

  if (!data) {
    return {
      id: user.id,
      email: user.email ?? "",
      full_name: user.user_metadata?.full_name ?? user.email ?? "User",
      avatar_url: user.user_metadata?.avatar_url ?? undefined,
    }
  }

  return {
    id: data.id,
    email: data.email ?? user.email ?? "",
    full_name: data.full_name ?? user.user_metadata?.full_name ?? data.email,
    avatar_url: data.avatar_url ?? undefined,
  }
}
