/**
 * Helper functions for ExtendScript API
 * ExtendScript is the legacy scripting API for Photoshop
 */
import { toExtendScriptValue } from '../core/serializer.js';

const scriptValue = (value: string | number | boolean | null | undefined): string =>
  toExtendScriptValue(value as string | number | boolean | null | undefined);

/**
 * Helper functions for character/string ID conversion
 */
const helperFunctions = `
function cTID(s) { return app.charIDToTypeID(s); }
function sTID(s) { return app.stringIDToTypeID(s); }
`;

/**
 * Helper function to get current context information
 */
const getContextInfo = `
function getContextInfo() {
  var context = {
    hasDocument: app.documents.length > 0
  };
  
  function readSelectionBounds(doc) {
    try {
      var bounds = doc.selection.bounds;
      return {
        left: bounds[0].as('px'),
        top: bounds[1].as('px'),
        right: bounds[2].as('px'),
        bottom: bounds[3].as('px')
      };
    } catch (error) {
      return null;
    }
  }

  if (context.hasDocument) {
    var doc = app.activeDocument;
    var selectionBounds = readSelectionBounds(doc);
    context.document = {
      name: doc.name,
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      resolution: doc.resolution,
      colorMode: String(doc.mode),
      layerCount: doc.layers.length,
      hasSelection: selectionBounds !== null,
      selectionBounds: selectionBounds
    };
    
    if (doc.activeLayer) {
      var layer = doc.activeLayer;
      context.activeLayer = {
        name: layer.name,
        kind: String(layer.kind),
        opacity: layer.opacity,
        blendMode: String(layer.blendMode),
        visible: layer.visible,
        locked: layer.allLocked,
        isBackground: layer.isBackgroundLayer
      };
      
      // Add bounds if available
      try {
        var bounds = layer.bounds;
        context.activeLayer.bounds = {
          left: bounds[0].as('px'),
          top: bounds[1].as('px'),
          right: bounds[2].as('px'),
          bottom: bounds[3].as('px')
        };
      } catch (e) {
        // Bounds not available for some layer types
      }
    }
  }
  
  return context;
}
`;

/**
 * Common ExtendScript snippets
 */
