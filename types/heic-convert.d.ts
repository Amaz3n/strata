declare module "heic-convert" {
  type ConvertOptions = {
    buffer: Buffer | Uint8Array
    format: "JPEG" | "PNG"
    quality?: number
  }

  type ConvertAllResult = {
    convert: () => Promise<Buffer>
  }

  interface HeicConvert {
    (options: ConvertOptions): Promise<Buffer>
    all(options: ConvertOptions): Promise<ConvertAllResult[]>
  }

  const convert: HeicConvert
  export = convert
}
