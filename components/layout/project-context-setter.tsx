"use client"

import { useEffect } from "react"
import { usePageTitle } from "./page-title-context"
import type { ProjectPosture } from "@/lib/product-tier"

interface ProjectContextSetterProps {
  id: string
  name: string
  posture: ProjectPosture
}

export function ProjectContextSetter({ id, name, posture }: ProjectContextSetterProps) {
  const { setProjectContext } = usePageTitle()
  useEffect(() => {
    setProjectContext({ id, name, href: `/projects/${id}`, posture })
    return () => setProjectContext(null)
  }, [id, name, posture, setProjectContext])
  return null
}
