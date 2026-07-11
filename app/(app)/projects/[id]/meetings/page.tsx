import { PageLayout } from "@/components/layout/page-layout"
import { getMeeting, listMeetings } from "@/lib/services/meetings"
import { MeetingsClient } from "./meetings-client"

export default async function MeetingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ meeting?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const [meetings, selected] = await Promise.all([listMeetings(id), query.meeting ? getMeeting(query.meeting) : Promise.resolve(null)])
  return <PageLayout title="Meeting Minutes" breadcrumbs={[{ label: "Project" }, { label: "Meeting Minutes" }]}><MeetingsClient projectId={id} meetings={meetings} selected={selected} /></PageLayout>
}

