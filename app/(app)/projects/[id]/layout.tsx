import type React from "react"
import { notFound } from "next/navigation"

import { ProjectContextSetter } from "@/components/layout/project-context-setter"
import { getProjectAction } from "./actions"

import { unwrapAction } from "@/lib/action-result"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"
import { getProjectLotContext } from "@/lib/services/lots"

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
  const lotContext = posture === "production" ? await getProjectLotContext(project.id).catch(() => null) : null
  const lotLabel = lotContext
    ? `${lotContext.communityName} · Lot ${lotContext.block ? `${lotContext.block}-` : ""}${lotContext.lotNumber}`
    : undefined

  return (
    <>
      <ProjectContextSetter
        id={project.id}
        name={project.name}
        posture={posture}
        contextLabel={lotLabel}
        contextHref={lotContext ? `/communities/${lotContext.communityId}` : undefined}
      />
      {children}
    </>
  )
}
