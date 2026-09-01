/**
 * Just enough EXIF to answer two questions about a jobsite photo: when was it
 * taken, and where. Both come off the phone that shot it and are lost the moment
 * the file lands in storage under an upload timestamp.
 *
 * Deliberately not a general EXIF library. It reads the TIFF block, pulls
 * DateTimeOriginal, the offset tags and the GPS IFD, and stops. It runs in the
 * browser against the head of a File the user just picked, and on the server
 * against bytes the preview job has already downloaded, so it must stay
 * dependency-free and must never throw on a malformed file — a photo with junk
 * metadata is still a photo.
 *
 * ## The timezone problem
 *
 * DateTimeOriginal is wall-clock with no zone. "2026-08-20 15:04:11" is not an
 * instant until you know where the camera was standing, and Arc has no per-org
 * or per-project timezone to fall back on. Guessing UTC would file a 3pm photo
 * at 10am for a builder in Chicago, which is worse than not knowing.
 *
 * So the parser returns the wall-clock reading and, separately, an offset only
 * when the file actually determines one:
 *
 *   1. OffsetTimeOriginal (0x9011) — the camera wrote the zone down. Exact.
 *   2. GPSDateStamp + GPSTimeStamp — the same moment in UTC. Subtracting gives
 *      the offset, rounded to the quarter hour because the two clocks tick
 *      independently. Any phone that recorded a location recorded this too,
 *      which on a jobsite is most of them.
 *
 * When neither is present the caller decides. The browser can, because the
 * photo was almost certainly taken in the same zone the person uploading it is
 * standing in — see `exifTakenAtIso` with `assumeLocalTime`. The server cannot,
 * and leaves the upload time in place rather than inventing one.
 */

/** How much of a file to hand the parser. The TIFF block sits near the front of
 *  a JPEG and, in practice, of a HEIC too; reading more buys nothing. */
export const EXIF_SCAN_BYTES = 256 * 1024

export interface ExifWallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export interface PhotoExif {
  /** Capture time as the camera wrote it: wall clock, no zone. */
  takenAtLocal: ExifWallClock | null
  /** Minutes east of UTC, only when the file determines it. */
  offsetMinutes: number | null
  latitude: number | null
  longitude: number | null
}

const EMPTY: PhotoExif = { takenAtLocal: null, offsetMinutes: null, latitude: null, longitude: null }

const TAG_DATETIME = 0x0132
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004
const TAG_OFFSET_TIME = 0x9010
const TAG_OFFSET_TIME_ORIGINAL = 0x9011

const GPS_LATITUDE_REF = 1
const GPS_LATITUDE = 2
const GPS_LONGITUDE_REF = 3
const GPS_LONGITUDE = 4
const GPS_TIMESTAMP = 7
const GPS_DATESTAMP = 29

const TYPE_BYTE_LENGTH: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
}

interface Reader {
  view: DataView
  littleEndian: boolean
  /** Offset of the TIFF header; every pointer in the block is relative to it. */
  base: number
}

interface IfdEntry {
  type: number
  count: number
  /** Absolute offset of the entry's value, inline slot or pointed-at block. */
  valueOffset: number
}

type Ifd = Map<number, IfdEntry>

/** Locate the TIFF header — `II*\0` or `MM\0*` — that starts the EXIF block.
 *
 * A JPEG carries it inside an APP1 segment introduced by `Exif\0\0`, and so does
 * a HEIC, in an `Exif` item rather than a marker segment. Rather than teach this
 * two container formats, it scans for that introducer and validates what follows.
 * Anything that does not validate is treated as absent. */
function findTiffHeader(bytes: Uint8Array): number | null {
  const limit = Math.min(bytes.length, EXIF_SCAN_BYTES) - 8
  for (let i = 0; i < limit; i += 1) {
    // "Exif\0\0"
    if (
      bytes[i] !== 0x45 || bytes[i + 1] !== 0x78 || bytes[i + 2] !== 0x69 ||
      bytes[i + 3] !== 0x66 || bytes[i + 4] !== 0x00 || bytes[i + 5] !== 0x00
    ) {
      continue
    }
    const tiff = i + 6
    if (tiff + 8 > bytes.length) return null
    const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
    const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
    if (!little && !big) continue
    const magic = little
      ? bytes[tiff + 2] | (bytes[tiff + 3] << 8)
      : (bytes[tiff + 2] << 8) | bytes[tiff + 3]
    if (magic !== 42) continue
    return tiff
  }
  return null
}

