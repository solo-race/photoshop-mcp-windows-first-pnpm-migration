---
name: image-editing-agent
description: windows-first photoshop editing workflow aligned to the local photoshop-mcp server. use when editing or retouching existing images in Adobe Photoshop with checkpoints, layer targeting, structured validation, export, and conservative high-fidelity changes; especially for active Photoshop documents, local image files, product cleanup, recoloring, compositing, text-safe edits, and edit reports.
---

# Image Editing Agent

Use this skill when the task should be completed inside the local `photoshop-mcp` server, not by generic image generation.

Work like a careful Photoshop operator:
- preserve unrelated content
- prefer reversible edits
- use structured MCP tools before raw scripts
- validate after each major step

## Tool Priority

Use tools in this order:

1. Structured Photoshop MCP tools
2. `photoshop_execute_script_with_state` when the structured toolset is close but not enough
3. `photoshop_execute_script` only as an escape hatch
4. Windows UI fallback tools only for dialog recovery or window inspection
5. `photoshop_play_action` only after checking `photoshop_list_actions`, and only if the workflow can tolerate interactive or unreliable behavior

Do not default to raw ExtendScript if a structured tool already exists.

## Start State

Before editing:

1. Verify Photoshop is reachable with `photoshop_ping`.
2. Read environment and capabilities with `photoshop_get_version`.
3. Inspect current workspace with `photoshop_get_state` or `photoshop_get_active_context`.

If the user gave a file path:
- open it with `photoshop_open_image`

If the user wants to work on the current document:
- inspect with `photoshop_get_open_documents`
- select the intended one with `photoshop_select_document`

If there is no active document and no source path:
- ask for the source image path or ask the user to open the target document in Photoshop

## Safety First

Before destructive edits:

1. Create a checkpoint with `photoshop_snapshot_checkpoint`
2. If the user wants a non-destructive branch, create a duplicate with `photoshop_duplicate_document`
3. Wait for Photoshop to settle with `photoshop_wait_for_idle`

For multi-step edits that should roll back cleanly:
- prefer `photoshop_run_transaction`

## Workflow Classes

Choose the narrowest workflow that matches the request.

### Targeted local edit

Use this for:
- object cleanup
- bounded recolor
- replacing one region
- text or label corrections
- local retouching

Preferred tools:
- targeting: `photoshop_get_document_tree`, `photoshop_get_layer_tree`, `photoshop_find_layers`, `photoshop_find_text_layers`, `photoshop_get_layer_info`, `photoshop_select_layer`
- selections and masks: `photoshop_select_rectangle`, `photoshop_select_all`, `photoshop_invert_selection`, `photoshop_deselect`, `photoshop_create_layer_mask`, `photoshop_delete_layer_mask`, `photoshop_apply_layer_mask`
- layer work: `photoshop_create_layer`, `photoshop_duplicate_layer`, `photoshop_rename_layer`, `photoshop_move_layer_to_position`, `photoshop_move_layer_up`, `photoshop_move_layer_down`, `photoshop_move_layer_to_top`, `photoshop_move_layer_to_bottom`

### Controlled global transformation

Use this for:
- broad tonal shifts
- resize/crop/canvas changes
- simple stylized treatment that still preserves layout and identity

Preferred tools:
- document ops: `photoshop_resize_image`, `photoshop_resize_canvas`, `photoshop_crop_document`
- color and tone: `photoshop_adjust_brightness_contrast`, `photoshop_adjust_hue_saturation`, `photoshop_auto_levels`, `photoshop_auto_contrast`, `photoshop_desaturate`, `photoshop_invert`
- filters: `photoshop_apply_gaussian_blur`, `photoshop_apply_sharpen`, `photoshop_apply_noise`, `photoshop_apply_motion_blur`

### High-fidelity symbolic edit

Use this for:
- text
- logos
- packaging
- UI
- charts
- labels
- exact product details

Preferred tools:
- `photoshop_find_text_layers`
- `photoshop_select_layer`
- `photoshop_create_text_layer`
- `photoshop_set_text_font`
- `photoshop_set_text_color`
- `photoshop_set_text_alignment`
- `photoshop_update_text_content`

Do not treat exact text or symbols as a repaint-only problem if native text-layer tools can solve it.

## Photoshop MCP Workflow

### 1. Inspect and resolve targets

Always determine:
- target region
- protected region
- active document
- active layer
- whether a selection already exists

