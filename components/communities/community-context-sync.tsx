"use client"

import { useEffect } from "react"

import { setDeskScopeAction } from "@/app/(app)/desk-context-actions"

export function CommunityContextSync({ communityId }: { communityId: string }) {
  useEffect(() => {
    void setDeskScopeAction({ communityId })
  }, [communityId])
  return null
}
