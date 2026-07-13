import { PageLayout } from "@/components/layout/page-layout"
import { getMeeting, listMeetings } from "@/lib/services/meetings"
import { MeetingsClient } from "./meetings-client"
import { listMeetingLinkOptions } from "@/lib/services/meeting-link-options"
import { listMeetingTranscripts } from "@/lib/services/meeting-transcripts"
import { notFound } from "next/navigation"

export default async function MeetingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ meeting?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const [meetings, selected, linkOptions] = await Promise.all([listMeetings(id), query.meeting ? getMeeting(query.meeting) : Promise.resolve(null), listMeetingLinkOptions(id)])
  if (selected && selected.project_id !== id) notFound()
  const transcripts = selected ? await listMeetingTranscripts(selected.id) : []
  return <PageLayout title="Meeting Minutes" breadcrumbs={[{ label: "Project" }, { label: "Meeting Minutes" }]}><MeetingsClient projectId={id} meetings={meetings} selected={selected} linkOptions={linkOptions} transcripts={transcripts} /></PageLayout>
}