function readIfd(reader: Reader, offset: number): Ifd {
  const entries: Ifd = new Map()
  const { view, littleEndian } = reader
  if (offset + 2 > view.byteLength) return entries

  const count = view.getUint16(offset, littleEndian)
  // A plausible IFD has tens of entries. Thousands means the offset was garbage.
  if (count > 512) return entries

  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset + 2 + i * 12
    if (entryOffset + 12 > view.byteLength) break

    const tag = view.getUint16(entryOffset, littleEndian)
    const type = view.getUint16(entryOffset + 2, littleEndian)
    const valueCount = view.getUint32(entryOffset + 4, littleEndian)
    const unitSize = TYPE_BYTE_LENGTH[type]
    if (!unitSize) continue

    const byteLength = unitSize * valueCount
    if (byteLength > view.byteLength) continue

    // Four bytes or fewer live in the entry itself; anything larger is a pointer
    // measured from the TIFF header.
    const valueOffset = byteLength <= 4
      ? entryOffset + 8
      : reader.base + view.getUint32(entryOffset + 8, littleEndian)
    if (valueOffset < 0 || valueOffset + byteLength > view.byteLength) continue

    entries.set(tag, { type, count: valueCount, valueOffset })
  }

  return entries
}

function readAscii(reader: Reader, entry: IfdEntry | undefined): string | null {
  if (!entry || entry.type !== 2) return null
  const bytes: number[] = []
  for (let i = 0; i < entry.count; i += 1) {
    const byte = reader.view.getUint8(entry.valueOffset + i)
    if (byte === 0) break
    bytes.push(byte)
  }
  const value = String.fromCharCode(...bytes).trim()
  return value.length > 0 ? value : null
}

function readPointer(reader: Reader, entry: IfdEntry | undefined): number | null {
  if (!entry) return null
  if (entry.type !== 4 && entry.type !== 3) return null
  const raw = entry.type === 4
    ? reader.view.getUint32(entry.valueOffset, reader.littleEndian)
    : reader.view.getUint16(entry.valueOffset, reader.littleEndian)
  return reader.base + raw
}

function readRationals(reader: Reader, entry: IfdEntry | undefined, expected: number): number[] | null {
  if (!entry || (entry.type !== 5 && entry.type !== 10)) return null
  if (entry.count < expected) return null
  const signed = entry.type === 10
  const values: number[] = []
  for (let i = 0; i < expected; i += 1) {
    const at = entry.valueOffset + i * 8
    const numerator = signed
      ? reader.view.getInt32(at, reader.littleEndian)
      : reader.view.getUint32(at, reader.littleEndian)
    const denominator = signed
      ? reader.view.getInt32(at + 4, reader.littleEndian)
      : reader.view.getUint32(at + 4, reader.littleEndian)
    if (denominator === 0) return null
    values.push(numerator / denominator)
  }
  return values
}

/** EXIF writes dates as "YYYY:MM:DD HH:MM:SS". Cameras that never had the clock
 *  set write zeroes, which is an absent date rather than the year 0. */
function parseWallClock(value: string | null): ExifWallClock | null {
  if (!value) return null
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[]
  if (!year || !month || !day) return null
  if (month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60) return null
  return { year, month, day, hour, minute, second }
}

/** "+05:30", "-08:00", and the "Z"-ish variants cameras occasionally emit. */
function parseOffsetTag(value: string | null): number | null {
  if (!value) return null
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim())
  if (!match) return null
  const sign = match[1] === "-" ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 14 || minutes > 59) return null
  return sign * (hours * 60 + minutes)
}

function wallClockToUtcMs(clock: ExifWallClock, offsetMinutes: number): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) -
    offsetMinutes * 60_000
}

/** Recover the camera's zone by comparing its wall clock against the UTC one the
 *  GPS receiver wrote at the same moment. The two are independent clocks, so the
 *  difference lands a few seconds off a real offset — snap it to the quarter hour,
 *  which every civil offset is a multiple of. */
function offsetFromGps(local: ExifWallClock, gpsDate: string | null, gpsTime: number[] | null): number | null {
  if (!gpsDate || !gpsTime) return null
  const match = /^(\d{4}):(\d{2}):(\d{2})$/.exec(gpsDate.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (!year || !month || !day) return null

  const gpsUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) +
    (gpsTime[0] * 3600 + gpsTime[1] * 60 + gpsTime[2]) * 1000
  const localAsUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)

  const rawMinutes = (localAsUtcMs - gpsUtcMs) / 60_000
  if (!Number.isFinite(rawMinutes) || Math.abs(rawMinutes) > 14 * 60 + 30) return null
  const snapped = Math.round(rawMinutes / 15) * 15
  return Math.abs(snapped) > 14 * 60 ? null : snapped
}

