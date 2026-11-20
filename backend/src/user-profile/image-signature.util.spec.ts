import { sniffImageMime } from './image-signature.util';

describe('sniffImageMime (#981)', () => {
  it('detects a JPEG by its FF D8 FF signature', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffImageMime(buffer)).toBe('image/jpeg');
  });

  it('detects a PNG by its 8-byte signature', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(sniffImageMime(buffer)).toBe('image/png');
  });

  it('detects a WebP by its RIFF....WEBP signature', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'ascii'),
    ]);
    expect(sniffImageMime(buffer)).toBe('image/webp');
  });

  it('rejects a RIFF container that is not WebP (e.g. a WAV file)', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(sniffImageMime(buffer)).toBeNull();
  });

  it('rejects a script/executable renamed with an image extension', () => {
    const buffer = Buffer.from('#!/bin/sh\nrm -rf /\n', 'ascii');
    expect(sniffImageMime(buffer)).toBeNull();
  });

  it('rejects an empty buffer', () => {
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a buffer too short to contain any supported signature', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
