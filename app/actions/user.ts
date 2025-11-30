"use server"

import { getCurrentUserProfile } from "@/lib/services/users"

export async function getCurrentUserAction() {
  return getCurrentUserProfile()
}
