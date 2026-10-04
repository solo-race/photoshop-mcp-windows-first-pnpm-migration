import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhotoshopConnection } from '../dist/platform/connection.js';
import { OperationLock, operationContext } from '../dist/core/operation-lock.js';
import { createLayerTools } from '../dist/tools/layer-tools.js';
import { createSelectionTools } from '../dist/tools/selection-tools.js';

function operationTest(name, run) {
  test(name, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ps-selection-fill-test-'));
    const lock = new OperationLock(join(root, 'operation'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await lock.acquire();
    try {
      await operationContext.run({ lock, isStopping: () => false }, () => run(t));
    } finally {
      await lock.release();
    }
  });
}

// DOM spies expose inputs and writes; they do not implement pixel filling or
// establish Adobe's native selection/channel semantics (those remain P2 gates).
function fixture(points = null) {
  const writes = [];
  const fills = [];
  const options = new Map();
  const control = { selection: points, error: null, scripts: 0 };
  function UnitValue(value, unit) {
    return { value, unit, as: () => value };
  }
  class ActionDescriptor {
    constructor(values = new Map()) {
      this.values = new Map(values);
    }
    putString(key, value) {
      this.values.set(key, value);
    }
    getString(key) {
      if (!this.values.has(key)) throw new Error('NO_TOKEN');
      return this.values.get(key);
    }
  }
  class ActionReference {
    putEnumerated() {}
  }
  const channels = ['Red', 'Green', 'Blue'].map((name) => ({ name, kind: 'COMPONENT' }));
  const layer = {
    id: 8,
    typename: 'ArtLayer',
    kind: 'NORMAL',
    isBackgroundLayer: false,
    allLocked: false,
    pixelsLocked: false,
    transparentPixelsLocked: false,
  };
  const selection = {
    get bounds() {
      if (!control.selection) throw new Error('NO_SELECTION_BOUNDS');
      const xs = control.selection.map((p) => p[0]);
      const ys = control.selection.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1].map((v) =>
        UnitValue(v, 'px')
      );
    },
    fill(color, mode, opacity, preserveTransparency) {
      writes.push('fill');
      fills.push({
        selection: control.selection,
        rgb: { ...color.rgb },
        mode,
        opacity,
        preserveTransparency,
      });
      if (control.error) throw control.error;
    },
    selectAll() {
      writes.push('selectAll');
      control.selection = 'all';
    },
    deselect() {
      writes.push('deselect');
      control.selection = null;
    },
    select(...args) {
      writes.push({ select: args });
    },
  };
  const doc = {
    id: 7,
    layers: [layer],
    activeLayer: layer,
    mode: 'RGB',
    bitsPerChannel: 'EIGHT',
    activeChannels: channels,
    componentChannels: channels,
    quickMaskMode: false,
    width: UnitValue(8, 'px'),
    height: UnitValue(8, 'px'),
    selection,
    get fullName() {
      throw new Error('UNSAVED');
    },
  };
  layer.parent = doc;
  const app = {
    name: 'Adobe Photoshop',
    version: '26.0',
    build: 'controlled',
    documents: [doc],
    activeDocument: doc,
    displayDialogs: 'ALL',
    putCustomOptions(key, value) {
      options.set(key, value);
    },
    getCustomOptions(key) {
      if (!options.has(key)) throw new Error('NO_OPTIONS');
      return options.get(key);
    },
  };
  const connection = new PhotoshopConnection();
  connection.detector = {
    detect: async () => ({ version: app.version, path: '', isRunning: true }),
  };
  connection.executor = {
    isPhotoshopRunning: async () => true,
    launchPhotoshop: async () => {
      throw new Error('UNEXPECTED_LAUNCH');
    },
    execute: async (script) => {
      control.scripts++;
      const result = runInNewContext(script, {
        $: { global: {}, engineName: 'SS main' },
        app,
        ActionDescriptor,
        ActionReference,
        stringIDToTypeID: (value) => value,
        charIDToTypeID: (value) => value,
        executeActionGet: () => ({
          hasKey: (key) => key === 'selection' && control.selection !== null,
        }),
        UnitValue,
        SolidColor: class {
          constructor() {
            this.rgb = {};
          }
        },
        DocumentMode: { RGB: 'RGB' },
        BitsPerChannelType: { EIGHT: 'EIGHT' },
        LayerKind: { NORMAL: 'NORMAL' },
        ChannelType: { COMPONENT: 'COMPONENT' },
        ColorBlendMode: { NORMAL: 'NORMAL' },
        SelectionType: { REPLACE: 'REPLACE' },
        DialogModes: { NO: 'NO' },
      });
      return typeof result === 'string' ? JSON.parse(result) : result;
    },
  };
  const fill = createLayerTools(connection).find((t) => t.tool.name === 'photoshop_fill_layer');
  const rectangle = createSelectionTools(connection).find(
    (t) => t.tool.name === 'photoshop_select_rectangle'
  );
  const invoke = async (tool, args, overrides = {}) => {
    await connection.inspectDocuments();
    return connection.withScope(
      { documentId: 7, documentPath: null, layerId: 8, recheck: async () => {}, ...overrides },
      () => tool.handler(args)
    );
  };
  return { connection, app, doc, layer, control, writes, fills, options, fill, rectangle, invoke };
}

