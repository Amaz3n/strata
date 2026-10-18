import type React from "react"
import { notFound, unstable_rethrow } from "next/navigation"
import { cacheLife } from "next/cache"
import { Suspense } from "react"

import { ProjectContextSetter } from "@/components/layout/project-context-setter"
import { getProjectIdentity, getProjectNavigationItemWithClient } from "@/lib/services/projects"

import { requireOrgContext } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"
import { getProjectLotContext } from "@/lib/services/lots"

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

// A fabricated project ID cannot pass authorization or data existence checks.
// Build the generic shell and validate project navigations in dev with real IDs.
export const instant = {
  unstable_disableBuildValidation: true,
}

async function loadProjectContext(id: string) {
  "use cache: private"
  cacheLife("session")

  const context = requireOrgContext()
  const [project, { productTier }, navigation] = await Promise.all([
    getProjectIdentity(id),
    context,
    context.then(({ supabase, orgId }) => getProjectNavigationItemWithClient(supabase, orgId, id)),
  ])
  if (!project || !navigation) return null
  const posture = getProjectPosture(project.property_type, productTier)
  const lotContext = posture === "production"
    ? await getProjectLotContext(project.id).catch((error) => {
        unstable_rethrow(error)
        return null
      })
    : null
  const lotLabel = lotContext
    ? `${lotContext.communityName} · Lot ${lotContext.block ? `${lotContext.block}-` : ""}${lotContext.lotNumber}`
    : undefined

  return {
    id: project.id,
    name: project.name,
    posture,
    contextLabel: lotLabel,
    contextHref: lotContext ? `/communities/${lotContext.communityId}` : undefined,
    navigation,
  }
}

async function ProjectContext({ params }: Pick<ProjectLayoutProps, "params">) {
  const { id } = await params
  const context = await loadProjectContext(id)
  if (!context) notFound()
  return <ProjectContextSetter {...context} />
}

export default function ProjectLayout({ children, params }: ProjectLayoutProps) {
  return (
    <>
      <Suspense fallback={null}>
        <ProjectContext params={params} />
      </Suspense>
      {children}
    </>
  )
}
