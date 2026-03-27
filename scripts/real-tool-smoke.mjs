import { access, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PhotoshopMCPServer } from '../dist/core/server.js';

const server = new PhotoshopMCPServer();
const registry = server.toolRegistry;
const session = server.session;
const connection = session.getConnection();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTION_FIXTURE_PATH = path.join(
  SCRIPT_DIR,
  '..',
  'fixtures',
  'actions',
  'mcp-smoke-actions-palette.psp'
);
const SMOKE_ACTION_SET_NAME = 'MCP Smoke';
const SMOKE_ACTION_NAME = '動作 1';

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  outputDir: '',
  reportPath: '',
  fatalError: null,
  summary: {
    totalTools: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    missing: 0,
  },
  outcomes: {},
  setupEvents: [],
};

const ctx = {
  outputDir: '',
  fixturePngPath: '',
  mainSavePath: '',
  mainCopyPath: '',
  mainExportPath: '',
  windowSnapshotPath: '',
  canvasSnapshotPath: '',
  reportPath: '',
  mainDocId: null,
  mainDocName: null,
  duplicateDocName: null,
  currentFont: null,
};

function textFromResult(result) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
    .trim();
}

function envelopeFromResult(result) {
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : null;
}

function dataFromResult(result) {
  return envelopeFromResult(result)?.data ?? null;
}

function addSetupEvent(name, status, detail) {
  report.setupEvents.push({
    ts: new Date().toISOString(),
    name,
    status,
    detail,
  });
}

function markOutcome(name, status, args, result, durationMs, extra = {}) {
  if (report.outcomes[name]) {
    return;
  }

  report.outcomes[name] = {
    status,
    durationMs,
    args,
    text: result?.text ?? null,
    structured: result?.structured ?? null,
    ...extra,
  };
}

function markSkipped(name, reason, args = {}) {
  markOutcome(
    name,
    'skipped',
    args,
    {
      text: reason,
      structured: { reason },
    },
    0
  );
}

async function runTool(name, args = {}, options = {}) {
  const started = Date.now();

  try {
    const result = await registry.execute(name, args);
    const parsed = {
      text: textFromResult(result),
      structured: envelopeFromResult(result),
      isError: Boolean(result.isError),
    };

    let status =
      options.expectError === true
        ? parsed.isError
          ? 'passed'
          : 'failed'
        : parsed.isError
          ? 'failed'
          : 'passed';

    if (status === 'passed' && typeof options.postCheck === 'function') {
      await options.postCheck(parsed);
    }

    if (options.count !== false) {
      markOutcome(name, status, args, parsed, Date.now() - started, {
        expectedError: Boolean(options.expectError),
      });
    } else {
      addSetupEvent(name, status, parsed.text);
    }

    if (status === 'failed' && options.allowFailure !== true) {
      throw new Error(`${name} failed: ${parsed.text}`);
    }

    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);

    if (options.count !== false) {
      markOutcome(
        name,
        options.expectError ? 'passed' : 'failed',
        args,
        { text, structured: null },
        Date.now() - started,
        {
          thrown: true,
          expectedError: Boolean(options.expectError),
        }
      );
    } else {
      addSetupEvent(name, options.expectError ? 'passed' : 'failed', text);
    }

    if (options.allowFailure === true || options.expectError === true) {
      return {
        isError: true,
        content: [{ type: 'text', text }],
      };
    }

    throw error;
  }
}

async function assertFileExists(filePath, label) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} did not create the expected file: ${filePath}`);
  }
}

async function getState(detail = 'normal') {
  const result = await runTool(
    'photoshop_get_state',
    { responseDetail: detail },
    { count: false }
  );
  return dataFromResult(result);
}

async function getActiveLayerInfo() {
  const result = await runTool(
    'photoshop_get_layer_info',
    {
      documentRef: { by: 'active' },
      layerRef: { by: 'active' },
      responseDetail: 'full',
    },
    { count: false }
  );

  return dataFromResult(result)?.layer ?? null;
}

async function updateMainDocContext() {
  const state = await getState('normal');
  if (state?.activeDocument) {
    ctx.mainDocId ??= state.activeDocument.id;
    ctx.mainDocName ??= state.activeDocument.name;
  }
}

async function ensureMainDocumentSelected() {
  if (!ctx.mainDocId) {
    throw new Error('Main document id is not available.');
  }

  await runTool(
    'photoshop_select_document',
    { documentRef: { by: 'id', value: ctx.mainDocId } },
    { count: false }
  );
}

async function selectLayerByName(name, count = false) {
  await runTool(
    'photoshop_select_layer',
    {
      documentRef: { by: 'active' },
      layerRef: { by: 'name', value: name },
    },
    { count }
  );
}

async function createNamedLayer(name, count = false) {
  await runTool('photoshop_create_layer', { name }, { count });
}

async function getCurrentHistoryStateName() {
  const value = await connection.executeScript(`
