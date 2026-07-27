/**
 * A catalog with no photography still has to read as a materials board, so an
 * option without an image gets a stable colour derived from its id. Same option,
 * same swatch, every session and every screen.
 *
 * The hue comes from a full FNV-1a hash rather than a running modulo, because
 * catalog ids differ only in their last characters — folding at every step
 * collapses a whole category onto one hue.
 */
export function swatchHue(id: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const hue = hash % 360
  // Vary chroma and lightness a little too, so neighbouring hues stay distinct
  // for anyone who reads them as material rather than as colour.
  const chroma = 0.04 + ((hash >>> 9) % 5) / 100
  const lightness = 0.6 + ((hash >>> 17) % 16) / 100
  return `oklch(${lightness.toFixed(2)} ${chroma.toFixed(2)} ${hue})`
}