const rgb = { red: 17, green: 91, blue: 203 };
const successful = (result) => {
  assert.notEqual(result.isError, true);
  return JSON.parse(result.content[0].text);
};
const rejected = (result) => assert.equal(result.isError, true, result.content[0].text);

for (const points of [
  [[2, 3]],
  [
    [1, 1],
    [5, 1],
    [1, 5],
    [5, 5],
  ],
]) {
  operationTest(`selection scope forwards and preserves the original ${points.length}-point selection`, async () => {
    const f = fixture(points);
    const result = successful(await f.invoke(f.fill, { scope: 'selection', ...rgb }));
    assert.deepEqual(result, {
      scope: 'selection',
      actualbounds: points.length === 1 ? [2, 3, 3, 4] : [1, 1, 6, 6],
      selection_preserved: true,
    });
    assert.deepEqual(f.writes, ['fill']);
    assert.equal(f.control.selection, points);
    assert.equal(f.fills[0].selection, points);
    assert.deepEqual(f.fills[0].rgb, rgb);
    assert.deepEqual(
      [f.fills[0].mode, f.fills[0].opacity, f.fills[0].preserveTransparency],
      ['NORMAL', 100, false]
    );
  });
}

operationTest('layer scope fills the canvas then restores the absence of selection, including a fill failure', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    if (fail) f.control.error = new Error('FILL_FAILED');
    const result = await f.invoke(f.fill, { scope: 'layer', ...rgb });
    if (fail) {
      rejected(result);
      assert.match(result.content[0].text, /FILL_FAILED/);
    } else
      assert.deepEqual(successful(result), {
        scope: 'layer',
        actualbounds: [0, 0, 8, 8],
        selection_preserved: true,
      });
    assert.deepEqual(f.writes, ['selectAll', 'fill', 'deselect']);
    assert.equal(f.control.selection, null);
  }
});

operationTest('missing/invalid scope and noninteger/nonfinite/out-of-range RGB reject before API dispatch', async () => {
  for (const args of [
    { ...rgb },
    { scope: 'unknown', ...rgb },
    ...[NaN, Infinity, -1, 256, 1.5, '4'].map((red) => ({ scope: 'layer', ...rgb, red })),
  ]) {
    const f = fixture();
    rejected(await f.fill.handler(args));
    assert.equal(f.control.scripts, 0);
    assert.deepEqual(f.writes, []);
  }
  assert.ok(fixture().fill.tool.inputSchema.required.includes('scope'));
});

operationTest('selection presence and unsupported runtime targets reject before any write', async () => {
  const mutations = [
    (f) => {
      f.doc.mode = 'CMYK';
    },
    (f) => {
      f.doc.bitsPerChannel = 'SIXTEEN';
    },
    (f) => {
      f.layer.kind = 'SMARTOBJECT';
    },
    (f) => {
      f.layer.typename = 'LayerSet';
    },
    ...['allLocked', 'pixelsLocked', 'transparentPixelsLocked', 'isBackgroundLayer'].map(
      (key) => (f) => {
        f.layer[key] = true;
      }
    ),
    (f) => {
      f.layer.parent = { typename: 'LayerSet', allLocked: true };
    },
    (f) => {
      f.doc.quickMaskMode = true;
    },
    (f) => {
      f.doc.activeChannels = [{ name: 'Mask', kind: 'MASKEDAREA' }];
    },
    (f) => {
      f.doc.activeChannels = [f.doc.componentChannels[0]];
    },
    (f) => {
      f.doc.activeChannels = [
        f.doc.componentChannels[0],
        f.doc.componentChannels[0],
        f.doc.componentChannels[2],
      ];
    },
  ];
  for (const change of mutations) {
    const f = fixture([[1, 1]]);
    change(f);
    rejected(await f.invoke(f.fill, { scope: 'selection', ...rgb }));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.control.selection, [[1, 1]]);
  }
  for (const [points, scope] of [
    [null, 'selection'],
    [[[1, 1]], 'layer'],
    [[[-2, -2]], 'selection'],
  ]) {
    const f = fixture(points);
    rejected(await f.invoke(f.fill, { scope, ...rgb }));
    assert.deepEqual(f.writes, []);
    assert.equal(f.control.selection, points);
  }
});