(function() {
  if (!app.documents.length) {
    return '';
  }
  return app.activeDocument.activeHistoryState.name;
})();
  `);

  return String(value || '');
}

async function getInstalledActions() {
  const result = await runTool('photoshop_list_actions');
  return dataFromResult(result)?.actions ?? [];
}

function hasSmokeActionFixture(actions) {
  return actions.some(
    (action) =>
      action.actionSetName === SMOKE_ACTION_SET_NAME &&
      action.actionName === SMOKE_ACTION_NAME
  );
}

async function loadSmokeActionFixture() {
  await access(ACTION_FIXTURE_PATH);

  const result = await connection.executeScript(
    `
(function() {
  var fixtureFile = new File(${JSON.stringify(ACTION_FIXTURE_PATH)});
  if (!fixtureFile.exists) {
    throw new Error('Smoke action fixture not found: ' + fixtureFile.fsName);
  }

  app.load(fixtureFile);
  return fixtureFile.fsName;
})();
    `,
    30000
  );

  addSetupEvent(
    'load-smoke-action-fixture',
    'passed',
    `Loaded action fixture from ${String(result || ACTION_FIXTURE_PATH)}`
  );
}

function scoreActionCandidate(action) {
  const name = String(action.actionName || '');
  let score = 0;

  if (/灰階|深褐|四分色|白熱化/i.test(name)) {
    score += 20;
  }

  if (/圖層/i.test(name)) {
    score += 5;
  }

  if (/另存為|淡出|邊框|漸層對應|複製繪圖設定/i.test(name)) {
    score -= 20;
  }

  if (/文字/i.test(name)) {
    score -= 5;
  }

  return score;
}

function prioritizeActionCandidates(actions) {
  return [...actions].sort((left, right) => {
    const scoreDiff = scoreActionCandidate(right) - scoreActionCandidate(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return String(left.actionName || '').localeCompare(String(right.actionName || ''));
  });
}

async function exerciseActionPlayback() {
  let actions = await getInstalledActions();

  if (!hasSmokeActionFixture(actions)) {
    try {
      await loadSmokeActionFixture();
      actions = await getInstalledActions();
    } catch (error) {
      markOutcome(
        'photoshop_play_action',
        'failed',
        {
          actionName: SMOKE_ACTION_NAME,
          actionSetName: SMOKE_ACTION_SET_NAME,
          fixturePath: ACTION_FIXTURE_PATH,
        },
        {
          text:
            error instanceof Error
              ? error.message
              : `Unable to load smoke action fixture from ${ACTION_FIXTURE_PATH}`,
          structured: null,
        },
        0,
        {
          fixturePath: ACTION_FIXTURE_PATH,
        }
      );
      return;
    }
  }

  await runTool(
    'photoshop_snapshot_checkpoint',
    {
      name: 'action-playback-point',
      documentRef: { by: 'active' },
    },
    { count: false }
  );

  if (!hasSmokeActionFixture(actions)) {
    markOutcome(
      'photoshop_play_action',
      'failed',
      {
        actionName: SMOKE_ACTION_NAME,
        actionSetName: SMOKE_ACTION_SET_NAME,
        fixturePath: ACTION_FIXTURE_PATH,
      },
      {
        text: `Smoke action fixture did not register "${SMOKE_ACTION_SET_NAME}" / "${SMOKE_ACTION_NAME}" after loading ${ACTION_FIXTURE_PATH}.`,
        structured: null,
      },
      0,
      {
        availableActions: prioritizeActionCandidates(actions),
      }
    );
    return;
  }

  await runTool(
    'photoshop_restore_checkpoint',
    { name: 'action-playback-point' },
    { count: false, allowFailure: true }
  );

  const started = Date.now();
  const result = await runTool(
    'photoshop_play_action',
    {
      actionName: SMOKE_ACTION_NAME,
      actionSetName: SMOKE_ACTION_SET_NAME,
      timeoutMs: 4000,
    },
    { count: false, allowFailure: true }
  );

  const text = textFromResult(result);
  const structured = envelopeFromResult(result);
  const durationMs = Date.now() - started;

  if (!result.isError) {
    markOutcome(
      'photoshop_play_action',
      'passed',
      {
        actionName: SMOKE_ACTION_NAME,
        actionSetName: SMOKE_ACTION_SET_NAME,
        timeoutMs: 4000,
        fixturePath: ACTION_FIXTURE_PATH,
      },
      { text, structured },
      durationMs,
      {
        fixturePath: ACTION_FIXTURE_PATH,
      }
    );
    return;
  }

  await runTool(
    'photoshop_wait_for_idle',
    {
      timeoutMs: 1500,
      intervalMs: 200,
    },
    { count: false, allowFailure: true }
  );

  markOutcome(
    'photoshop_play_action',
    'failed',
    {
      actionName: SMOKE_ACTION_NAME,
      actionSetName: SMOKE_ACTION_SET_NAME,
      timeoutMs: 4000,
      fixturePath: ACTION_FIXTURE_PATH,
    },
    { text, structured },
    durationMs,
    {
      fixturePath: ACTION_FIXTURE_PATH,
    }
  );
}

async function closeTrackedDocumentByName(name) {
  if (!name) {
    return;
  }

  await runTool(
    'photoshop_select_document',
    { documentRef: { by: 'name', value: name } },
    { count: false, allowFailure: true }
  );
  await runTool('photoshop_close_document', { save: false }, { count: false, allowFailure: true });
}

async function cleanup() {
  await closeTrackedDocumentByName(ctx.duplicateDocName);

  if (ctx.mainDocId) {
    await runTool(
      'photoshop_select_document',
      { documentRef: { by: 'id', value: ctx.mainDocId } },
      { count: false, allowFailure: true }
    );
    await runTool('photoshop_close_document', { save: false }, { count: false, allowFailure: true });
  }
}

function finalizeReport() {
  const toolNames = registry.list().map((tool) => tool.name);
  for (const name of toolNames) {
    if (!report.outcomes[name]) {
      markOutcome(
        name,
        'missing',
        {},
        { text: 'No real smoke invocation was recorded for this tool.', structured: null },
        0
      );
    }
  }

  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    missing: 0,
  };

  for (const outcome of Object.values(report.outcomes)) {
    if (outcome.status in counts) {
      counts[outcome.status] += 1;
    }
  }

  report.finishedAt = new Date().toISOString();
  report.summary.totalTools = toolNames.length;
  report.summary.passed = counts.passed;
  report.summary.failed = counts.failed;
  report.summary.skipped = counts.skipped;
  report.summary.missing = counts.missing;
}

async function runMainScenario() {
  ctx.outputDir = path.join(
    os.tmpdir(),
    `photoshop-mcp-real-smoke-${Date.now()}`
  );
  ctx.fixturePngPath = path.join(ctx.outputDir, 'fixture.png');
  ctx.mainSavePath = path.join(ctx.outputDir, 'main-doc.psd');
  ctx.mainCopyPath = path.join(ctx.outputDir, 'main-copy.jpg');
  ctx.mainExportPath = path.join(ctx.outputDir, 'main-export.png');
  ctx.windowSnapshotPath = path.join(ctx.outputDir, 'window-snapshot.png');
  ctx.canvasSnapshotPath = path.join(ctx.outputDir, 'canvas-snapshot.png');
  ctx.reportPath = path.join(ctx.outputDir, 'real-tool-report.json');
  report.outputDir = ctx.outputDir;
  report.reportPath = ctx.reportPath;

  await mkdir(ctx.outputDir, { recursive: true });
  await session.initialize();
  report.summary.totalTools = registry.list().length;

  await runTool('photoshop_ping');
  await runTool('photoshop_get_version');
  await runTool('photoshop_get_state', { responseDetail: 'minimal' });
  await runTool('photoshop_get_open_documents', { responseDetail: 'normal' });

  await runTool('photoshop_create_document', {
    width: 320,
    height: 240,
    resolution: 72,
    colorMode: 'RGB',
  });
  await updateMainDocContext();

  await runTool('photoshop_get_document_info');
  await runTool('photoshop_get_active_context', { responseDetail: 'normal' });
  await runTool('photoshop_get_document_tree', { responseDetail: 'full' });
  await runTool('photoshop_get_layer_tree', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    responseDetail: 'normal',
  });
  await runTool('photoshop_get_layer_info', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    layerRef: { by: 'active' },
    responseDetail: 'normal',
  });
  await runTool('photoshop_get_layers');
  await runTool('photoshop_assert_state', {
    requiresDocument: true,
    minimumLayerCount: 1,
  });
  await runTool('photoshop_wait_for_idle', {
    timeoutMs: 3000,
    intervalMs: 200,
  });

  await runTool(
    'photoshop_create_document',
    {
      width: 48,
      height: 48,
      resolution: 72,
      colorMode: 'RGB',
    },
    { count: false }
  );
  await runTool('photoshop_create_layer', { name: 'Fixture Layer' });
  await runTool('photoshop_fill_layer', { red: 30, green: 140, blue: 240 });
  await runTool(
    'photoshop_save_document',
    {
      path: ctx.fixturePngPath,
      format: 'PNG',
    },
    {
      postCheck: async () => {
        await assertFileExists(ctx.fixturePngPath, 'photoshop_save_document');
      },
    }
  );
  await runTool('photoshop_close_document', { save: false });
  await runTool('photoshop_select_document', {
    documentRef: { by: 'id', value: ctx.mainDocId },
  });

  await runTool('photoshop_open_image', { filePath: ctx.fixturePngPath });
  await runTool('photoshop_close_document', { save: false }, { count: false });
  await ensureMainDocumentSelected();

  await runTool('photoshop_place_image', {
    filePath: ctx.fixturePngPath,
    x: 30,
    y: 20,
  });
  await runTool('photoshop_rename_layer', { name: 'Placed Layer' });
  await runTool('photoshop_fit_layer_to_document', { fillDocument: false });
  await runTool('photoshop_scale_layer', { scalePercent: 65, centerAnchor: true });
  await runTool('photoshop_move_layer', { deltaX: 12, deltaY: 8 });
  await runTool('photoshop_rotate_layer', { degrees: 18 });

  await runTool('photoshop_create_text_layer', {
    text: 'Smoke Text',
    x: 80,
    y: 120,
    fontSize: 24,
  });
  const textLayer = await getActiveLayerInfo();
  ctx.currentFont = textLayer?.textInfo?.font || 'ArialMT';
  await runTool('photoshop_find_text_layers', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    query: 'Smoke',
    matchMode: 'contains',
  });
  await runTool('photoshop_set_text_font', {
    fontName: ctx.currentFont,
    fontSize: 28,
  });
  await runTool('photoshop_set_text_color', {
    red: 240,
    green: 50,
    blue: 50,
  });
  await runTool('photoshop_set_text_alignment', { alignment: 'CENTER' });
  await runTool('photoshop_update_text_content', {
    text: 'Smoke Text Updated',
  });
  await runTool('photoshop_find_layers', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    query: 'Placed',
    matchMode: 'contains',
  });
  await runTool('photoshop_rasterize_layer');
  await runTool('photoshop_set_layer_opacity', { opacity: 85 });
  await runTool('photoshop_set_layer_blend_mode', { blendMode: 'MULTIPLY' });
  await runTool('photoshop_set_layer_visibility', { visible: false });
  await runTool('photoshop_set_layer_visibility', { visible: true }, { count: false });
  await runTool('photoshop_set_layer_locked', { locked: true });
  await runTool('photoshop_set_layer_locked', { locked: false }, { count: false });
  await runTool('photoshop_apply_gaussian_blur', { radius: 1.5 });
  await runTool('photoshop_apply_sharpen', { amount: 50, radius: 1, threshold: 0 });
  await runTool('photoshop_apply_noise', {
    amount: 5,
    distribution: 'UNIFORM',
    monochromatic: false,
  });
  await runTool('photoshop_apply_motion_blur', { angle: 12, radius: 8 });
  await runTool('photoshop_adjust_brightness_contrast', {
    brightness: 10,
    contrast: 8,
  });
  await runTool('photoshop_adjust_hue_saturation', {
    hue: 5,
    saturation: 10,
    lightness: 0,
  });
  await runTool('photoshop_auto_levels');
  await runTool('photoshop_auto_contrast');
  await runTool('photoshop_desaturate');
  await runTool('photoshop_invert');

  await runTool('photoshop_select_rectangle', {
    left: 20,
    top: 20,
    right: 180,
    bottom: 160,
  });
  await runTool('photoshop_get_selection_bounds', {
    documentRef: { by: 'id', value: ctx.mainDocId },
  });
  await runTool('photoshop_create_layer_mask');
  await runTool('photoshop_delete_layer_mask');
  await runTool(
    'photoshop_select_rectangle',
    {
      left: 30,
      top: 30,
      right: 170,
      bottom: 150,
    },
    { count: false }
  );
  await runTool('photoshop_create_layer_mask', {}, { count: false });
  await runTool('photoshop_apply_layer_mask');
  await runTool('photoshop_select_all');
  await runTool('photoshop_invert_selection');
  await runTool('photoshop_deselect');

  await runTool('photoshop_select_layer', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    layerRef: { by: 'name', value: 'Placed Layer' },
  });
  await runTool('photoshop_duplicate_layer', { newName: 'Placed Layer Copy' });

  await createNamedLayer('Order A');
  await createNamedLayer('Order B', false);
  await createNamedLayer('Order C', false);
  await runTool('photoshop_move_layer_to_bottom');
  await selectLayerByName('Order A');
  await runTool('photoshop_move_layer_up');
  await selectLayerByName('Order B', false);
  await runTool('photoshop_move_layer_down');
  await selectLayerByName('Order A', false);
  await runTool('photoshop_move_layer_to_top');
  await selectLayerByName('Order C', false);
  await runTool('photoshop_move_layer_to_position', {
    targetLayerName: 'Order A',
    position: 'ABOVE',
  });

  await createNamedLayer('Undo Redo Layer', false);
  await runTool('photoshop_get_history');
  await runTool('photoshop_undo', { steps: 1 });
  await runTool('photoshop_redo', { steps: 1 });
  const currentHistoryStateName = await getCurrentHistoryStateName();
  await runTool('photoshop_select_history_state', {
    documentRef: { by: 'active' },
    state: currentHistoryStateName,
  });

  await runTool('photoshop_snapshot_checkpoint', {
    name: 'restore-point',
    documentRef: { by: 'id', value: ctx.mainDocId },
  });
  await createNamedLayer('Restore Probe', false);
  await runTool('photoshop_restore_checkpoint', { name: 'restore-point' });

  await runTool('photoshop_execute_script', {
    code: '(function(){ return app.activeDocument.name; })();',
  });
  await runTool('photoshop_execute_script_with_state', {
    code: '(function(){ return app.activeDocument.activeLayer.name; })();',
    responseDetail: 'minimal',
  });

  await runTool('photoshop_run_sequence', {
    steps: [
      { tool: 'photoshop_create_layer', args: { name: 'Sequence Layer' } },
      { tool: 'photoshop_rename_layer', args: { name: 'Sequence Layer Final' } },
    ],
    stopOnError: true,
  });

  await runTool('photoshop_run_transaction', {
    checkpointName: 'transaction-point',
    rollbackOnError: true,
    steps: [
      { tool: 'photoshop_create_layer', args: { name: 'Transaction Layer' } },
      { tool: 'photoshop_set_layer_opacity', args: { opacity: 70 } },
    ],
  });

  await runTool(
    'photoshop_save_document',
    {
      path: ctx.mainSavePath,
      format: 'PSD',
    },
    {
      count: false,
      postCheck: async () => {
        await assertFileExists(ctx.mainSavePath, 'main document save');
      },
    }
  );

  const duplicateResult = await runTool('photoshop_duplicate_document', {
    documentRef: { by: 'id', value: ctx.mainDocId },
    newName: 'Smoke Duplicate',
  });
  ctx.duplicateDocName =
    dataFromResult(duplicateResult)?.duplicateDocument?.name || 'Smoke Duplicate';
  await runTool(
    'photoshop_select_document',
    { documentRef: { by: 'name', value: ctx.duplicateDocName } },
    { count: false }
  );

  await runTool(
    'photoshop_save_copy',
    {
      documentRef: { by: 'active' },
      path: ctx.mainCopyPath,
      format: 'JPEG',
      quality: 8,
    },
    {
      postCheck: async () => {
        await assertFileExists(ctx.mainCopyPath, 'photoshop_save_copy');
      },
    }
  );
  await runTool(
    'photoshop_export_document',
    {
      documentRef: { by: 'active' },
      path: ctx.mainExportPath,
      format: 'PNG',
      quality: 8,
    },
    {
      postCheck: async () => {
        await assertFileExists(ctx.mainExportPath, 'photoshop_export_document');
      },
    }
  );
  await runTool('photoshop_resize_canvas', {
    documentRef: { by: 'active' },
    width: 360,
    height: 260,
  });
  await runTool('photoshop_resize_image', { width: 220, height: 160 });
  await runTool('photoshop_crop_document', {
    left: 10,
    top: 10,
    right: 180,
    bottom: 130,
  });

  await createNamedLayer('Merge Source A', false);
  await createNamedLayer('Merge Source B', false);
  await runTool('photoshop_merge_visible_layers');
  await createNamedLayer('Flatten Source', false);
  await runTool('photoshop_flatten_image');

  await runTool('photoshop_get_ui_snapshot', { titleContains: 'Photoshop' });
  await runTool('photoshop_ui_list_windows');
  await runTool('photoshop_ui_list_controls', {
    titleContains: 'Photoshop',
    limit: 25,
  });
  await runTool('photoshop_focus_canvas', { titleContains: 'Photoshop' });
  await runTool('photoshop_send_shortcut', {
    shortcut: 'escape',
    titleContains: 'Photoshop',
  });
  await runTool('photoshop_ui_wait_for_dialog', {
    titleContains: 'Open',
    timeoutMs: 1200,
  });
  await runTool(
    'photoshop_capture_window_snapshot',
    {
      titleContains: 'Photoshop',
      outputPath: ctx.windowSnapshotPath,
    },
    {
      postCheck: async () => {
        await assertFileExists(ctx.windowSnapshotPath, 'photoshop_capture_window_snapshot');
      },
    }
  );
  await runTool(
    'photoshop_capture_canvas_snapshot',
    {
      titleContains: 'Photoshop',
      outputPath: ctx.canvasSnapshotPath,
    },
    {
      postCheck: async () => {
        await assertFileExists(ctx.canvasSnapshotPath, 'photoshop_capture_canvas_snapshot');
      },
    }
  );

  await exerciseActionPlayback();

  await runTool('photoshop_snapshot_checkpoint', { name: 'recovery-point' }, { count: false });
  await runTool(
    'photoshop_select_layer',
    {
      documentRef: { by: 'active' },
      layerRef: { by: 'name', value: '__missing_layer_for_error__' },
    },
    { count: false, expectError: true }
  );
  await runTool('photoshop_get_last_error');
  await runTool('photoshop_recover_last_error');

  await ensureMainDocumentSelected();
  await createNamedLayer('Delete Me', false);
  await runTool('photoshop_delete_layer');
}

async function main() {
  try {
    await runMainScenario();
  } catch (error) {
    report.fatalError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      addSetupEvent(
        'cleanup',
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      await session.disconnect();
    } catch (error) {
      addSetupEvent(
        'disconnect',
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }

    finalizeReport();
    await writeFile(ctx.reportPath, JSON.stringify(report, null, 2), 'utf8');

    const failedTools = Object.entries(report.outcomes)
      .filter(([, outcome]) => outcome.status === 'failed')
      .map(([name]) => name);
    const skippedTools = Object.entries(report.outcomes)
      .filter(([, outcome]) => outcome.status === 'skipped')
      .map(([name]) => name);
    const missingTools = Object.entries(report.outcomes)
      .filter(([, outcome]) => outcome.status === 'missing')
      .map(([name]) => name);

    console.log(`[real-tool-smoke] report: ${ctx.reportPath}`);
    console.log(
      `[real-tool-smoke] total=${report.summary.totalTools} passed=${report.summary.passed} failed=${report.summary.failed} skipped=${report.summary.skipped} missing=${report.summary.missing}`
    );

    if (failedTools.length > 0) {
      console.log(`[real-tool-smoke] failed tools: ${failedTools.join(', ')}`);
    }
    if (skippedTools.length > 0) {
      console.log(`[real-tool-smoke] skipped tools: ${skippedTools.join(', ')}`);
    }
    if (missingTools.length > 0) {
      console.log(`[real-tool-smoke] missing tools: ${missingTools.join(', ')}`);
    }

    if (report.fatalError) {
      console.error(`[real-tool-smoke] fatal: ${report.fatalError}`);
    }

    if (report.summary.failed > 0 || report.summary.missing > 0) {
      process.exitCode = 1;
    }
  }
}

await main();
