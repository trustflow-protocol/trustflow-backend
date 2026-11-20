export type SniffedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Sniffs a buffer's leading bytes (magic numbers) against the image formats the avatar upload
 * endpoint accepts, and returns the format the content actually is — never the format the
 * caller claims via the multipart `Content-Type` field or the filename extension, both of which
 * are client-controlled and trivially spoofed (#981).
 *
 * Returns `null` when the bytes don't match any supported image signature, including for a file
 * too short to contain one.
 */
export function sniffImageMime(buffer: Buffer): SniffedImageMime | null {
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" + 4-byte size + "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}
