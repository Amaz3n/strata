"use server"

import {
  dismissReleaseNoteAnnouncement,
  markReleaseNoteAnnounced,
  markReleaseNotesSeen,
} from "@/lib/services/release-notes"

export async function markReleaseNotesSeenAction(releaseNoteIds: string[]) {
  await markReleaseNotesSeen(releaseNoteIds)
  return { success: true }
}

export async function markReleaseNoteAnnouncedAction(releaseNoteId: string) {
  await markReleaseNoteAnnounced(releaseNoteId)
  return { success: true }
}

export async function dismissReleaseNoteAnnouncementAction(releaseNoteId: string) {
  await dismissReleaseNoteAnnouncement(releaseNoteId)
  return { success: true }
}
