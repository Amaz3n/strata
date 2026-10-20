import { guardProjectTab } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getMeeting, listMeetings } from "@/lib/services/meetings"
import { MeetingsClient } from "./meetings-client"
import { listMeetingLinkOptions } from "@/lib/services/meeting-link-options"
import { listMeetingTranscripts } from "@/lib/services/meeting-transcripts"
import { notFound } from "next/navigation"

async function MeetingsPageContent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ meeting?: string }> }) {
  await connection()
  const [{ id }, query] = await Promise.all([params, searchParams])
  await guardProjectTab(id, "meetings")
  const selectedPromise = query.meeting ? getMeeting(query.meeting).then((meeting) => {
    if (meeting && meeting.project_id !== id) notFound()
    return meeting
  }) : Promise.resolve(null)
  const transcriptsPromise = selectedPromise.then((meeting) => meeting ? listMeetingTranscripts(meeting.id) : [])
  const [meetings, selected, linkOptions, transcripts] = await Promise.all([
    listMeetings(id), selectedPromise, listMeetingLinkOptions(id), transcriptsPromise,
  ])
  return <PageLayout title="Meeting Minutes" breadcrumbs={[{ label: "Project" }, { label: "Meeting Minutes" }]}><MeetingsClient projectId={id} meetings={meetings} selected={selected} linkOptions={linkOptions} transcripts={transcripts} /></PageLayout>
}

export default function MeetingsPage(props: Parameters<typeof MeetingsPageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Meeting Minutes">
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <MeetingsPageContent {...props} />
    </Suspense>
  )
}
