import type { DocumentRef, LayerRef, ResponseDetail } from '../core/models.js';
import { toExtendScriptValue } from '../core/serializer.js';

const baseHelpers = `
function psSafeCall(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return fallback;
  }
}

function psPx(value) {
  return psSafeCall(function() {
    return value.as('px');
  }, value);
}

function psBoundsToObject(bounds) {
  if (!bounds || bounds.length < 4) {
    return null;
  }

  return {
    left: psPx(bounds[0]),
    top: psPx(bounds[1]),
    right: psPx(bounds[2]),
    bottom: psPx(bounds[3])
  };
}

function psGetSelectionBounds(doc) {
  return psSafeCall(function() {
    return psBoundsToObject(doc.selection.bounds);
  }, null);
}

function psGetLayerId(layer) {
  return psSafeCall(function() {
    return layer.id;
  }, null);
}

function psGetDocumentId(doc) {
  return psSafeCall(function() {
    return doc.id;
  }, null);
}

function psGetLayerPath(layer) {
  var names = [];
  var current = layer;

  while (current && current.typename !== 'Document') {
    names.unshift(current.name);
    current = psSafeCall(function() {
      return current.parent;
    }, null);
  }

  return names.join('/');
}

function psGetLayerBounds(layer) {
  return psSafeCall(function() {
    return psBoundsToObject(layer.bounds);
  }, null);
}

function psGetTextInfo(layer) {
  if (String(layer.kind) !== String(LayerKind.TEXT)) {
    return null;
  }

  var item = layer.textItem;
  return {
    contents: psSafeCall(function() { return item.contents; }, ''),
    font: psSafeCall(function() { return item.font; }, null),
    size: psSafeCall(function() { return psPx(item.size); }, null),
    position: psSafeCall(function() {
      return {
        x: item.position[0],
        y: item.position[1]
      };
    }, null),
    justification: psSafeCall(function() { return String(item.justification); }, null)
  };
}

function psGetLayerInfo(layer, depth) {
  var info = {
    id: psGetLayerId(layer),
    name: layer.name,
    path: psGetLayerPath(layer),
    typename: layer.typename,
    kind: psSafeCall(function() { return String(layer.kind); }, layer.typename),
    visible: psSafeCall(function() { return layer.visible; }, true),
    opacity: psSafeCall(function() { return layer.opacity; }, null),
    blendMode: psSafeCall(function() { return String(layer.blendMode); }, null),
    locked: psSafeCall(function() { return layer.allLocked; }, false),
    isBackground: psSafeCall(function() { return layer.isBackgroundLayer; }, false),
    bounds: psGetLayerBounds(layer),
    textInfo: psGetTextInfo(layer),
    childCount: layer.typename === 'LayerSet' ? layer.layers.length : 0
  };

  if (depth > 0 && layer.typename === 'LayerSet') {
    info.children = [];
    for (var i = 0; i < layer.layers.length; i++) {
      info.children.push(psGetLayerInfo(layer.layers[i], depth - 1));
    }
  }

  return info;
}

function psGetHistoryInfo(doc, includeStates) {
  var history = {
    currentStateName: psSafeCall(function() { return doc.activeHistoryState.name; }, null),
    count: psSafeCall(function() { return doc.historyStates.length; }, 0)
  };

  if (includeStates) {
    history.states = [];
    for (var i = 0; i < doc.historyStates.length; i++) {
      history.states.push({
        index: i + 1,
        name: doc.historyStates[i].name,
        snapshot: psSafeCall(function() { return doc.historyStates[i].snapshot; }, false),
        active: doc.historyStates[i] === doc.activeHistoryState
      });
    }
  }

  return history;
}

function psGetChannels(doc) {
  var channels = [];
  var source = psSafeCall(function() { return doc.channels; }, null);
  if (!source) {
    return channels;
  }

  for (var i = 0; i < source.length; i++) {
    channels.push({
      name: source[i].name,
      kind: psSafeCall(function() { return String(source[i].kind); }, null),
      visible: psSafeCall(function() { return source[i].visible; }, null)
    });
  }

  return channels;
}

function psGetGuides(doc) {
  var guides = [];
  var source = psSafeCall(function() { return doc.guides; }, null);
  if (!source) {
    return guides;
  }

  for (var i = 0; i < source.length; i++) {
    guides.push({
      direction: psSafeCall(function() { return String(source[i].direction); }, null),
      coordinate: psSafeCall(function() { return psPx(source[i].coordinate); }, null)
    });
  }

  return guides;
}

function psGetDocumentInfo(doc, includeLayers, layerDepth, historyMode) {
  var info = {
    id: psGetDocumentId(doc),
    name: doc.name,
    width: psPx(doc.width),
    height: psPx(doc.height),
    resolution: doc.resolution,
    colorMode: String(doc.mode),
    layerCount: doc.layers.length,
    hasSelection: psGetSelectionBounds(doc) !== null,
    selectionBounds: psGetSelectionBounds(doc),
    activeLayerName: psSafeCall(function() { return doc.activeLayer.name; }, null)
  };

  if (includeLayers) {
    info.layers = [];
    for (var i = 0; i < doc.layers.length; i++) {
      info.layers.push(psGetLayerInfo(doc.layers[i], layerDepth));
    }
  }

  if (historyMode) {
    info.history = psGetHistoryInfo(doc, historyMode === 'full');
  }

  return info;
}

function psNormalizeIndex(value) {
  var parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return 0;
  }

  return parsed <= 0 ? 0 : parsed - 1;
}

function psResolveDocument(ref) {
  if (!ref || !ref.by || ref.by === 'active') {
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    return app.activeDocument;
  }

  if (ref.by === 'id') {
    for (var i = 0; i < app.documents.length; i++) {
      if (String(psGetDocumentId(app.documents[i])) === String(ref.value)) {
        return app.documents[i];
      }
    }
  }

  if (ref.by === 'name') {
    for (var j = 0; j < app.documents.length; j++) {
      if (app.documents[j].name === String(ref.value)) {
        return app.documents[j];
      }
    }
  }

  if (ref.by === 'index') {
    var docIndex = psNormalizeIndex(ref.value);
    if (docIndex >= 0 && docIndex < app.documents.length) {
      return app.documents[docIndex];
    }
  }

  throw new Error('Document not found');
}

function psCollectLayers(container, collector) {
  for (var i = 0; i < container.layers.length; i++) {
    var layer = container.layers[i];
    collector(layer);
    if (layer.typename === 'LayerSet') {
      psCollectLayers(layer, collector);
    }
  }
}

function psResolveLayer(doc, ref) {
  if (!ref || !ref.by || ref.by === 'active') {
    if (!doc.activeLayer) {
      throw new Error('No active layer');
    }
    return doc.activeLayer;
  }

  if (ref.by === 'index') {
    var layerIndex = psNormalizeIndex(ref.value);
    if (layerIndex >= 0 && layerIndex < doc.layers.length) {
      return doc.layers[layerIndex];
    }
    throw new Error('Layer not found');
  }

  var found = null;
  psCollectLayers(doc, function(layer) {
    if (found) {
      return;
    }

    if (ref.by === 'id' && String(psGetLayerId(layer)) === String(ref.value)) {
      found = layer;
      return;
    }

    if (ref.by === 'name' && layer.name === String(ref.value)) {
      found = layer;
      return;
    }

    if (ref.by === 'path' && psGetLayerPath(layer) === String(ref.value)) {
      found = layer;
    }
  });

  if (!found) {
    throw new Error('Layer not found');
  }

  return found;
}

function psFindLayers(doc, query, mode, textOnly) {
  var matches = [];
  var normalized = query ? String(query).toLowerCase() : '';

  psCollectLayers(doc, function(layer) {
    if (textOnly && String(layer.kind) !== String(LayerKind.TEXT)) {
      return;
    }

    var path = psGetLayerPath(layer);
    var candidate = (path + ' ' + layer.name).toLowerCase();
    var isMatch = normalized.length === 0;

    if (mode === 'exact') {
      isMatch = layer.name === query || path === query;
    } else {
      isMatch = candidate.indexOf(normalized) !== -1;
    }

    if (isMatch) {
      matches.push(psGetLayerInfo(layer, 0));
    }
  });

  return matches;
}
`;

