"use client"

import { useCallback, useEffect, useState } from "react"
import { del, get, keys, set } from "idb-keyval"

export type OfflineSafetyDraftKind = "incident" | "observation" | "toolbox_talk"

export type OfflineSafetyDraft = {
  id: string
  projectId: string
  kind: OfflineSafetyDraftKind
  values: Record<string, unknown>
  evidence: Array<{ name: string; type: string; size: number }>
  createdAt: number
}

const PREFIX = "offline-safety-draft-v1-"

export function useOfflineSafetyDrafts(projectId: string) {
  const [drafts, setDrafts] = useState<OfflineSafetyDraft[]>([])
  const [isOnline, setIsOnline] = useState(true)

  const reload = useCallback(async () => {
    const stored = await Promise.all(
      (await keys())
        .filter((key): key is string => typeof key === "string" && key.startsWith(PREFIX))
        .map((key) => get<OfflineSafetyDraft>(key)),
    )
    setDrafts(
      stored
        .filter((draft): draft is OfflineSafetyDraft => draft?.projectId === projectId)
        .sort((a, b) => a.createdAt - b.createdAt),
    )
  }, [projectId])

  useEffect(() => {
    void reload()
    setIsOnline(navigator.onLine)
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener("online", online)
    window.addEventListener("offline", offline)
    return () => {
      window.removeEventListener("online", online)
      window.removeEventListener("offline", offline)
    }
  }, [reload])

  const saveDraft = useCallback(async (
    kind: OfflineSafetyDraftKind,
    values: Record<string, unknown>,
    files: File[] = [],
  ) => {
    const id = `${PREFIX}${crypto.randomUUID()}`
    const draft: OfflineSafetyDraft = {
      id,
      projectId,
      kind,
      values,
      // Binary evidence is deliberately not persisted or retried. A partially
      // acknowledged upload cannot be made idempotent with the current file API.
      evidence: files.filter((file) => file.size > 0).map((file) => ({ name: file.name, type: file.type, size: file.size })),
      createdAt: Date.now(),
    }
    await set(id, draft)
    setDrafts((current) => [...current, draft])
    return draft
  }, [projectId])

  const discardDraft = useCallback(async (id: string) => {
    await del(id)
    setDrafts((current) => current.filter((draft) => draft.id !== id))
  }, [])

  return { drafts, isOnline, saveDraft, discardDraft }
}
