import { z } from "zod"

/**
 * Input for capturing a frozen image of a sheet-region (RFI / punch item
 * evidence). The region is normalized 0..1 against the sheet image; values
 * slightly outside the unit square are clamped by the service, but inverted
 * or zero-area rectangles are rejected outright.
 */
export const captureSheetRegionSnapshotSchema = z.object({
  sheetVersionId: z.string().uuid(),
  region: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      w: z.number().finite(),
      h: z.number().finite(),
    })
    .refine((region) => region.w > 0 && region.h > 0, {
      message: "Snapshot region must have positive width and height",
    }),
})

export type CaptureSheetRegionSnapshotInput = z.infer<typeof captureSheetRegionSnapshotSchema>
