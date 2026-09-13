import sharp from 'sharp';
import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from './errors.js';

/**
 * Turning an uploaded file into an image that is safe to hand to anyone (SECURITY.md §4).
 *
 * Meal photos are the largest attack surface in the product, and every control here
 * exists because an upload is untrusted in more ways than it looks:
 *
 * | Control | Why |
 * |---|---|
 * | Size cap | also enforced by multipart before buffering; repeated here for direct callers |
 * | Declared type | `image/jpeg`, `image/png`, `image/webp` only |
 * | **Magic bytes** | the header is the client's claim; the bytes are the fact |
 * | Declared dimensions | a small file can declare a gigapixel image — a decompression bomb |
 * | **Re-encode** | a file that survives decode/encode is an image, not a polyglot |
 * | **Metadata stripped** | EXIF carries GPS, and a meal photo taken at home is a home address |
 *
 * The last row is not incidental. Stripping happens *before* the image leaves the
 * process, so the coordinates never reach Google either — this matters even though
 * nothing is stored, and it matters more because AURA's users may be minors.
 *
 * Nothing downstream ever sees the original bytes. `prepareImage` returns a fresh WebP,
 * and the upload buffer is dropped by the caller.
 */

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/**
 * The decompression-bomb guard, on *declared* dimensions, checked before decoding.
 *
 * 50 megapixels. `SECURITY.md` names 4096×4096 (16.7 MP), and read as an *input* limit
 * that would refuse the 48–50 MP photos many current phones save by default — a user
 * who cannot log their dinner because their camera is good. So 4096 is applied to the
 * output instead (below), and the input guard sits where it stops a bomb without
 * stopping a phone: a 50 MP RGB decode is roughly 150 MB, bounded, and anything larger
 * is refused before a byte of it is decoded.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Longest edge after re-encoding.
 *
 * Well inside the 4096 ceiling. Identifying food on a plate needs nowhere near a full
 * camera resolution, and a smaller image is a smaller request to the provider — which
 * caps inline image data at 20 MB for the whole request.
 */
export const OUTPUT_MAX_EDGE = 2048;

const OUTPUT_QUALITY = 82;

/** What libvips calls each accepted type, for cross-checking the sniff. */
const LIBVIPS_FORMAT: Record<AcceptedImageType, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface PreparedImage {
  /** Re-encoded WebP with no metadata. */
  data: Buffer;
  mimeType: 'image/webp';
  bytes: number;
  width: number;
  height: number;
}

/**
 * The image type the bytes actually are, or `null`.
 *
 * Signatures only, so this never decodes anything and is safe to run on arbitrary input.
 * JPEG starts `FF D8 FF`; PNG carries its full eight-byte signature; WebP is a RIFF
 * container with `WEBP` at offset 8.
 */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  const matches = (offset: number, signature: readonly number[]): boolean =>
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte);

  if (matches(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches(0, [0x52, 0x49, 0x46, 0x46]) && matches(8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return null;
}

/** `image/jpeg; charset=binary` → `image/jpeg`. */
function mediaTypeOf(header: string): string {
  return (header.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Validates an upload and returns a re-encoded, metadata-free copy of it.
 *
 * Every rejection is one of the existing API errors — 400 for an empty file, 413 for too
 * large, 415 for anything that is not a readable JPEG, PNG or WebP. A decoder's own error
 * message is never passed on: it describes our internals, not the request.
 */
export async function prepareImage(
  bytes: Buffer,
  declaredType: string,
  options: { maxBytes: number },
): Promise<PreparedImage> {
  if (bytes.length === 0) {
    throw new ValidationError('image: the file is empty', [{ path: 'image', issue: 'empty' }]);
  }

  if (bytes.length > options.maxBytes) {
    throw new PayloadTooLargeError('The image is larger than the upload limit');
  }

  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mediaTypeOf(declaredType))) {
    throw new UnsupportedMediaTypeError('The image must be JPEG, PNG or WebP');
  }

  // The header only got us this far. From here the bytes decide.
  const actual = sniffImageType(bytes);
  if (!actual) {
    throw new UnsupportedMediaTypeError('The file content is not a JPEG, PNG or WebP image');
  }

  // Header read only — no pixels are decoded, so this is safe on a bomb. The pixel limit
  // is off here because the check below needs to see the declared dimensions to refuse
  // them with the right error, rather than as an opaque decoder failure.
  const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: false })
    .metadata()
    .catch(() => null);

  if (!metadata?.width || !metadata.height) {
    throw new UnsupportedMediaTypeError('The image could not be read');
  }

  // A file that sniffs as one format and parses as another is exactly the shape of a
  // polyglot. Refused rather than resolved in either direction.
  if (metadata.format !== LIBVIPS_FORMAT[actual]) {
    throw new UnsupportedMediaTypeError('The file content is not a JPEG, PNG or WebP image');
  }

  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new PayloadTooLargeError('The image dimensions are larger than supported');
  }

  try {
    const { data, info } = await sharp(bytes, {
      // libvips' recommended level for untrusted input: abort on any decoding warning.
      failOn: 'warning',
      // Enforced again during the real decode, in case the header understated it.
      limitInputPixels: MAX_INPUT_PIXELS,
      // Applies the EXIF orientation *before* metadata is discarded, or a portrait
      // photo would reach the model sideways.
      autoOrient: true,
    })
      .resize({
        width: OUTPUT_MAX_EDGE,
        height: OUTPUT_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // No `withMetadata()` / `keepExif()`: sharp's default output carries none, which is
      // the EXIF and GPS strip. Tests assert on the result rather than on this comment.
      .webp({ quality: OUTPUT_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      mimeType: 'image/webp',
      bytes: data.length,
      width: info.width,
      height: info.height,
    };
  } catch {
    throw new UnsupportedMediaTypeError('The image could not be read');
  }
}
