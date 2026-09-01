// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import { exifTakenAtIso, readPhotoExif } from "@/lib/media/exif"

/**
 * A minimal little-endian EXIF block, laid out the way a camera writes one:
 * "Exif\0\0", a TIFF header, IFD0 pointing at the Exif and GPS sub-IFDs, then a
 * heap for values too big to sit inside a 12-byte entry.
 */
interface TagValue {
  tag: number
  type: number
  count: number
  bytes: Buffer
}

function ascii(tag: number, value: string): TagValue {
  const bytes = Buffer.from(`${value}\0`, "latin1")
  return { tag, type: 2, count: bytes.length, bytes }
}

function rationals(tag: number, values: Array<[number, number]>): TagValue {
  const bytes = Buffer.alloc(values.length * 8)
  values.forEach(([numerator, denominator], index) => {
    bytes.writeUInt32LE(numerator, index * 8)
    bytes.writeUInt32LE(denominator, index * 8 + 4)
  })
  return { tag, type: 5, count: values.length, bytes }
}

function long(tag: number, value: number): TagValue {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value, 0)
  return { tag, type: 4, count: 1, bytes }
}

function ifdSize(entries: TagValue[]) {
  return 2 + entries.length * 12 + 4
}

function buildExif(options: { exif?: TagValue[]; gps?: TagValue[] }): Uint8Array {
  const exifEntries = options.exif ?? []
  const gpsEntries = options.gps ?? []

  const ifd0Entries: TagValue[] = []
  const ifd0Start = 8
  // Sub-IFDs sit immediately after IFD0, and the heap after both, so every
  // pointer is known before any bytes are written.
  const ifd0Length = ifdSize([
    ...(exifEntries.length ? [long(0x8769, 0)] : []),
    ...(gpsEntries.length ? [long(0x8825, 0)] : []),
  ])
  const exifStart = ifd0Start + ifd0Length
  const gpsStart = exifStart + (exifEntries.length ? ifdSize(exifEntries) : 0)
  const heapStart = gpsStart + (gpsEntries.length ? ifdSize(gpsEntries) : 0)

  if (exifEntries.length) ifd0Entries.push(long(0x8769, exifStart))
  if (gpsEntries.length) ifd0Entries.push(long(0x8825, gpsStart))

  const heap: Buffer[] = []
  let heapCursor = heapStart

  function writeIfd(entries: TagValue[]): Buffer {
    const buffer = Buffer.alloc(ifdSize(entries))
    buffer.writeUInt16LE(entries.length, 0)
    entries.forEach((entry, index) => {
      const at = 2 + index * 12
      buffer.writeUInt16LE(entry.tag, at)
      buffer.writeUInt16LE(entry.type, at + 2)
      buffer.writeUInt32LE(entry.count, at + 4)
      if (entry.bytes.length <= 4) {
        entry.bytes.copy(buffer, at + 8)
      } else {
        buffer.writeUInt32LE(heapCursor, at + 8)
        heap.push(entry.bytes)
        heapCursor += entry.bytes.length
      }
    })
    return buffer
  }

  const ifd0 = writeIfd(ifd0Entries)
  const exifIfd = exifEntries.length ? writeIfd(exifEntries) : Buffer.alloc(0)
  const gpsIfd = gpsEntries.length ? writeIfd(gpsEntries) : Buffer.alloc(0)

  const header = Buffer.alloc(8)
  header.write("II", 0, "latin1")
  header.writeUInt16LE(42, 2)
  header.writeUInt32LE(ifd0Start, 4)

  return new Uint8Array(
    Buffer.concat([
      Buffer.from("Exif\0\0", "latin1"),
      header,
      ifd0,
      exifIfd,
      gpsIfd,
      ...heap,
    ]),
  )
}

const DATE_TIME_ORIGINAL = 0x9003
const OFFSET_TIME_ORIGINAL = 0x9011

