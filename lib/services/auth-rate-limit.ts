import "server-only"

import { headers } from "next/headers"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Defense-in-depth throttle for unauthenticated auth surfaces: account lookup,
 * first-password-setup sends, PIN checks and portal account sign-in. Per-record
 * lockouts already exist; this bounds the attacker who rotates the record
 * (probing many emails, or many tokens in parallel) from one source.
 *
 * Backed by a table rather than memory because serverless instances do not
 * share process state.
 */

export type RateLimitAction =
  | "external_signin"
  | "external_claim"
  | "external_reset_request"
  | "portal_pin"
  | "account_lookup"
  | "password_setup"

interface RateLimitRule {
  limit: number
  windowSeconds: number
}

const RULES: Record<RateLimitAction, RateLimitRule> = {
  external_signin: { limit: 10, windowSeconds: 15 * 60 },
  external_claim: { limit: 10, windowSeconds: 15 * 60 },
  external_reset_request: { limit: 5, windowSeconds: 60 * 60 },
  portal_pin: { limit: 20, windowSeconds: 15 * 60 },
  account_lookup: { limit: 20, windowSeconds: 15 * 60 },
  password_setup: { limit: 5, windowSeconds: 60 * 60 },
}

export class RateLimitError extends Error {
  constructor(message = "Too many attempts. Try again in a few minutes.") {
    super(message)
    this.name = "RateLimitError"
  }
}

async function requestIdentifier(): Promise<string> {
  const headerList = await headers()
  const forwarded = headerList.get("x-forwarded-for")
  const ip = forwarded?.split(",")[0]?.trim() || headerList.get("x-real-ip")?.trim()
  return ip || "unknown"
}

/**
 * Records one attempt and throws when the caller is over budget. Never blocks
 * the request on infrastructure failure — a throttle that takes the login page
 * down with it is worse than the attack it prevents.
 */
export async function enforceAuthRateLimit(action: RateLimitAction, scope?: string): Promise<void> {
  const rule = RULES[action]
  const identifier = `${await requestIdentifier()}:${scope ?? "global"}`
  const windowStart = new Date(Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000).toISOString()

  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("increment_auth_rate_limit", {
    action_input: action,
    identifier_input: identifier,
    window_start_input: windowStart,
  })

  if (error) {
    console.error("Auth rate limit check failed", error)
    return
  }

  if (typeof data === "number" && data > rule.limit) {
    throw new RateLimitError()
  }
}