function serializeDetail(detail: ResponseDetail): string {
  return toExtendScriptValue(detail);
}

function serializeDocumentRef(documentRef?: DocumentRef): string {
  return toExtendScriptValue((documentRef ?? { by: 'active' }) as never);
}

function serializeLayerRef(layerRef?: LayerRef): string {
  return toExtendScriptValue((layerRef ?? { by: 'active' }) as never);
}

export function buildGetStateScript(detail: ResponseDetail): string {
  return `
${baseHelpers}
var detail = ${serializeDetail(detail)};
var includeLayers = detail === 'full';
var historyMode = detail === 'full' ? 'full' : (detail === 'normal' ? 'summary' : false);
var state = {
  app: {
    name: app.name,
    version: app.version,
    build: app.build,
    documentsCount: app.documents.length
  },
  hasDocument: app.documents.length > 0,
  documents: [],
  activeDocument: null,
  activeLayer: null,
  history: null,
  channels: [],
  guides: []
};

for (var i = 0; i < app.documents.length; i++) {
  var docInfo = psGetDocumentInfo(app.documents[i], false, 0, false);
  docInfo.index = i + 1;
  docInfo.isActive = app.documents[i] === app.activeDocument;
  state.documents.push(docInfo);
}

if (app.documents.length > 0) {
  var doc = app.activeDocument;
  state.activeDocument = psGetDocumentInfo(doc, detail !== 'minimal', detail === 'full' ? 2 : 0, historyMode);
  state.activeLayer = psSafeCall(function() {
    return psGetLayerInfo(doc.activeLayer, detail === 'full' ? 1 : 0);
  }, null);
  state.history = psGetHistoryInfo(doc, detail === 'full');

  if (detail === 'full') {
    state.channels = psGetChannels(doc);
    state.guides = psGetGuides(doc);
  }
}

return state;
  `.trim();
}

