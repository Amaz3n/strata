"use client"

import { useEffect, useMemo, useState } from "react"

import { createClient } from "@/lib/supabase/client"

function readOrgCookie() {
  if (typeof document === "undefined") return undefined
  const match = document.cookie.match(/(?:^|; )org_id=([^;]+)/)
  return match?.[1]
}

export function usePermissions(orgId?: string) {
  const [permissions, setPermissions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const supabase = createClient()

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!user) {
          if (active) {
            setPermissions([])
            setLoading(false)
          }
          return
        }

        let targetOrg = orgId ?? readOrgCookie()

        let query = supabase
          .from("memberships")
          .select("org_id, role:roles!inner(permissions:role_permissions(permission_key))")
          .eq("user_id", user.id)
          .eq("status", "active")
          .order("created_at", { ascending: true })
          .limit(1)

        if (targetOrg) {
          query = query.eq("org_id", targetOrg)
        }

        const { data, error: permError } = await query
        if (permError) {
          throw permError
        }

        const row = Array.isArray(data) ? data[0] : (data as any)
        const perms: string[] = row?.role?.permissions?.map((p: any) => p.permission_key) ?? []

        if (active) {
          setPermissions(perms)
          setLoading(false)
        }
      } catch (err) {
        console.error("Unable to load permissions", err)
        if (active) {
          setError((err as Error).message)
          setPermissions([])
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      active = false
    }
  }, [orgId])

  const hasPermission = useMemo(
    () => (permission: string) => permissions.includes(permission),
    [permissions],
  )

  return { permissions, loading, error, hasPermission }
}




