"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { runAction } from "@/lib/action-result"
import { createMilestoneSource, disableMilestoneSource, rotateMilestoneSourceSecret } from "@/lib/services/agreement-milestones"

const PATH = "/settings/milestone-feeds"

async function run<T>(work: () => Promise<T>) {
  const result = await runAction(work)
  if (result.success) revalidatePath(PATH)
  return result
}

/** Returns the signing secret once; it is never readable again. */
export async function createMilestoneSourceAction(input: unknown) {
  return run(() => createMilestoneSource(input))
}

export async function rotateMilestoneSourceSecretAction(sourceId: unknown) {
  return run(() => rotateMilestoneSourceSecret(z.string().uuid().parse(sourceId)))
}

export async function disableMilestoneSourceAction(sourceId: unknown) {
  return run(() => disableMilestoneSource(z.string().uuid().parse(sourceId)))
}
