import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { decodePNG } from './selection-fill-native-decoder.mjs';
// Independent row-major RGBA literal. Transparent pixels retain [7,8,9].
const literal = [
  101,102,103,255, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0,
  7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 7,8,9,0, 11,29,53,255,
];
export function expectedRGBA() { return Buffer.from(literal); }

// CRC is required by PNG, rather than an additional evidence fingerprint.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createFixturePNG() {
  const rgba = expectedRGBA();
  assert.equal(rgba.length, 256);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(8 * 33); // Filter 0, then 32 literal RGBA bytes per row.
  for (let y = 0; y < 8; y++) rgba.copy(rows, y * 33 + 1, y * 32, (y + 1) * 32);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function compareRGBA(decoded) {
  const expected = expectedRGBA();
  if (decoded.width !== 8 || decoded.height !== 8 || decoded.rgba.length !== 256
    || !decoded.rgba.equals(expected)) throw new Error('RGBA_PIPELINE_NOT_PRESERVING');
  return { rgbaRoundtripGatePassed: true, scope: 'fixed-owned-import-document-export-sample',
    observerRepairAllowed: false };
}

export async function closeOwned(owned, registry, record) {
  for (const id of [...owned].reverse()) {
    try {
      const result = await registry.execute('photoshop_close_document', {
        document_id: id, save: false,
      });
      if (result.isError) throw new Error(JSON.stringify(result));
      owned.delete(id);
      record('cleanup', { document_id: id, closed: true });
    } catch (error) {
      record('cleanup-STOP', { document_id: id, error: String(error), remaining: [...owned] });
      return false; // No retry, other document cleanup, recovery or lock deletion.
    }
  }
  return true;
}
