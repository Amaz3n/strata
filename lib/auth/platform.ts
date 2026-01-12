import type { User } from "@supabase/supabase-js"

function parseList(value?: string | null) {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

export function isPlatformAdminUser(user?: User | null) {
  if (!user) return false
  return isPlatformAdminId(user.id, user.email ?? undefined)
}

export function isPlatformAdminId(userId?: string | null, email?: string | null) {
  if (!userId && !email) return false
  const ids = parseList(process.env.SUPERADMIN_IDS)
  const emails = parseList(process.env.SUPERADMIN_EMAILS)

  if (userId && ids.includes(userId)) return true
  if (email && emails.includes(email.toLowerCase())) return true
  return false
}








