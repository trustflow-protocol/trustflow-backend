import { z } from 'zod';
import { MAX_BASE64_CONTENT_LENGTH } from '../ipfs-pinning/ipfs-pinning.types';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

// Character class only (no nested quantifiers), so it runs in linear time even on the
// largest payload the body limit lets through.
const BASE64_BODY_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 check: standard alphabet, optional trailing `=` padding, whole 4-character
 * groups. Node's own decoder silently skips invalid characters, so without this, arbitrary
 * text would "decode" to garbage bytes and get pinned.
 */
function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_BODY_REGEX.test(value);
}

export const UploadDeliverableSchema = z.object({
  gigId: z.string().min(1),
  freelancer: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
  // Both checks run on the encoded string, before any decoding or pinning. The alphabet scan
  // is skipped for oversized input, which the length cap already rejects.
  content: z
    .string()
    .min(1, 'Base64-encoded content is required')
    .max(MAX_BASE64_CONTENT_LENGTH, 'content exceeds the maximum allowed size of 10 MB (decoded)')
    .refine(value => value.length > MAX_BASE64_CONTENT_LENGTH || isBase64(value), {
      message: 'content must be valid base64',
    }),
  filename: z.string().min(1).max(255),
});

export type UploadDeliverableDto = z.infer<typeof UploadDeliverableSchema>;
