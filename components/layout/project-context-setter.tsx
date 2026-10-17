"use client"

import { useEffect } from "react"
import { usePageTitle } from "./page-title-context"
import type { ProjectPosture } from "@/lib/product-tier"
import type { ProjectNavigationItem } from "@/lib/types"

interface ProjectContextSetterProps {
  id: string
  name: string
  posture: ProjectPosture
  contextLabel?: string
  contextHref?: string
  navigation: ProjectNavigationItem
}

export function ProjectContextSetter({ id, name, posture, contextLabel, contextHref, navigation }: ProjectContextSetterProps) {
  const { setProjectContext } = usePageTitle()
  useEffect(() => {
    setProjectContext({ id, name, href: `/projects/${id}`, posture, contextLabel, contextHref, navigation })
    return () => setProjectContext(null)
  }, [contextHref, contextLabel, id, name, posture, navigation, setProjectContext])
  return null
}
