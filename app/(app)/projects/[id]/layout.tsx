import type React from "react"
import { notFound } from "next/navigation"

import { ProjectContextSetter } from "@/components/layout/project-context-setter"
import { getProjectAction } from "./actions"

import { unwrapAction } from "@/lib/action-result"

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  return (
    <>
      <ProjectContextSetter id={project.id} name={project.name} />
      {children}
    </>
  )
}