export const ExtendScriptSnippets = {
  /**
   * Get Photoshop application info
   */
  getAppInfo: () => `
    return {
      name: app.name,
      version: app.version,
      build: app.build
    };
  `,

  /**
   * Create a new document
   */
  newDocument: (width: number, height: number, resolution = 72, colorMode = 'NewDocumentMode.RGB') => `
    var doc = app.documents.add(
      UnitValue(${width}, 'px'),
      UnitValue(${height}, 'px'),
      ${resolution},
      'New Document',
      ${colorMode}
    );
    return { id: doc.id, name: doc.name };
  `,

  /**
   * Get active document info
   */
  getDocumentInfo: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var context = getContextInfo();
    return context;
  `,

  /**
   * Create a text layer
   */
  createTextLayer: (text: string, x = 100, y = 100, fontSize = 24) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var textLayer = doc.artLayers.add();
    textLayer.kind = LayerKind.TEXT;
    textLayer.textItem.contents = ${scriptValue(text)};
    textLayer.textItem.position = [${x}, ${y}];
    textLayer.textItem.size = ${fontSize};
    
    var result = {
      created: true,
      layerName: textLayer.name,
      text: ${scriptValue(text)},
      position: { x: ${x}, y: ${y} },
      fontSize: ${fontSize},
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Place an image file as a layer
   */
  placeImage: (filePath: string, x = 0, y = 0) => `
    ${helperFunctions}
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var imageFile = new File(${scriptValue(filePath)});
    if (!imageFile.exists) {
      throw new Error('Image file not found: ' + ${scriptValue(filePath)});
    }
    
    // Place image using ActionDescriptor
    var desc = new ActionDescriptor();
    desc.putPath(cTID('null'), imageFile);
    desc.putEnumerated(cTID('FTcs'), cTID('QCSt'), cTID('Qcsa'));
    
    var offsetDesc = new ActionDescriptor();
    offsetDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), ${x});
    offsetDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ${y});
    desc.putObject(cTID('Ofst'), cTID('Ofst'), offsetDesc);
    
    executeAction(cTID('Plc '), desc, DialogModes.NO);
    
    var layer = app.activeDocument.activeLayer;
    var result = { 
      placed: true,
      layerName: layer.name,
      filePath: ${scriptValue(filePath)},
      position: { x: ${x}, y: ${y} },
      layerBounds: {
        width: layer.bounds[2].as('px') - layer.bounds[0].as('px'),
        height: layer.bounds[3].as('px') - layer.bounds[1].as('px')
      },
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Open an image file as a new document
   */
  openImage: (filePath: string) => `
    var imageFile = new File(${scriptValue(filePath)});
    if (!imageFile.exists) {
      throw new Error('Image file not found: ' + ${scriptValue(filePath)});
    }
    
    var doc = app.open(imageFile);
    return {
      id: doc.id,
      name: doc.name,
      width: doc.width.as('px'),
      height: doc.height.as('px')
    };
  `,

  /**
   * Save document as PSD
   */
  saveAsPSD: (path: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${scriptValue(path)});
    var psdOptions = new PhotoshopSaveOptions();
    psdOptions.embedColorProfile = true;
    doc.saveAs(saveFile, psdOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Save document as JPEG
   */
  saveAsJPEG: (path: string, quality = 8) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${scriptValue(path)});
    var jpegOptions = new JPEGSaveOptions();
    jpegOptions.quality = ${quality};
    jpegOptions.embedColorProfile = true;
    doc.saveAs(saveFile, jpegOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Save document as PNG
   */
  saveAsPNG: (path: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${scriptValue(path)});
    var pngOptions = new PNGSaveOptions();
    pngOptions.compression = 9;
    doc.saveAs(saveFile, pngOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Close active document
   */
  closeDocument: (save = false) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.close(${save ? 'SaveOptions.SAVECHANGES' : 'SaveOptions.DONOTSAVECHANGES'});
    return { closed: true };
  `,

  /**
   * Create a new layer
   */
  newLayer: (name?: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.artLayers.add();
    ${name ? `layer.name = ${scriptValue(name)};` : ''}
    
    var result = { 
      created: true,
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Delete active layer
   */
  deleteLayer: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    if (doc.activeLayer) {
      doc.activeLayer.remove();
      return { deleted: true };
    }
    throw new Error('No active layer');
  `,

  /**
   * Fill layer with color
   */
  fillLayer: (red: number, green: number, blue: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var color = new SolidColor();
    color.rgb.red = ${red};
    color.rgb.green = ${green};
    color.rgb.blue = ${blue};
    doc.selection.selectAll();
    doc.selection.fill(color, ColorBlendMode.NORMAL, 100, false);
    doc.selection.deselect();
    return { filled: true, color: { red: ${red}, green: ${green}, blue: ${blue} } };
  `,

  /**
   * Resize image
   */
  resizeImage: (width: number, height: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.resizeImage(
      UnitValue(${width}, 'px'),
      UnitValue(${height}, 'px'),
      null,
      ResampleMethod.BICUBIC
    );
    return { 
      width: doc.width.as('px'), 
      height: doc.height.as('px') 
    };
  `,

  /**
   * Get all layer names
   */
  getLayerNames: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layers = [];
    for (var i = 0; i < doc.layers.length; i++) {
      var layer = doc.layers[i];
      layers.push({
        name: layer.name,
        kind: String(layer.kind),
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: String(layer.blendMode)
      });
    }
    
    var result = {
      layerCount: layers.length,
      layers: layers,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Select layer by name
   */
  selectLayer: (name: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].name === ${scriptValue(name)}) {
        doc.activeLayer = doc.layers[i];
        return { selected: true, name: doc.layers[i].name };
      }
    }
    throw new Error('Layer not found: ' + ${scriptValue(name)});
  `,

  /**
   * Scale active layer to fit document (maintain aspect ratio)
   */
  fitLayerToDocument: (fillDocument = false) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot transform background layer');
    }
    
    // Get canvas dimensions
    var canvasWidth = doc.width.as('px');
    var canvasHeight = doc.height.as('px');
    
    // Get layer bounds
    var bounds = layer.bounds;
    var layerWidth = bounds[2].as('px') - bounds[0].as('px');
    var layerHeight = bounds[3].as('px') - bounds[1].as('px');
    
    // Calculate scale ratios
    var widthRatio = canvasWidth / layerWidth;
    var heightRatio = canvasHeight / layerHeight;
    
    // Choose scale factor based on fill or fit mode
    var scaleFactor;
    if (${fillDocument}) {
      // Fill: scale to cover entire canvas (may crop)
      scaleFactor = Math.max(widthRatio, heightRatio);
    } else {
      // Fit: scale to fit within canvas (may have margins)
      scaleFactor = Math.min(widthRatio, heightRatio);
    }
    
    // Apply scale
    var scalePercent = scaleFactor * 100;
    layer.resize(scalePercent, scalePercent, AnchorPosition.MIDDLECENTER);
    
    // Center the layer
    layer.translate(
      canvasWidth / 2 - (bounds[0].as('px') + layerWidth / 2),
      canvasHeight / 2 - (bounds[1].as('px') + layerHeight / 2)
    );
    
    var result = {
      fitted: true,
      mode: ${fillDocument} ? 'fill' : 'fit',
      originalSize: { width: layerWidth, height: layerHeight },
      newSize: { 
        width: layerWidth * scaleFactor, 
        height: layerHeight * scaleFactor 
      },
      scaleFactor: scaleFactor,
      scalePercent: scalePercent,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Scale active layer by percentage
   */
  scaleLayer: (scalePercent: number, centerAnchor = true) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot transform background layer');
    }
    
    var anchor = ${centerAnchor ? 'AnchorPosition.MIDDLECENTER' : 'AnchorPosition.TOPLEFT'};
    layer.resize(${scalePercent}, ${scalePercent}, anchor);
    
    return { 
      scaled: true,
      percent: ${scalePercent}
    };
  `,

  /**
   * Move/translate active layer
   */
  moveLayer: (deltaX: number, deltaY: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot move background layer');
    }
    
    layer.translate(${deltaX}, ${deltaY});
    
    return { 
      moved: true,
      deltaX: ${deltaX},
      deltaY: ${deltaY}
    };
  `,

  /**
   * Rotate active layer
   */
  rotateLayer: (degrees: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot rotate background layer');
    }
    
    layer.rotate(${degrees}, AnchorPosition.MIDDLECENTER);
    
    return { 
      rotated: true,
      degrees: ${degrees}
    };
  `,

  /**
   * Set layer opacity
   */
  setLayerOpacity: (opacity: number) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.opacity = ${opacity};
    
    var result = { 
      updated: true,
      property: 'opacity',
      value: layer.opacity,
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Set layer blend mode
   */
  setLayerBlendMode: (blendMode: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.blendMode = BlendMode.${blendMode};
    
    var result = { 
      updated: true,
      property: 'blendMode',
      value: String(layer.blendMode),
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Set layer visibility
   */
  setLayerVisibility: (visible: boolean) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.visible = ${visible};
    
    return { 
      visible: layer.visible,
      name: layer.name
    };
  `,

  /**
   * Lock/unlock layer
   */
  setLayerLocked: (locked: boolean) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.allLocked = ${locked};
    
    return { 
      locked: layer.allLocked,
      name: layer.name
    };
  `,

  /**
   * Rename active layer
   */
  renameLayer: (newName: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    var oldName = layer.name;
    layer.name = ${scriptValue(newName)};
    
    return { 
      oldName: oldName,
      newName: layer.name
    };
  `,

  /**
   * Duplicate active layer
   */
  duplicateLayer: (newName?: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    var duplicated = layer.duplicate();
    ${newName ? `duplicated.name = ${scriptValue(newName)};` : ''}
    
    return { 
      originalName: layer.name,
      newName: duplicated.name
    };
  `,

  /**
   * Merge visible layers
   */
  mergeVisibleLayers: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.mergeVisibleLayers();
    
    return { 
      merged: true
    };
  `,

  /**
   * Flatten image (merge all layers)
   */
  flattenImage: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.flatten();
    
    return { 
      flattened: true
    };
  `,

  /**
   * Apply Gaussian Blur filter
   */
  applyGaussianBlur: (radius: number) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    var wasRasterized = false;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
      wasRasterized = true;
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers. Layer kind: ' + layer.kind);
    }
    
    layer.applyGaussianBlur(${radius});
    
    var result = { 
      applied: true,
      filter: 'Gaussian Blur',
      radius: ${radius},
      wasRasterized: wasRasterized,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Apply Unsharp Mask (sharpen)
   */
  applyUnsharpMask: (amount: number, radius: number, threshold: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    layer.applyUnSharpMask(${amount}, ${radius}, ${threshold});
    
    return { 
      filter: 'Unsharp Mask',
      amount: ${amount},
      radius: ${radius},
      threshold: ${threshold}
    };
  `,

  /**
   * Apply Add Noise filter
   */
  applyAddNoise: (amount: number, distribution: string, monochromatic: boolean) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    var distEnum = NoiseDistribution.${distribution};
    layer.applyAddNoise(${amount}, distEnum, ${monochromatic});
    
    return { 
      filter: 'Add Noise',
      amount: ${amount},
      distribution: '${distribution}',
      monochromatic: ${monochromatic}
    };
  `,

  /**
   * Apply Motion Blur filter
   */
  applyMotionBlur: (angle: number, radius: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    layer.applyMotionBlur(${angle}, ${radius});
    
    return { 
      filter: 'Motion Blur',
      angle: ${angle},
      radius: ${radius}
    };
  `,

  /**
   * Adjust brightness and contrast
   */
  adjustBrightnessContrast: (brightness: number, contrast: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.adjustBrightnessContrast(${brightness}, ${contrast});
    
    return { 
      adjustment: 'Brightness/Contrast',
      brightness: ${brightness},
      contrast: ${contrast}
    };
  `,

  /**
   * Adjust hue and saturation
   */
  adjustHueSaturation: (hue: number, saturation: number, lightness: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Match the same rasterization behavior as the other per-layer adjustments.
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }

    var desc = new ActionDescriptor();
    desc.putBoolean(charIDToTypeID('Clrz'), false);

    var adjustments = new ActionList();
    var adjustment = new ActionDescriptor();
    adjustment.putInteger(charIDToTypeID('H   '), ${hue});
    adjustment.putInteger(charIDToTypeID('Strt'), ${saturation});
    adjustment.putInteger(charIDToTypeID('Lght'), ${lightness});
    adjustments.putObject(charIDToTypeID('Hst2'), adjustment);

    desc.putList(charIDToTypeID('Adjs'), adjustments);
    executeAction(charIDToTypeID('HStr'), desc, DialogModes.NO);
    
    return { 
      adjustment: 'Hue/Saturation',
      hue: ${hue},
      saturation: ${saturation},
      lightness: ${lightness}
    };
  `,

  /**
   * Auto levels adjustment
   */
  autoLevels: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.autoLevels();
    
    return { 
      adjustment: 'Auto Levels'
    };
  `,

  /**
   * Auto contrast adjustment
   */
  autoContrast: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.autoContrast();
    
    return { 
      adjustment: 'Auto Contrast'
    };
  `,

  /**
   * Desaturate (convert to grayscale without changing color mode)
   */
  desaturate: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.desaturate();
    
    return { 
      adjustment: 'Desaturate'
    };
  `,

  /**
   * Invert colors
   */
  invert: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.invert();
    
    return { 
      adjustment: 'Invert'
    };
  `,

  /**
   * Crop document
   */
  cropDocument: (left: number, top: number, right: number, bottom: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    var bounds = [${left}, ${top}, ${right}, ${bottom}];
    doc.crop(bounds);
    
    return { 
      cropped: true,
      newWidth: doc.width.as('px'),
      newHeight: doc.height.as('px')
    };
  `,

  /**
   * Set text layer font
   */
  setTextFont: (fontName: string, fontSize?: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.font = ${scriptValue(fontName)};
    ${fontSize ? `layer.textItem.size = ${fontSize};` : ''}
    
    return { 
      font: layer.textItem.font,
      size: layer.textItem.size
    };
  `,

  /**
   * Set text color
   */
  setTextColor: (red: number, green: number, blue: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    var color = new SolidColor();
    color.rgb.red = ${red};
    color.rgb.green = ${green};
    color.rgb.blue = ${blue};
    layer.textItem.color = color;
    
    return { 
      color: 'RGB(' + ${red} + ', ' + ${green} + ', ' + ${blue} + ')'
    };
  `,

  /**
   * Set text alignment
   */
  setTextAlignment: (alignment: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.justification = Justification.${alignment};
    
    return { 
      alignment: '${alignment}'
    };
  `,

  /**
   * Update text content
   */
  updateTextContent: (newText: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.contents = ${scriptValue(newText)};
    
    return { 
      text: layer.textItem.contents
    };
  `,

  /**
   * Create rectangular selection
   */
  selectRectangle: (left: number, top: number, right: number, bottom: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    var bounds = [[${left}, ${top}], [${right}, ${top}], [${right}, ${bottom}], [${left}, ${bottom}]];
    doc.selection.select(bounds);
    
    return { 
      selection: 'rectangle',
      bounds: [${left}, ${top}, ${right}, ${bottom}]
    };
  `,

  /**
   * Select all
   */
  selectAll: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.selectAll();
    
    return { 
      selection: 'all'
    };
  `,

  /**
   * Deselect
   */
  deselect: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.deselect();
    
    return { 
      deselected: true
    };
  `,

  /**
   * Invert selection
   */
  invertSelection: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.invert();
    
    return { 
      inverted: true
    };
  `,

  /**
   * Create layer mask from selection
   */
  createLayerMask: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }

    var s2t = function (value) {
      return app.stringIDToTypeID(value);
    };
    var descriptor = new ActionDescriptor();
    var reference = new ActionReference();
    descriptor.putClass(s2t('new'), s2t('channel'));
    reference.putEnumerated(s2t('channel'), s2t('channel'), s2t('mask'));
    descriptor.putReference(s2t('at'), reference);
    descriptor.putEnumerated(
      s2t('using'),
      s2t('userMaskEnabled'),
      s2t('revealSelection')
    );
    executeAction(s2t('make'), descriptor, DialogModes.NO);
    
    return { 
      maskCreated: true
    };
  `,

  /**
   * Delete layer mask
   */
  deleteLayerMask: () => `
    ${helperFunctions}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    desc.putBoolean(cTID('Aply'), false);
    executeAction(cTID('Dlt '), desc, DialogModes.NO);
    
    return { 
      maskDeleted: true
    };
  `,

  /**
   * Apply layer mask
   */
  applyLayerMask: () => `
    ${helperFunctions}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    desc.putBoolean(cTID('Aply'), true);
    executeAction(cTID('Dlt '), desc, DialogModes.NO);
    
    return { 
      maskApplied: true
    };
  `,

  /**
   * Rasterize active layer
   */
  rasterizeLayer: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind === LayerKind.NORMAL) {
      return { 
        message: 'Layer is already rasterized',
        kind: 'NORMAL'
      };
    }
    
    var originalKind = String(layer.kind);
    layer.rasterize(RasterizeType.ENTIRELAYER);
    
    return { 
      rasterized: true,
      originalKind: originalKind,
      newKind: 'NORMAL'
    };
  `,

  /**
   * Undo last operation (step backward in history)
   */
  undo: (steps = 1) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    // Get current history state index
    var currentIndex = -1;
    for (var i = 0; i < doc.historyStates.length; i++) {
      if (doc.historyStates[i] === doc.activeHistoryState) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1) {
      throw new Error('Could not find current history state');
    }
    
    // Calculate target index
    var targetIndex = Math.max(0, currentIndex - ${steps});
    
    // Set active history state to go back
    if (targetIndex < doc.historyStates.length) {
      doc.activeHistoryState = doc.historyStates[targetIndex];
    }
    
    var result = {
      undone: true,
      steps: currentIndex - targetIndex,
      currentHistoryState: doc.activeHistoryState.name,
      remainingStates: currentIndex - targetIndex,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Redo operation (step forward in history)
   */
  redo: (steps = 1) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    // Get current history state index
    var currentIndex = -1;
    for (var i = 0; i < doc.historyStates.length; i++) {
      if (doc.historyStates[i] === doc.activeHistoryState) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1) {
      throw new Error('Could not find current history state');
    }
    
    // Calculate target index
    var targetIndex = Math.min(doc.historyStates.length - 1, currentIndex + ${steps});
    
    // Set active history state to go forward
    if (targetIndex >= 0) {
      doc.activeHistoryState = doc.historyStates[targetIndex];
    }
    
    var result = {
      redone: true,
      steps: targetIndex - currentIndex,
      currentHistoryState: doc.activeHistoryState.name,
      availableRedoSteps: doc.historyStates.length - 1 - targetIndex,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Get history states
   */
  getHistoryStates: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    var states = [];
    var currentIndex = -1;
    
    for (var i = 0; i < doc.historyStates.length; i++) {
      var state = doc.historyStates[i];
      states.push({
        name: state.name,
        snapshot: state.snapshot || false
      });
      
      if (state === doc.activeHistoryState) {
        currentIndex = i;
      }
    }
    
    var result = {
      totalStates: states.length,
      currentIndex: currentIndex,
      currentState: currentIndex >= 0 ? states[currentIndex].name : 'Unknown',
      canUndo: currentIndex > 0,
      canRedo: currentIndex < states.length - 1,
      states: states,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to specific position (reorder)
   */
  moveLayerToPosition: (targetLayerId: number, position: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var activeLayer = doc.activeLayer;
    
    // Find target layer
    var targetLayer = null;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].id === ${targetLayerId}) {
        targetLayer = doc.layers[i];
        break;
      }
    }
    
    if (!targetLayer) {
      throw new Error('Target layer not found: ' + ${targetLayerId});
    }

    if (activeLayer === targetLayer) {
      return {
        moved: false,
        message: 'Active layer already matches the target layer',
        context: getContextInfo()
      };
    }

    if ("${position}" === "ABOVE") {
      activeLayer.move(targetLayer, ElementPlacement.PLACEBEFORE);
    } else if ("${position}" === "BELOW") {
      if (targetLayer.isBackgroundLayer) {
        activeLayer.move(targetLayer, ElementPlacement.PLACEBEFORE);
      } else {
        activeLayer.move(targetLayer, ElementPlacement.PLACEAFTER);
      }
    } else if ("${position}" === "TOP") {
      if (activeLayer !== doc.layers[0]) {
        activeLayer.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
      }
    } else if ("${position}" === "BOTTOM") {
      var bottomTarget = null;
      for (var bottomIndex = doc.layers.length - 1; bottomIndex >= 0; bottomIndex--) {
        if (doc.layers[bottomIndex] !== activeLayer) {
          bottomTarget = doc.layers[bottomIndex];
          break;
        }
      }

      if (!bottomTarget) {
        return {
          moved: false,
          message: 'No alternate bottom target was available',
          context: getContextInfo()
        };
      }

      if (bottomTarget.isBackgroundLayer) {
        activeLayer.move(bottomTarget, ElementPlacement.PLACEBEFORE);
      } else {
        activeLayer.move(bottomTarget, ElementPlacement.PLACEAFTER);
      }
    } else {
      throw new Error('Invalid position. Use: ABOVE, BELOW, TOP, or BOTTOM');
    }
    
    var result = {
      moved: true,
      layerName: activeLayer.name,
      position: "${position}",
      relativeTo: targetLayer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to top of layer stack
   */
  moveLayerToTop: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.isBackgroundLayer || doc.layers.length <= 1 || doc.layers[0] === layer) {
      return {
        moved: false,
        message: 'Layer is already at the top editable position',
        context: getContextInfo()
      };
    }

    layer.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
    
    var result = {
      moved: true,
      layerName: layer.name,
      position: 'top',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to bottom of layer stack
   */
  moveLayerToBottom: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.isBackgroundLayer || doc.layers.length <= 1) {
      return {
        moved: false,
        message: 'Layer is already at the bottom editable position',
        context: getContextInfo()
      };
    }

    var targetLayer = null;
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      if (doc.layers[i] !== layer) {
        targetLayer = doc.layers[i];
        break;
      }
    }

    if (!targetLayer) {
      return {
        moved: false,
        message: 'No alternate bottom target was available',
        context: getContextInfo()
      };
    }

    if (targetLayer.isBackgroundLayer) {
      layer.move(targetLayer, ElementPlacement.PLACEBEFORE);
    } else {
      layer.move(targetLayer, ElementPlacement.PLACEAFTER);
    }
    
    var result = {
      moved: true,
      layerName: layer.name,
      position: 'bottom',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer up one position
   */
  moveLayerUp: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    // Find current layer index
    var currentIndex = -1;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i] === layer) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex <= 0) {
      return {
        moved: false,
        message: 'Layer is already at the top',
        context: getContextInfo()
      };
    }
    
    // Move before the layer above
    layer.move(doc.layers[currentIndex - 1], ElementPlacement.PLACEBEFORE);
    
    var result = {
      moved: true,
      layerName: layer.name,
      direction: 'up',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer down one position
   */
  moveLayerDown: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    // Find current layer index
    var currentIndex = -1;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i] === layer) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1 || currentIndex >= doc.layers.length - 1) {
      return {
        moved: false,
        message: 'Layer is already at the bottom editable position',
        context: getContextInfo()
      };
    }

    var belowLayer = doc.layers[currentIndex + 1];
    if (belowLayer.isBackgroundLayer) {
      return {
        moved: false,
        message: 'Layer is already at the bottom editable position',
        context: getContextInfo()
      };
    }

    // Move after the layer below
    layer.move(belowLayer, ElementPlacement.PLACEAFTER);
    
    var result = {
      moved: true,
      layerName: layer.name,
      direction: 'down',
      context: getContextInfo()
    };
    return result;
  `,
};

/**
 * Generate ExtendScript code with error handling
 */
export function generateExtendScript(code: string): string {
  return `
(function() {
  try {
    ${code}
  } catch (error) {
    return 'ERROR: ' + (error.message || String(error));
  }
})();
  `.trim();
}
