import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

// Deliberately bounded: non-interlaced PNG, 8-bit RGB/RGBA only. Reject other encodings.
export function decodePNG(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels;
  const parts = [];
  let ended = false;
  for (let pos = 8; pos < png.length;) {
    const size = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + size);
    assert.equal(data.length, size);
    assert.ok(pos + size + 12 <= png.length);
    if (type === 'IHDR') {
      assert.equal(size, 13);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.ok(width > 0 && height > 0 && width <= 64 && height <= 64);
      assert.equal(data[8], 8);
      assert.ok(data[9] === 2 || data[9] === 6, 'PNG must be RGB8/RGBA8');
      channels = data[9] === 6 ? 4 : 3;
      assert.deepEqual([...data.subarray(10)], [0, 0, 0]);
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') { ended = true; break; }
    else if (type[0] === type[0].toUpperCase()) throw new Error(`Unsupported PNG chunk ${type}`);
    pos += size + 12;
  }
  assert.ok(ended && channels && parts.length);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  const samples = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= channels ? samples[i - channels] : 0;
      const b = y ? samples[i - stride] : 0;
      const c = y && x >= channels ? samples[i - stride - channels] : 0;
      const predict = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      samples[i] = (raw[y * (stride + 1) + 1 + x] + predict) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    samples.copy(rgba, i * 4, i * channels, i * channels + 3);
    rgba[i * 4 + 3] = channels === 4 ? samples[i * channels + 3] : 255;
  }
  return { width, height, rgba, channels };
}

// Fixture assembly uses literal filter residuals, never an implementation of PNG filtering.
// Zero CRC fields are intentional: this bounded decoder does not verify CRCs.
function literalPNG(width, height, type, rows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = type;
  const raw = Buffer.from(rows);
  let a = 1, b = 0;
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const tail = Buffer.alloc(4); tail.writeUInt32BE(((b << 16) | a) >>> 0);
  const n = raw.length;
  const stored = Buffer.concat([Buffer.from([0x78, 1, 1, n & 255, n >> 8, (~n) & 255, ((~n) >> 8) & 255]), raw, tail]);
  const chunk = (name, data) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    return Buffer.concat([size, Buffer.from(name), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', stored), chunk('IEND', Buffer.alloc(0))]);
}

export function verifyDecoderFixtures() {
  const png = literalPNG(2, 5, 6, [
    0, 10,20,30,40,50,60,70,80,
    1, 10,20,30,40,40,40,40,40,
    2, 0,0,0,0,0,0,0,0,
    3, 5,10,15,20,20,20,20,20,
    4, 0,0,0,0,0,0,0,0,
  ]);
  assert.deepEqual(decodePNG(png).rgba, Buffer.from(Array(5).fill([10,20,30,40,50,60,70,80]).flat()));
  assert.deepEqual(decodePNG(literalPNG(2, 1, 6, [0, 7,8,9,0,101,102,103,255])).rgba, Buffer.from([7,8,9,0,101,102,103,255]));
  assert.deepEqual(decodePNG(literalPNG(1, 1, 2, [0, 11,22,33])).rgba, Buffer.from([11,22,33,255]));
  assert.throws(() => decodePNG(literalPNG(1, 1, 0, [0, 1])));
  return 'Literal PNG fixtures: filters 0–4, RGB order, alpha and hidden RGB decoded exactly';
}

export const SIZE = 8;
export const COLOR = [197, 83, 41, 255];
export const POINTS = { one: [[2, 3]], four: [[1,1], [5,1], [2,5], [6,6]] };
export function expectedBackground(opaque) {
  return Buffer.from(Array(SIZE * SIZE).fill(opaque ? [23,47,89,255] : [0,0,0,0]).flat());
}
export function expectedFill(before, points, color = COLOR) {
  const expected = Buffer.from(before);
  for (const [x,y] of points) Buffer.from(color).copy(expected, (y * SIZE + x) * 4);
  return expected;
}
