import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_PIXELS,
  OUTPUT_MAX_EDGE,
  prepareImage,
  sniffImageType,
} from '../../src/lib/images.js';
import {
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../src/lib/errors.js';

/**
 * Upload hardening (SECURITY.md §4).
 *
 * Every fixture is generated here with `sharp` rather than checked in, so the suite
 * carries no binary files and every property under test is visible in the test itself.
 */

const LIMIT = 8_388_608;

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#c86432' } });

const jpeg = () => solid(64, 48).jpeg().toBuffer();
const png = () => solid(64, 48).png().toBuffer();
const webp = () => solid(64, 48).webp().toBuffer();

/** Rewrites a PNG's IHDR to declare other dimensions — the shape of a decompression bomb. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function pngDeclaring(width: number, height: number): Promise<Buffer> {
  const bytes = Buffer.from(await solid(1, 1).png().toBuffer());
  // IHDR: length @8, type @12, width @16, height @20, CRC over type+data @29.
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

describe('sniffImageType', () => {
  it('recognises JPEG, PNG and WebP by their signatures', async () => {
    expect(sniffImageType(await jpeg())).toBe('image/jpeg');
    expect(sniffImageType(await png())).toBe('image/png');
    expect(sniffImageType(await webp())).toBe('image/webp');
  });

  it('rejects everything else, including other RIFF containers and short input', () => {
    expect(sniffImageType(Buffer.from('%PDF-1.7 not an image'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    // A WAV file is RIFF too — the WEBP marker at offset 8 is what matters.
    expect(sniffImageType(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('prepareImage — accepted input', () => {
  for (const [label, make, declared] of [
    ['JPEG', jpeg, 'image/jpeg'],
    ['PNG', png, 'image/png'],
    ['WebP', webp, 'image/webp'],
  ] as const) {
    it(`accepts ${label} and returns a fresh WebP`, async () => {
      const prepared = await prepareImage(await make(), declared, { maxBytes: LIMIT });

      expect(prepared.mimeType).toBe('image/webp');
      expect(sniffImageType(prepared.data)).toBe('image/webp');
      expect(prepared.bytes).toBe(prepared.data.length);
      expect([prepared.width, prepared.height]).toEqual([64, 48]);
    });
  }

  it('accepts a declared type with parameters', async () => {
    await expect(
      prepareImage(await jpeg(), 'image/jpeg; charset=binary', { maxBytes: LIMIT }),
    ).resolves.toMatchObject({ mimeType: 'image/webp' });
  });

  it('reads a mislabelled image by its bytes — the header is only a claim', async () => {
    // A PNG declared as JPEG is still a valid image; the bytes decide what it is.
    await expect(prepareImage(await png(), 'image/jpeg', { maxBytes: LIMIT })).resolves.toMatchObject({
      mimeType: 'image/webp',
    });
  });
});

describe('prepareImage — metadata never survives', () => {
  it('strips EXIF, including GPS, before the image goes anywhere', async () => {
    const withGps = await solid(64, 48)
      .jpeg()
      .withExif({
        IFD0: { ImageDescription: 'aura-home-address-marker' },
        IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      })
      .toBuffer();

    // Not vacuous: the fixture really does carry the metadata.
    const before = await sharp(withGps).metadata();
    expect(before.exif?.toString('latin1')).toContain('aura-home-address-marker');

    const prepared = await prepareImage(withGps, 'image/jpeg', { maxBytes: LIMIT });

    expect((await sharp(prepared.data).metadata()).exif).toBeUndefined();
    expect(prepared.data.toString('latin1')).not.toContain('aura-home-address-marker');
  });

  it('applies the EXIF orientation before discarding it, so portraits stay upright', async () => {
    // Stored 40×20, tagged "rotate 90°" — how a phone saves a portrait photo.
    const rotated = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const prepared = await prepareImage(rotated, 'image/jpeg', { maxBytes: LIMIT });

    expect([prepared.width, prepared.height]).toEqual([20, 40]);
  });

  it('downsizes a large photo to the output ceiling, keeping its proportions', async () => {
    const large = await solid(3000, 1500).png().toBuffer();

    const prepared = await prepareImage(large, 'image/png', { maxBytes: LIMIT });

    expect([prepared.width, prepared.height]).toEqual([OUTPUT_MAX_EDGE, OUTPUT_MAX_EDGE / 2]);
  });
});

describe('prepareImage — rejected input', () => {
  it('rejects an empty file as a validation error', async () => {
    await expect(prepareImage(Buffer.alloc(0), 'image/jpeg', { maxBytes: LIMIT })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a file over the upload limit', async () => {
    const image = await jpeg();
    await expect(
      prepareImage(image, 'image/jpeg', { maxBytes: image.length - 1 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  for (const declared of ['application/pdf', 'text/plain', 'application/octet-stream', 'video/mp4', 'image/heic', 'image/gif']) {
    it(`rejects a declared type of ${declared}`, async () => {
      await expect(prepareImage(await jpeg(), declared, { maxBytes: LIMIT })).rejects.toBeInstanceOf(
        UnsupportedMediaTypeError,
      );
    });
  }

  it('rejects a non-image that claims to be a JPEG', async () => {
    await expect(
      prepareImage(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'), 'image/jpeg', { maxBytes: LIMIT }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  it('rejects a malformed image with a valid signature, without leaking the decoder error', async () => {
    const forged = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('this is not really a png'),
    ]);

    const error = await prepareImage(forged, 'image/png', { maxBytes: LIMIT }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    expect((error as Error).message).toBe('The image could not be read');
  });

  it('rejects a truncated image rather than decoding half of it', async () => {
    const whole = await solid(400, 300).jpeg().toBuffer();
    const truncated = whole.subarray(0, Math.floor(whole.length / 2));

    await expect(prepareImage(truncated, 'image/jpeg', { maxBytes: LIMIT })).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    );
  });

  it('refuses a decompression bomb on its declared dimensions, before decoding it', async () => {
    // A few hundred bytes declaring 20000×20000 — 400 MP, eight times the guard.
    const bomb = await pngDeclaring(20_000, 20_000);
    expect(bomb.length).toBeLessThan(1_000);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_INPUT_PIXELS);

    await expect(prepareImage(bomb, 'image/png', { maxBytes: LIMIT })).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });
});
