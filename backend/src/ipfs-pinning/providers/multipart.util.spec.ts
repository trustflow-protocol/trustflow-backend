import { buildSingleFileMultipart } from './multipart.util';

describe('buildSingleFileMultipart()', () => {
  const FIELD_NAME = 'file';
  const FILENAME = 'test-upload.bin';
  const CONTENT = Buffer.from('Hello, IPFS!');

  it('returns an object with body (Buffer) and contentType (string)', () => {
    const result = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);

    expect(result).toHaveProperty('body');
    expect(result).toHaveProperty('contentType');
    expect(result.body).toBeInstanceOf(Buffer);
    expect(typeof result.contentType).toBe('string');
  });

  // ─── contentType ─────────────────────────────────────────────────────────

  describe('contentType', () => {
    it('starts with "multipart/form-data; boundary="', () => {
      const { contentType } = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    });

    it('boundary in contentType starts with "----trustflow-"', () => {
      const { contentType } = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      const boundary = contentType.replace('multipart/form-data; boundary=', '');
      expect(boundary).toMatch(/^----trustflow-[0-9a-f]{32}$/);
    });

    it('generates a unique boundary on each call (crypto randomness)', () => {
      const a = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      const b = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      expect(a.contentType).not.toBe(b.contentType);
    });

    it('boundary in body matches boundary in contentType', () => {
      const { body, contentType } = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      const boundary = contentType.replace('multipart/form-data; boundary=', '');
      const bodyStr = body.toString('binary');
      expect(bodyStr).toContain(`--${boundary}`);
    });
  });

  // ─── body structure ───────────────────────────────────────────────────────

  describe('body structure', () => {
    let bodyStr: string;
    let boundary: string;

    beforeEach(() => {
      const result = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      boundary = result.contentType.replace('multipart/form-data; boundary=', '');
      bodyStr = result.body.toString('utf8');
    });

    it('body starts with the part boundary line', () => {
      expect(bodyStr.startsWith(`--${boundary}\r\n`)).toBe(true);
    });

    it('body ends with the closing boundary (--boundary--)', () => {
      expect(bodyStr.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    });

    it('Content-Disposition header contains the field name', () => {
      expect(bodyStr).toContain(`name="${FIELD_NAME}"`);
    });

    it('Content-Disposition header contains the filename', () => {
      expect(bodyStr).toContain(`filename="${FILENAME}"`);
    });

    it('Content-Type header is application/octet-stream', () => {
      expect(bodyStr).toContain('Content-Type: application/octet-stream');
    });

    it('body contains the raw file content', () => {
      // The body buffer must contain the exact byte sequence of the content.
      const { body } = buildSingleFileMultipart(FIELD_NAME, FILENAME, CONTENT);
      const contentIndex = body.indexOf(CONTENT);
      expect(contentIndex).toBeGreaterThan(-1);
    });

    it('blank line (CRLF CRLF) separates headers from content', () => {
      // RFC 2046: header block ends with an empty line.
      expect(bodyStr).toContain('\r\n\r\n');
    });
  });

  // ─── binary content integrity ─────────────────────────────────────────────

  describe('binary content integrity', () => {
    it('preserves arbitrary binary data without corruption', () => {
      // Use a buffer with all byte values 0x00–0xFF to catch any text-encoding issues.
      const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const { body } = buildSingleFileMultipart('data', 'binary.bin', binary);

      const contentIndex = body.indexOf(binary);
      expect(contentIndex).toBeGreaterThan(-1);
    });

    it('handles an empty content buffer', () => {
      const empty = Buffer.alloc(0);
      const { body, contentType } = buildSingleFileMultipart('f', 'empty.bin', empty);

      expect(body).toBeInstanceOf(Buffer);
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      // The header and footer must still be well-formed.
      const boundary = contentType.replace('multipart/form-data; boundary=', '');
      expect(body.toString()).toContain(`--${boundary}`);
    });

    it('total body size equals header + content + footer lengths', () => {
      const content = Buffer.from('size check');
      const { body, contentType } = buildSingleFileMultipart('f', 'size.txt', content);
      const boundary = contentType.replace('multipart/form-data; boundary=', '');

      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="size.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

      expect(body.length).toBe(header.length + content.length + footer.length);
    });
  });

  // ─── field / filename edge cases ──────────────────────────────────────────

  describe('field name and filename handling', () => {
    it('uses the provided fieldName in the Content-Disposition header', () => {
      const { body } = buildSingleFileMultipart('upload-field', 'f.bin', CONTENT);
      expect(body.toString()).toContain('name="upload-field"');
    });

    it('uses the provided filename in the Content-Disposition header', () => {
      const { body } = buildSingleFileMultipart(FIELD_NAME, 'my-photo.png', CONTENT);
      expect(body.toString()).toContain('filename="my-photo.png"');
    });

    it('handles filenames with spaces', () => {
      const { body } = buildSingleFileMultipart(FIELD_NAME, 'my file.bin', CONTENT);
      expect(body.toString()).toContain('filename="my file.bin"');
    });
  });
});
