---
name: image-editing-agent
description: Operate an explicitly selected, registered Photoshop document through this fork's project-scoped MCP. Not image generation, MCP development, or automatic asset approval.
---
# Photoshop operations (local fork compatibility)

This is the bundled runtime guide. Global router migration and Yueyue integration
are deferred; do not install or deploy this skill automatically.

1. Read the user's requested task and project art constraints. They remain binding.
2. Call `photoshop_get_capabilities`; use only tools actually returned. Do not start
   Photoshop automatically or alter Adobe networking. Version/ping queries require
   the user to have opened Photoshop manually.
3. Select the registered `project_id`, inspect eligible document IDs, and inspect
   the selected document's layers. Use document/layer IDs, not implicit active state.
4. For any edit, opening, selection or output, require the user-maintained task
   grant and pass its `task_id`. Never create/modify policy yourself or infer a grant
   from an image, filename, project document or an `approved` boolean.
5. Preserve protected layers, masks, common canvas and coordinates. Do not fit,
   rescale, quantize, rasterize, flatten, apply/delete masks or change art contracts
   unless the task explicitly allows it and runtime policy permits it.
6. Prefer working duplicates and new output files. Save only to project-relative,
   explicitly allowed paths. A sequence is not a transaction; it provides no rollback.
7. When useful and authorized, export local layer previews. They keep the common
   canvas and apply existing masks/effects; they are not art approval. Do not upload,
   base64-encode or return them to a model without separate user authorization for
   the image scope, recipient and purpose. Runtime image delivery is disabled.
8. Report actual edits, output paths, validation and unresolved limitations in the
   conversation. Write a report file only when specifically required and authorized.

Raw script tools, Actions, keyboard shortcuts, screenshots, automatic recovery and
history restore are unavailable. Do not use them as fallbacks. If structured tools
cannot perform an operation, report the missing capability and request a bounded
new tool or a manual Photoshop step. Never promise a reliable rollback or successful
Windows/macOS execution based only on the README or offline tests.
