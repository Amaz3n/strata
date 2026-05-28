"use client"

import { useEffect } from "react"
import { usePageTitle } from "./page-title-context"

interface ProjectContextSetterProps {
  id: string
  name: string
}

export function ProjectContextSetter({ id, name }: ProjectContextSetterProps) {
  const { setProjectContext } = usePageTitle()
  useEffect(() => {
    setProjectContext({ id, name, href: `/projects/${id}` })
    return () => setProjectContext(null)
  }, [id, name, setProjectContext])
  return null
}
