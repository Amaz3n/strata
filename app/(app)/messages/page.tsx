import { PageLayout } from "@/components/layout/page-layout"
import { listConversationMessages, listOrgConversationsForInbox } from "@/lib/services/conversations"
import { listProjects } from "@/lib/services/projects"
import { MessagesInboxClient } from "./messages-inbox-client"

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function resolveConversationId(params: Record<string, string | string[] | undefined>) {
  const conversationId = params.conversationId
  if (typeof conversationId === "string" && conversationId.trim().length > 0) {
    return conversationId
  }
  return undefined
}

export default async function MessagesPage({ searchParams }: { searchParams: SearchParams }) {
  const resolvedSearchParams = await searchParams
  const requestedConversationId = resolveConversationId(resolvedSearchParams)
  const [conversations, projects] = await Promise.all([
    listOrgConversationsForInbox(),
    listProjects(),
  ])
  const initialConversationId =
    conversations.find((conversation) => conversation.id === requestedConversationId)?.id ??
    conversations[0]?.id ??
    null
  const initialMessages = initialConversationId ? await listConversationMessages(initialConversationId) : []

  return (
    <PageLayout title="Messages">
      <div className="-mt-2 flex min-h-0 flex-1 min-w-0 w-full">
        <MessagesInboxClient
          conversations={conversations}
          initialConversationId={initialConversationId}
          initialMessages={initialMessages}
          projects={projects}
        />
      </div>
    </PageLayout>
  )
}