export function buildGetOpenDocumentsScript(detail: ResponseDetail): string {
  return `
${baseHelpers}
var detail = ${serializeDetail(detail)};
var documents = [];
for (var i = 0; i < app.documents.length; i++) {
  var info = psGetDocumentInfo(app.documents[i], detail === 'full', detail === 'full' ? 1 : 0, detail === 'full' ? 'summary' : false);
  info.index = i + 1;
  info.isActive = app.documents[i] === app.activeDocument;
  documents.push(info);
}
return {
  total: documents.length,
  documents: documents
};
  `.trim();
}

export function buildGetDocumentTreeScript(detail: ResponseDetail): string {
  return `
${baseHelpers}
var tree = [];
for (var i = 0; i < app.documents.length; i++) {
  var info = psGetDocumentInfo(app.documents[i], true, ${detail === 'full' ? 3 : 1}, 'summary');
  info.index = i + 1;
  info.isActive = app.documents[i] === app.activeDocument;
  tree.push(info);
}
return {
  total: tree.length,
  documents: tree
};
  `.trim();
}

export function buildGetLayerTreeScript(
  documentRef: DocumentRef | undefined,
  detail: ResponseDetail
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var layers = [];
for (var i = 0; i < doc.layers.length; i++) {
  layers.push(psGetLayerInfo(doc.layers[i], ${detail === 'full' ? 4 : 1}));
}
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  total: layers.length,
  layers: layers
};
  `.trim();
}

export function buildGetLayerInfoScript(
  documentRef: DocumentRef | undefined,
  layerRef: LayerRef | undefined,
  detail: ResponseDetail
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var layer = psResolveLayer(doc, ${serializeLayerRef(layerRef)});
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  layer: psGetLayerInfo(layer, ${detail === 'full' ? 2 : 0})
};
  `.trim();
}

export function buildGetSelectionBoundsScript(documentRef?: DocumentRef): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  selectionBounds: psGetSelectionBounds(doc)
};
  `.trim();
}

export function buildGetHistoryScript(
  documentRef: DocumentRef | undefined,
  detail: ResponseDetail
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  history: psGetHistoryInfo(doc, ${detail === 'full'})
};
  `.trim();
}

export function buildGetActiveContextScript(detail: ResponseDetail): string {
  return `
${baseHelpers}
if (app.documents.length === 0) {
  return {
    hasDocument: false,
    activeDocument: null,
    activeLayer: null,
    history: null
  };
}

var doc = app.activeDocument;
return {
  hasDocument: true,
  activeDocument: psGetDocumentInfo(doc, ${detail !== 'minimal'}, ${detail === 'full' ? 1 : 0}, ${detail === 'full' ? `'full'` : `'summary'`}),
  activeLayer: psSafeCall(function() { return psGetLayerInfo(doc.activeLayer, ${detail === 'full' ? 1 : 0}); }, null),
  history: psGetHistoryInfo(doc, ${detail === 'full'})
};
  `.trim();
}

