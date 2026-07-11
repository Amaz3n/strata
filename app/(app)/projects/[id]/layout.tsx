import type React from "react"
import { notFound } from "next/navigation"

import { ProjectContextSetter } from "@/components/layout/project-context-setter"
import { getProjectAction } from "./actions"

import { unwrapAction } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { id } = await params
  const [project, { productTier }] = await Promise.all([
    getProjectAction(id),
    requireOrgContext(),
  ])
  if (!project) notFound()
  const posture = getProjectPosture(project.property_type, productTier)

  return (
    <>
      <ProjectContextSetter id={project.id} name={project.name} posture={posture} />
      {children}
    </>
  )
}
