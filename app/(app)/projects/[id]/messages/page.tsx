import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { ProjectMessagesClient } from "./project-messages-client"
import { listPortalMessages } from "@/lib/services/portal-access"
import { getOrCreateProjectConversation } from "@/lib/services/conversations"

interface ProjectMessagesPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMessagesPage({ params }: ProjectMessagesPageProps) {
  const { id } = await params

  const [project, currentUser] = await Promise.all([
    getProjectAction(id),
  ])

  if (!project) {
    notFound()
  }

  // Get conversation IDs and load portal conversations for both client and sub portals
  const [clientConversation, subConversation] = await Promise.all([
    getOrCreateProjectConversation({ projectId: project.id, channel: "client", orgId: project.org_id }),
    getOrCreateProjectConversation({ projectId: project.id, channel: "sub", orgId: project.org_id }),
  ])

  const [clientMessages, subMessages] = await Promise.all([
    listPortalMessages({ orgId: project.org_id, projectId: project.id, channel: "client" }),
    listPortalMessages({ orgId: project.org_id, projectId: project.id, channel: "sub" }),
  ])

  return (
    <PageLayout
      title="Messages"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Messages" },
      ]}
    >
      <ProjectMessagesClient
        project={project}
        clientMessages={clientMessages}
        subMessages={subMessages}
        clientConversationId={clientConversation.id}
        subConversationId={subConversation.id}
      />
    </PageLayout>
  )
}