export function buildFindLayersScript(
  documentRef: DocumentRef | undefined,
  query: string,
  mode: 'contains' | 'exact',
  textOnly = false
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var matches = psFindLayers(doc, ${toExtendScriptValue(query)}, ${toExtendScriptValue(mode)}, ${textOnly});
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  total: matches.length,
  matches: matches
};
  `.trim();
}

export function buildSelectDocumentScript(documentRef: DocumentRef | undefined): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
app.activeDocument = doc;
return {
  selected: true,
  document: psGetDocumentInfo(doc, false, 0, 'summary')
};
  `.trim();
}

export function buildSelectLayerScript(
  documentRef: DocumentRef | undefined,
  layerRef: LayerRef | undefined
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
app.activeDocument = doc;
var layer = psResolveLayer(doc, ${serializeLayerRef(layerRef)});
doc.activeLayer = layer;
return {
  selected: true,
  document: psGetDocumentInfo(doc, false, 0, false),
  layer: psGetLayerInfo(layer, 0)
};
  `.trim();
}

export function buildSelectHistoryStateScript(
  documentRef: DocumentRef | undefined,
  stateRef: string | number
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var target = null;

if (typeof ${toExtendScriptValue(stateRef)} === 'number') {
  var index = psNormalizeIndex(${toExtendScriptValue(stateRef)});
  if (index >= 0 && index < doc.historyStates.length) {
    target = doc.historyStates[index];
  }
} else {
  for (var i = 0; i < doc.historyStates.length; i++) {
    if (doc.historyStates[i].name === ${toExtendScriptValue(String(stateRef))}) {
      target = doc.historyStates[i];
      break;
    }
  }
}

if (!target) {
  throw new Error('History state not found');
}

doc.activeHistoryState = target;
return {
  selected: true,
  document: psGetDocumentInfo(doc, false, 0, false),
  history: psGetHistoryInfo(doc, true)
};
  `.trim();
}

export function buildDuplicateDocumentScript(
  documentRef: DocumentRef | undefined,
  newName?: string
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var duplicate = doc.duplicate(${toExtendScriptValue(newName ?? null)});
return {
  originalDocument: psGetDocumentInfo(doc, false, 0, false),
  duplicateDocument: psGetDocumentInfo(duplicate, false, 0, false)
};
  `.trim();
}

export function buildResizeCanvasScript(
  documentRef: DocumentRef | undefined,
  width: number,
  height: number
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
doc.resizeCanvas(UnitValue(${width}, 'px'), UnitValue(${height}, 'px'), AnchorPosition.MIDDLECENTER);
return {
  document: psGetDocumentInfo(doc, false, 0, false)
};
  `.trim();
}

export function buildSaveCopyScript(
  documentRef: DocumentRef | undefined,
  path: string,
  format: 'PSD' | 'JPEG' | 'PNG',
  quality: number
): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
var saveFile = new File(${toExtendScriptValue(path)});
var format = ${toExtendScriptValue(format)};

if (format === 'JPEG') {
  var jpegOptions = new JPEGSaveOptions();
  jpegOptions.quality = ${quality};
  jpegOptions.embedColorProfile = true;
  doc.saveAs(saveFile, jpegOptions, true);
} else if (format === 'PNG') {
  var pngOptions = new PNGSaveOptions();
  pngOptions.compression = 9;
  doc.saveAs(saveFile, pngOptions, true);
} else {
  var psdOptions = new PhotoshopSaveOptions();
  psdOptions.embedColorProfile = true;
  doc.saveAs(saveFile, psdOptions, true);
}

return {
  document: psGetDocumentInfo(doc, false, 0, false),
  outputPath: saveFile.fsName,
  format: format
};
  `.trim();
}

export function buildCheckpointMarkerScript(documentRef?: DocumentRef): string {
  return `
${baseHelpers}
var doc = psResolveDocument(${serializeDocumentRef(documentRef)});
return {
  document: psGetDocumentInfo(doc, false, 0, false),
  historyStateName: psSafeCall(function() { return doc.activeHistoryState.name; }, null)
};
  `.trim();
}
