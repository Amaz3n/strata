"use client"

import { useEffect } from "react"
import { usePageTitle } from "./page-title-context"
import type { ProjectPosture } from "@/lib/product-tier"

interface ProjectContextSetterProps {
  id: string
  name: string
  posture: ProjectPosture
  contextLabel?: string
  contextHref?: string
}

export function ProjectContextSetter({ id, name, posture, contextLabel, contextHref }: ProjectContextSetterProps) {
  const { setProjectContext } = usePageTitle()
  useEffect(() => {
    setProjectContext({ id, name, href: `/projects/${id}`, posture, contextLabel, contextHref })
    return () => setProjectContext(null)
  }, [contextHref, contextLabel, id, name, posture, setProjectContext])
  return null
}
