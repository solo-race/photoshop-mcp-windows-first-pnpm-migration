import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePNG } from './helpers/selection-fill-native-decoder.mjs';
import { expectedRGBA, crc32, createFixturePNG, compareRGBA, closeOwned } from './helpers/selection-fill-rgba-roundtrip-gate.mjs';

// Independent pixel fixtures only; no Photoshop connection or process execution.
test('legal PNG chunks decode the independently specified full RGBA fixture, including hidden RGB', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
  const png = createFixturePNG(), types = [];
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let position = 8;
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const body = png.subarray(position + 4, position + 8 + length);
    types.push(body.subarray(0, 4).toString('ascii'));
    assert.equal(png.readUInt32BE(position + 8 + length), crc32(body));
    position += length + 12;
  }
  assert.equal(position, png.length);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const expected = Buffer.from(Array.from({ length: 64 }, (_, pixel) =>
    pixel === 0 ? [101, 102, 103, 255] : pixel === 63 ? [11, 29, 53, 255] : [7, 8, 9, 0]).flat());
  const decoded = decodePNG(png);
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [8, 8, 4]);
  assert.deepEqual(decoded.rgba, expected);
  assert.deepEqual(expectedRGBA(), expected);
  assert.equal(compareRGBA(decoded).observerRepairAllowed, false);
});

test('hidden RGB normalization or incomplete pixels explicitly fail the pipeline comparison', () => {
  const decoded = decodePNG(createFixturePNG());
  const normalized = Buffer.from(decoded.rgba);
  normalized.fill(0, 4, 7); // Alpha stays zero; loss of hidden RGB still fails.
  for (const rgba of [normalized, decoded.rgba.subarray(0, 252)]) {
    assert.throws(() => compareRGBA({ ...decoded, rgba }), /RGBA_PIPELINE_NOT_PRESERVING/);
  }
});

test('cleanup closes only owned copy/source; failure stops without another close or retry', async () => {
  for (const fail of [false, true]) {
    const owned = new Set([101, 102]), calls = [], events = [];
    const registry = { execute: async (name, args) => {
      calls.push({ name, args });
      return { isError: fail, content: [] };
    } };
    const cleaned = await closeOwned(owned, registry, (event, data) => events.push({ event, data }));
    assert.equal(cleaned, !fail);
    assert.deepEqual(calls.map(call => call.args.document_id), fail ? [102] : [102, 101]);
    assert.ok(calls.every(call => call.name === 'photoshop_close_document'
      && call.args.save === false));
    assert.deepEqual([...owned], fail ? [101, 102] : []);
    assert.equal(events.at(-1).event, fail ? 'cleanup-STOP' : 'cleanup');
  }
});