Use:
- `photoshop_get_active_context`
- `photoshop_get_document_tree`
- `photoshop_get_layer_tree`
- `photoshop_get_layer_info`
- `photoshop_get_selection_bounds`

If layer names are ambiguous:
- use `photoshop_find_layers` or `photoshop_find_text_layers`
- then resolve with `photoshop_select_layer`

### 2. Define the edit scope

Name layers descriptively when creating temporary working layers.

Good names:
- `target_product_label`
- `cleanup_pass`
- `protected_subject_mask`
- `replacement_text`

Use:
- `photoshop_create_layer`
- `photoshop_duplicate_layer`
- `photoshop_rename_layer`

### 3. Execute in small, stable steps

Use the smallest safe operation that achieves the change.

Common structured operations:

- place or composite assets:
  `photoshop_place_image`, `photoshop_fit_layer_to_document`, `photoshop_scale_layer`, `photoshop_move_layer`, `photoshop_rotate_layer`

- layer styling and visibility:
  `photoshop_set_layer_opacity`, `photoshop_set_layer_blend_mode`, `photoshop_set_layer_visibility`, `photoshop_set_layer_locked`

- raster preparation:
  `photoshop_rasterize_layer`

- solid fills:
  `photoshop_fill_layer`

- history-safe sequences:
  `photoshop_run_sequence`, `photoshop_run_transaction`

Avoid one huge step if two or three smaller edits are safer.

### 4. Validate after each major edit

After every meaningful change, check:
- correct layer changed
- protected region stayed stable
- geometry and perspective still make sense
- no accidental text drift
- no obvious mask or seam artifacts

Use:
- `photoshop_get_active_context`
- `photoshop_get_layer_info`
- `photoshop_get_history`
- `photoshop_capture_canvas_snapshot`
- `photoshop_capture_window_snapshot`

`photoshop_capture_canvas_snapshot` is currently a window-level fallback, not a perfect isolated canvas capture. Use it for coarse visual verification, not pixel-accurate diffing.

### 5. Save, export, and report

When the edit is acceptable:
- save PSD or working state with `photoshop_save_document`
- save a delivery copy with `photoshop_save_copy` or `photoshop_export_document`

Create `edit_report.md` and include:
- request
- source document or source file
- checkpoint name
- target and protected regions
- tools used
- validation steps
- output paths
- remaining limitations

## Recovery Workflow

If a step fails:

1. Read `photoshop_get_last_error`
2. Try `photoshop_recover_last_error`
3. If needed, restore with `photoshop_restore_checkpoint`
4. Re-check the workspace with `photoshop_get_state`

For stuck dialogs on Windows:
- `photoshop_ui_wait_for_dialog`
- `photoshop_send_shortcut` with `escape`
- `photoshop_focus_canvas`
- `photoshop_get_ui_snapshot`

## Current Strengths Of This MCP

This server is strong at:
- document creation, opening, saving, exporting, duplication
- layer creation, duplication, transform, ordering, visibility, opacity, blend mode
- text layer editing
- rectangular selections and mask creation
- raster filters and tonal adjustments
- structured state inspection and layer/document targeting
- checkpoints, history navigation, transaction-style recovery
- Windows dialog inspection and recovery

## Current Limits You Must Respect

Do not promise deterministic automation for capabilities this MCP does not yet expose well.

Current gaps or weak spots:
- no native brush-stroke, clone-stamp, healing, patch, or freehand canvas interaction tools
- no native select-subject, color-range, refine-edge, guides, zoom, pan, or artboard workflow tools
- no true pixel sampler or histogram tool in this server yet
- `photoshop_capture_canvas_snapshot` is still a coarse fallback
- `photoshop_play_action` is not reliable for unattended workflows on this machine; many installed default actions either time out or fail generically even after safe probing

When the request depends on one of those gaps:
- say so clearly
- use `photoshop_execute_script_with_state` only if the operation is realistically scriptable
- otherwise recommend a manual Photoshop step instead of pretending the MCP can do it safely

## Action Playback Rule

If the user explicitly wants Photoshop Actions:

1. Inspect available actions with `photoshop_list_actions`
2. Prefer non-interactive custom actions created for automation
3. Treat built-in default actions as potentially interactive or unstable
4. Do not build a core workflow around `photoshop_play_action` unless the exact action has already been proven unattended on this machine

## Response Requirements

In your working response:
- say what you changed
- say what you intentionally preserved
- state any uncertainty or limitation

At the end:
- write `edit_report.md`
- ask the user to verify whether the requested edit was achieved accurately
