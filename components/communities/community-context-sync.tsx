"use client"

import { useEffect } from "react"

import { setCommunityContextAction } from "@/app/(app)/desk-context-actions"

export function CommunityContextSync({ communityId }: { communityId: string }) {
  useEffect(() => {
    void setCommunityContextAction(communityId)
  }, [communityId])
  return null
}