operationTest('activeChannels getter failure rejects once with its original reason before selection or fill writes', async () => {
  for (const [points, scope] of [
    [[[1, 1]], 'selection'],
    [null, 'layer'],
  ]) {
    const f = fixture(points);
    let reads = 0;
    Object.defineProperty(f.doc, 'activeChannels', {
      get() {
        reads++;
        throw new Error('ACTIVE_CHANNELS_UNAVAILABLE');
      },
    });
    const result = await f.invoke(f.fill, { scope, ...rgb });
    rejected(result);
    assert.match(result.content[0].text, /Fill cannot verify RGB target: ACTIVE_CHANNELS_UNAVAILABLE/);
    assert.equal(reads, 1);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.fills, []);
    assert.equal(f.control.selection, points);
  }
});

operationTest('rectangle passes explicit pixel units, REPLACE, zero feather and noAA including canvas edges', async () => {
  for (const edges of [
    [2, 3, 3, 4],
    [0, 0, 8, 8],
  ]) {
    const f = fixture([[1, 1]]);
    const [left, top, right, bottom] = edges;
    assert.notEqual((await f.invoke(f.rectangle, { left, top, right, bottom })).isError, true);
    assert.equal(f.writes.length, 1);
    const [points, type, feather, aa] = f.writes[0].select;
    assert.deepEqual(
      JSON.parse(JSON.stringify(points.map((p) => p.map((v) => [v.value, v.unit])))),
      [
        [
          [left, 'px'],
          [top, 'px'],
        ],
        [
          [right, 'px'],
          [top, 'px'],
        ],
        [
          [right, 'px'],
          [bottom, 'px'],
        ],
        [
          [left, 'px'],
          [bottom, 'px'],
        ],
      ]
    );
    assert.deepEqual([type, feather, aa], ['REPLACE', 0, false]);
  }
});

operationTest('invalid integer/order/canvas coordinates reject before selection mutation', async () => {
  for (const edges of [
    [-1, 0, 2, 2],
    [0, 0, 0, 1],
    [3, 0, 2, 1],
    [0, 2, 1, 2],
    [0, 3, 1, 2],
    [0.5, 0, 2, 2],
    [0, NaN, 2, 2],
    [0, 0, Infinity, 2],
    [0, 0, 9, 2],
    [0, 0, 2, 9],
  ]) {
    const f = fixture([[1, 1]]);
    const [left, top, right, bottom] = edges;
    rejected(await f.invoke(f.rectangle, { left, top, right, bottom }));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.control.selection, [[1, 1]]);
  }
});

operationTest('real connection doc/layer/grant/session guards still precede fill writes', async () => {
  for (const overrides of [
    { documentId: 99 },
    { layerId: 99 },
    { documentPath: '/unexpected.psd' },
  ]) {
    const f = fixture();
    rejected(await f.invoke(f.fill, { scope: 'layer', ...rgb }, overrides));
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  const denied = await f.invoke(
    f.fill,
    { scope: 'layer', ...rgb },
    {
      recheck: async () => {
        throw new Error('GRANT_DENIED');
      },
    }
  );
  rejected(denied);
  assert.match(denied.content[0].text, /GRANT_DENIED/);
  assert.deepEqual(f.writes, []);
  await f.connection.inspectDocuments();
  f.options.clear();
  const result = await f.connection.withScope(
    { documentId: 7, documentPath: null, layerId: 8, recheck: async () => {} },
    () => f.fill.handler({ scope: 'layer', ...rgb })
  );
  rejected(result);
  assert.match(result.content[0].text, /PHOTOSHOP_SESSION_CHANGED/);
  assert.deepEqual(f.writes, []);
});