function gpsCoordinate(parts: number[] | null, ref: string | null, negativeRef: string): number | null {
  if (!parts || parts.length < 3) return null
  const [degrees, minutes, seconds] = parts
  let value = degrees + minutes / 60 + seconds / 3600
  if (!Number.isFinite(value)) return null
  if (ref?.toUpperCase().startsWith(negativeRef)) value = -value
  return value
}

/**
 * Read what the camera recorded. Never throws: anything unreadable comes back as
 * an absent field.
 */
export function readPhotoExif(bytes: Uint8Array): PhotoExif {
  try {
    const base = findTiffHeader(bytes)
    if (base === null) return EMPTY

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const littleEndian = view.getUint8(base) === 0x49
    const reader: Reader = { view, littleEndian, base }

    const ifd0Offset = base + view.getUint32(base + 4, littleEndian)
    const ifd0 = readIfd(reader, ifd0Offset)

    const exifOffset = readPointer(reader, ifd0.get(TAG_EXIF_IFD))
    const exifIfd = exifOffset === null ? new Map<number, IfdEntry>() : readIfd(reader, exifOffset)

    const gpsOffset = readPointer(reader, ifd0.get(TAG_GPS_IFD))
    const gpsIfd = gpsOffset === null ? new Map<number, IfdEntry>() : readIfd(reader, gpsOffset)

    const takenAtLocal =
      parseWallClock(readAscii(reader, exifIfd.get(TAG_DATETIME_ORIGINAL))) ??
      parseWallClock(readAscii(reader, exifIfd.get(TAG_DATETIME_DIGITIZED))) ??
      parseWallClock(readAscii(reader, ifd0.get(TAG_DATETIME)))

    const latitude = gpsCoordinate(
      readRationals(reader, gpsIfd.get(GPS_LATITUDE), 3),
      readAscii(reader, gpsIfd.get(GPS_LATITUDE_REF)),
      "S",
    )
    const longitude = gpsCoordinate(
      readRationals(reader, gpsIfd.get(GPS_LONGITUDE), 3),
      readAscii(reader, gpsIfd.get(GPS_LONGITUDE_REF)),
      "W",
    )

    const taggedOffset =
      parseOffsetTag(readAscii(reader, exifIfd.get(TAG_OFFSET_TIME_ORIGINAL))) ??
      parseOffsetTag(readAscii(reader, exifIfd.get(TAG_OFFSET_TIME)))

    const offsetMinutes = takenAtLocal
      ? taggedOffset ?? offsetFromGps(
          takenAtLocal,
          readAscii(reader, gpsIfd.get(GPS_DATESTAMP)),
          readRationals(reader, gpsIfd.get(GPS_TIMESTAMP), 3),
        )
      : null

    // A camera with no GPS lock writes 0/0 rather than omitting the tags.
    const hasFix = latitude !== null && longitude !== null && (latitude !== 0 || longitude !== 0)

    return {
      takenAtLocal,
      offsetMinutes,
      latitude: hasFix ? latitude : null,
      longitude: hasFix ? longitude : null,
    }
  } catch {
    return EMPTY
  }
}

/**
 * Turn the reading into an instant, or admit there isn't one.
 *
 * `assumeLocalTime` is for the browser and only for the browser: the person
 * uploading is nearly always in the zone the photo was taken in, and building the
 * Date from components lets the platform apply that zone's rules for the photo's
 * own date rather than today's — which is what keeps a July photo uploaded in
 * January off by zero hours instead of one.
 */
export function exifTakenAtIso(
  exif: PhotoExif,
  options: { assumeLocalTime?: boolean } = {},
): string | null {
  const clock = exif.takenAtLocal
  if (!clock) return null

  const instant = exif.offsetMinutes !== null
    ? new Date(wallClockToUtcMs(clock, exif.offsetMinutes))
    : options.assumeLocalTime
      ? new Date(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
      : null

  if (!instant || Number.isNaN(instant.getTime())) return null

  // A camera whose clock was never set reports 1970 or 2000-01-01; a future date
  // means the same thing. Neither is worth overwriting the upload time with.
  const ms = instant.getTime()
  if (ms < Date.UTC(1990, 0, 1) || ms > Date.now() + 48 * 3600 * 1000) return null

  return instant.toISOString()
}

/** Read the head of a browser File. Reading the whole thing to find a header in
 *  the first few kilobytes would stall a 30-photo selection. */
export async function readPhotoExifFromFile(file: Blob): Promise<PhotoExif> {
  try {
    const head = file.slice(0, EXIF_SCAN_BYTES)
    return readPhotoExif(new Uint8Array(await head.arrayBuffer()))
  } catch {
    return EMPTY
  }
}