describe("photo EXIF", () => {
  it("resolves an instant when the camera recorded its offset", () => {
    const bytes = buildExif({
      exif: [
        ascii(DATE_TIME_ORIGINAL, "2026:07:04 15:04:11"),
        ascii(OFFSET_TIME_ORIGINAL, "-05:00"),
      ],
    })

    const exif = readPhotoExif(bytes)
    expect(exif.takenAtLocal).toEqual({ year: 2026, month: 7, day: 4, hour: 15, minute: 4, second: 11 })
    expect(exif.offsetMinutes).toBe(-300)
    expect(exifTakenAtIso(exif)).toBe("2026-07-04T20:04:11.000Z")
  })

  it("derives the offset from the GPS clock when no offset tag was written", () => {
    // The same moment: 15:04:11 local, 20:04:09 UTC by the GPS receiver. The two
    // clocks are two seconds apart, which must still snap to a clean -5 hours.
    const bytes = buildExif({
      exif: [ascii(DATE_TIME_ORIGINAL, "2026:07:04 15:04:11")],
      gps: [
        ascii(29, "2026:07:04"),
        rationals(7, [[20, 1], [4, 1], [9, 1]]),
      ],
    })

    const exif = readPhotoExif(bytes)
    expect(exif.offsetMinutes).toBe(-300)
    expect(exifTakenAtIso(exif)).toBe("2026-07-04T20:04:11.000Z")
  })

  it("refuses to invent a timezone the file does not settle", () => {
    const exif = readPhotoExif(buildExif({ exif: [ascii(DATE_TIME_ORIGINAL, "2026:07:04 15:04:11")] }))

    expect(exif.takenAtLocal).not.toBeNull()
    expect(exif.offsetMinutes).toBeNull()
    // The server has no zone to apply, so the upload time stands.
    expect(exifTakenAtIso(exif)).toBeNull()
    // The browser does, and reads the wall clock as its own local time.
    const local = exifTakenAtIso(exif, { assumeLocalTime: true })
    expect(local).not.toBeNull()
    expect(new Date(local as string).getFullYear()).toBe(2026)
  })

  it("signs coordinates from their hemisphere references", () => {
    const exif = readPhotoExif(buildExif({
      gps: [
        ascii(1, "S"),
        rationals(2, [[33, 1], [51, 1], [3576, 100]]),
        ascii(3, "W"),
        rationals(4, [[151, 1], [12, 1], [2880, 100]]),
      ],
    }))

    expect(exif.latitude).toBeCloseTo(-33.8599333, 5)
    expect(exif.longitude).toBeCloseTo(-151.2080, 4)
  })

  it("treats a GPS fix of exactly zero as no fix", () => {
    const exif = readPhotoExif(buildExif({
      gps: [
        ascii(1, "N"),
        rationals(2, [[0, 1], [0, 1], [0, 1]]),
        ascii(3, "E"),
        rationals(4, [[0, 1], [0, 1], [0, 1]]),
      ],
    }))

    expect(exif.latitude).toBeNull()
    expect(exif.longitude).toBeNull()
  })

  it("rejects a capture time from a camera whose clock was never set", () => {
    const exif = readPhotoExif(buildExif({
      exif: [
        ascii(DATE_TIME_ORIGINAL, "1980:01:01 00:00:00"),
        ascii(OFFSET_TIME_ORIGINAL, "+00:00"),
      ],
    }))

    expect(exif.takenAtLocal).not.toBeNull()
    expect(exifTakenAtIso(exif)).toBeNull()
  })

  it("reads nothing rather than throwing on files that carry no EXIF", () => {
    expect(readPhotoExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))).toEqual({
      takenAtLocal: null,
      offsetMinutes: null,
      latitude: null,
      longitude: null,
    })
    expect(readPhotoExif(new Uint8Array(0))).toEqual({
      takenAtLocal: null,
      offsetMinutes: null,
      latitude: null,
      longitude: null,
    })
  })

  it("survives a truncated EXIF block with pointers past the end", () => {
    const full = buildExif({ exif: [ascii(DATE_TIME_ORIGINAL, "2026:07:04 15:04:11")] })
    const truncated = full.slice(0, full.length - 12)
    expect(() => readPhotoExif(truncated)).not.toThrow()
    expect(readPhotoExif(truncated).takenAtLocal).toBeNull()
  })
})
