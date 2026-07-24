import { PageLayout } from "@/components/layout/page-layout"
import { DesignStudioClient } from "@/components/design-studio/design-studio-client"
import { listCommunities } from "@/lib/services/communities"
import { getCoordinatorDesk, listCatalog, listSelectionGroups } from "@/lib/services/option-catalog"
import { listProjects } from "@/lib/services/projects"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ community?: string }>
}

export default async function DesignStudioPage({ searchParams }: PageProps) {
  const { community } = await searchParams
  const ambient = await getAmbientDeskContext()
  const communityId = community || ambient.communityId
  const [catalog, groups, desk, communities, projects] = await Promise.all([
    listCatalog({ communityId }),
    listSelectionGroups({ communityId }),
    getCoordinatorDesk({ communityId, divisionId: ambient.divisionId }),
    listCommunities(ambient.divisionId ? { divisionId: ambient.divisionId } : {}),
    listProjects(),
  ])

  return (
    <PageLayout title="Design Studio" fullBleed>
      <DesignStudioClient
        communityId={communityId}
        communities={communities.map((item) => ({ id: item.id, name: item.name }))}
        catalog={catalog}
        groups={groups}
        desk={desk}
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
      />
    </PageLayout>
  )
}
