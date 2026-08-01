import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Shrinks camera-roll photos before upload.
///
/// The field app was sending full-resolution originals — a modern iPhone HEIC is
/// 4–8 MB and the server immediately downscales it to a 2048px preview anyway,
/// so the extra bytes only ever cost the super their cell signal. This resamples
/// to a 3072px long edge and transcodes to JPEG.
///
/// Photos only. Documents (PDFs, plans, contracts) upload untouched — their
/// pixels are the payload.
enum PhotoUploadDownscaler {
    /// Long edge, in pixels. Comfortably above the 2048px preview rung, so a
    /// downscaled upload still has headroom for the largest ladder size.
    static let maxLongEdge: CGFloat = 3072
    static let jpegQuality: CGFloat = 0.85

    struct Result {
        let data: Data
        let fileName: String
        let mimeType: String
    }

    /// Returns nil when the source is not a decodable image or is already small
    /// enough to leave alone — callers then upload the original bytes.
    static func downscale(fileURL: URL, fileName: String) -> Result? {
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let pixelHeight = properties[kCGImagePropertyPixelHeight] as? CGFloat
        else { return nil }

        let longEdge = max(pixelWidth, pixelHeight)
        guard longEdge > maxLongEdge else { return nil }

        // createThumbnail… applies the EXIF orientation and resamples in one
        // pass without ever materializing the full-size bitmap.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxLongEdge,
        ]
        guard let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }

        CGImageDestinationAddImage(
            destination,
            scaled,
            [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else { return nil }

        return Result(
            data: output as Data,
            fileName: (fileName as NSString).deletingPathExtension + ".jpg",
            mimeType: "image/jpeg"
        )
    }
}
