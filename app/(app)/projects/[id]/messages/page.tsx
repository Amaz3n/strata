import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { ProjectMessagesClient } from "./project-messages-client"
import {
  listProjectConversations,
  listProjectSubcontractorCompanies,
  listConversationMessagesWithClient,
  getOrCreateClientConversation,
  getUnreadCountsForProject,
} from "@/lib/services/conversations"
import { createServerSupabaseClient } from "@/lib/supabase/server"

interface ProjectMessagesPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMessagesPage({ params }: ProjectMessagesPageProps) {
  const { id } = await params

  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const supabase = await createServerSupabaseClient()

  // Ensure client conversation exists
  await getOrCreateClientConversation({ projectId: project.id, orgId: project.org_id })

  // Load all conversations, subcontractor companies, and unread counts
  const [conversations, subCompanies, unreadCounts] = await Promise.all([
    listProjectConversations({ projectId: project.id, orgId: project.org_id }),
    listProjectSubcontractorCompanies({ projectId: project.id, orgId: project.org_id }),
    getUnreadCountsForProject({ projectId: project.id, orgId: project.org_id }),
  ])

  // Convert unread counts map to object for serialization
  const unreadCountsObj: Record<string, number> = {}
  unreadCounts.forEach((count, conversationId) => {
    unreadCountsObj[conversationId] = count
  })

  // Load messages for the first conversation (if any)
  let initialMessages: Awaited<ReturnType<typeof listConversationMessagesWithClient>> = []
  let initialConversationId: string | null = null

  if (conversations.length > 0) {
    initialConversationId = conversations[0].id
    initialMessages = await listConversationMessagesWithClient(supabase, project.org_id, initialConversationId)
  }

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
        conversations={conversations}
        subCompanies={subCompanies}
        initialMessages={initialMessages}
        initialConversationId={initialConversationId}
        unreadCounts={unreadCountsObj}
      />
    </PageLayout>
  )
}
