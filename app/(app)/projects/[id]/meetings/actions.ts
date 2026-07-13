"use server"

import { revalidatePath } from "next/cache"
import { actionError, type ActionResult } from "@/lib/action-result"
import { addMeetingAttendee, addMeetingItem, createNextMeeting, createTaskFromMeetingItem, deleteMeeting, finalizeMeeting, updateMeeting, updateMeetingAttendee, updateMeetingItem } from "@/lib/services/meetings"
import { createMeetingItemTaskSchema, createMeetingSchema, meetingAttendeeSchema, meetingItemSchema, updateMeetingAttendeeSchema, updateMeetingItemSchema, updateMeetingSchema } from "@/lib/validation/meetings"
import { createAudioMeetingTranscript, createPastedMeetingTranscript, draftMinutesFromTranscript, reviewMeetingDraftProposal } from "@/lib/services/meeting-transcripts"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { success: true, data: await fn() } } catch (error) { return actionError(error) }
}

export async function createMeetingAction(input: unknown) {
  return run(async () => {
    const parsed = createMeetingSchema.parse(input)
    const meeting = await createNextMeeting(parsed)
    revalidatePath(`/projects/${parsed.project_id}/meetings`)
    return meeting
  })
}

export async function addMeetingItemAction(projectId: string, input: unknown) {
  return run(async () => {
    const item = await addMeetingItem(meetingItemSchema.parse(input))
    revalidatePath(`/projects/${projectId}/meetings`)
    return item
  })
}

export async function updateMeetingItemAction(projectId: string, itemId: string, input: unknown) {
  return run(async () => {
    const item = await updateMeetingItem(itemId, updateMeetingItemSchema.parse(input))
    revalidatePath(`/projects/${projectId}/meetings`)
    return item
  })
}

export async function updateMeetingAction(projectId: string, meetingId: string, input: unknown) {
  return run(async () => {
    const meeting = await updateMeeting(meetingId, updateMeetingSchema.parse(input))
    revalidatePath(`/projects/${projectId}/meetings`)
    return meeting
  })
}

export async function deleteMeetingAction(projectId: string, meetingId: string) {
  return run(async () => {
    await deleteMeeting(meetingId)
    revalidatePath(`/projects/${projectId}/meetings`)
    return null
  })
}

export async function addMeetingAttendeeAction(projectId: string, input: unknown) {
  return run(async () => {
    const attendee = await addMeetingAttendee(meetingAttendeeSchema.parse(input))
    revalidatePath(`/projects/${projectId}/meetings`)
    return attendee
  })
}

export async function updateMeetingAttendeeAction(projectId: string, attendeeId: string, input: unknown) {
  return run(async () => {
    const attendee = await updateMeetingAttendee(attendeeId, updateMeetingAttendeeSchema.parse(input))
    revalidatePath(`/projects/${projectId}/meetings`)
    return attendee
  })
}

export async function createMeetingItemTaskAction(projectId: string, input: unknown) {
  return run(async () => {
    const parsed = createMeetingItemTaskSchema.parse(input)
    const task = await createTaskFromMeetingItem({ itemId: parsed.meeting_item_id, assigneeId: parsed.assignee_id, assigneeKind: parsed.assignee_kind })
    revalidatePath(`/projects/${projectId}/meetings`)
    revalidatePath(`/projects/${projectId}/tasks`)
    return task
  })
}

export async function finalizeMeetingAction(projectId: string, meetingId: string) {
  return run(async () => {
    const meeting = await finalizeMeeting(meetingId)
    revalidatePath(`/projects/${projectId}/meetings`)
    return meeting
  })
}

export async function pasteMeetingTranscriptAction(projectId: string, meetingId: string, text: string) {
  return run(async () => { const transcript = await createPastedMeetingTranscript({ meetingId, text }); revalidatePath(`/projects/${projectId}/meetings`); return transcript })
}

export async function queueMeetingAudioTranscriptAction(projectId: string, meetingId: string, fileId: string, source: "recorded" | "audio_upload") {
  return run(async () => { const transcript = await createAudioMeetingTranscript({ meetingId, fileId, source }); revalidatePath(`/projects/${projectId}/meetings`); return transcript })
}

export async function draftMeetingMinutesAction(projectId: string, transcriptId: string) {
  return run(async () => { const proposals = await draftMinutesFromTranscript(transcriptId); revalidatePath(`/projects/${projectId}/meetings`); return proposals })
}

export async function reviewMeetingProposalAction(projectId: string, input: { transcriptId: string; kind: "existing" | "new"; index: number; decision: "accepted" | "rejected"; edited?: Record<string, unknown> }) {
  return run(async () => { const proposals = await reviewMeetingDraftProposal(input); revalidatePath(`/projects/${projectId}/meetings`); return proposals })
}
