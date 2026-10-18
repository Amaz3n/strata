declare module "fontkit" {
  export function create(bytes: Uint8Array): {
    createSubset(): { encode(): Uint8Array; encodeStream?: () => import("node:stream").Readable }
    [key: string]: unknown
  }
}
