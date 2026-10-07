# Project-scoped Photoshop MCP (unpublished fork)

A local stdio MCP for **structured** Photoshop document/layer operations. This fork
of [photoshop-mcp-windows-first](https://github.com/Vaxaxas/photoshop-mcp-windows-first)
is being hardened at the owner's request. Original MIT copyright is retained in
[LICENSE](LICENSE). This fork does not publish or install the upstream npm package.

## Build from this checkout

Use the exact `packageManager` version: **pnpm 10.18.3**. Development requires a
Node version supported by pnpm and the existing lint dependencies (Node 20+ is
recommended; CI uses Node 20). The runtime's existing Node minimum is unchanged.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run lint
pnpm test
```

There is no install-time `prepare`, package-manager global update, Photoshop
launch, image upload, skill deployment, or Action-fixture test. `package-lock.json`
was the migration input; `pnpm-lock.yaml` is the sole maintained lockfile. Build
explicitly before use. A build/test pass does **not** verify Photoshop COM or art.

Start using `node /absolute/path/to/this-checkout/dist/index.js`. Example host
configurations are in `examples/`. Do not use `npx` to download the upstream
package as a substitute for this build.

## Security model

The user/launcher sets `PHOTOSHOP_PROJECTS_FILE` to an absolute policy JSON file
**outside every project root**. Start with `examples/projects.empty.json`: no
project access is enabled. `examples/projects.example.json` illustrates a project
only; it does not register your machine or authorize edits.

Missing policy: only capability/version diagnostics. Invalid policy: startup
fails. Policy changes require a server restart; running requests fail closed.
Policy is trusted deployment input, never an MCP tool argument. There is no tool
to register a project, add a grant, or change policy. The host must not let an agent
write its policy through an unrelated filesystem tool.

Every document tool requires `project_id` and, except open/create/list/sequence,
`document_id`. Layer-targeted operations also require `layer_id`. Get eligible IDs
with `photoshop_get_open_documents` / `photoshop_get_layer_tree`. External unsaved
documents are denied; saved documents must resolve inside a registered read path.
Session-created documents are bound to their project and task. Restarting Photoshop invalidates the running MCP session. Restarting the MCP
loses transient document bindings: save/reopen a permitted copy instead.

Paths are **project-relative**. Absolute paths, traversal, drive-relative paths,
UNC/device paths, ADS, aliases/symlinks, hardlinked files, protected host/config
locations, and unsupported extensions are rejected. Output parent directories
must already exist and be registered: the MCP does not create directory trees.
Read formats: PSD/PNG/JPEG. Output format and extension must agree. Output is
limited to registered write paths, with local previews additionally confined to
`preview_path`.

### Explicit task grants

Directory registration alone does not authorize every edit. Non-read operations
(including opening/selection/export) require a `task_id` matching a user-maintained,
expiring entry in the selected project's `tasks` array. Example **to adapt and
approve locally**, not a default grant:

```json
{
  "id": "review-copy",
  "expires_at": "2030-01-01T00:00:00Z",
  "tools": ["photoshop_open_image", "photoshop_duplicate_document", "photoshop_rename_layer", "photoshop_save_copy"],
  "documents": ["masters/example.psd"],
  "allow_new_documents": true,
  "output_paths": ["work/example-v1.psd"],
  "destructive_tools": [],
  "overwrite_paths": []
}
```

Choose a short expiry matching the real task; replace the example date. `tools`
contains exact names, not wildcards. `documents` lists exact existing source
paths; `allow_new_documents` allows session-bound working copies under that task.
`output_paths` lists exact approved output files. To authorize a destructive tool,
both project `allow_destructive` and the task's `destructive_tools` must permit
that exact tool. Overwriting additionally requires project `allow_overwrite` and
the exact path in task `overwrite_paths`. Caller booleans cannot supply approval.
Closing with an implicit save is refused: first explicitly save a permitted copy.

Multiple MCP processes may start and complete stdio handshakes without accessing
Photoshop or holding its operation lock. Requests are serialized locally. Before
the complete policy check, each outer tool call acquires the same temporary-directory
`photoshop-mcp-single-writer` directory lock. A sequence holds it for all steps;
nested calls still pass through the registry and grants. Only
`photoshop_get_capabilities` is exempt; ping and version acquire the lock.
Busy operations immediately return a `WRITER_LOCK_*` error without inspecting
Photoshop or retrying. Different temporary directories, OS sessions, and other
automation software remain outside this coordination boundary.

Document/layer ID and expected saved path are rechecked in the **same Photoshop
script** that performs the operation. Paths and grants are rechecked before COM
dispatch. Each dispatch first persists `pending` in the owned lock. Only definite
`not-started` or `finished` completion returns it to trusted `idle`. A returned
script-error JSON is a finished dispatch. Timeout, output limits, killed or
disconnected execution, and unclassified post-dispatch errors leave a sticky fault
and retain pending and the lock, even if a handler catches the error. Neither stop
nor restart automatically clears an uncertain operation.

Stale-lock recovery requires a valid PID, trusted idle state, and an `ESRCH`
probe. An adjacent fixed `.recovery` directory serializes recovery; its owner
rereads state and probes the PID before one removal and one acquisition attempt.
A new owner winning that gap is preserved. Live, unknown, untrusted, and pending
owners are never automatically removed, nor are existing recovery directories.
Shutdown rejects new and queued calls with `SERVER_STOPPING`, drains them, then
waits for the active call; it never releases an uncertain dispatch.
These checks are not an OS sandbox against arbitrary same-user processes,
malicious plugins, Photoshop file-format exploits, or hostile filesystem races.

### Removed / intentionally unavailable

- External raw JSX/code execution, script-file execution, Photoshop Actions
- SendKeys, arbitrary keyboard shortcuts, UI focus/recovery automation
- Window and purported canvas screenshots (the old implementation captured desktop pixels)
- Implicit active-document resources and state-injecting prompts
- Transaction/automatic rollback, checkpoint restore and history mutation until independently validated
- Automatic Photoshop launch, cloud image delivery, model calls and runtime telemetry

`photoshop_run_sequence` is bounded, serial, and rechecks every step. Nested
workflows and cross-project steps are denied. It stops on failure and **does not
roll back** prior edits/files. Unknown execution completion faults the connection
and retains pending ownership; inspect Photoshop manually rather than retrying
uncertain work. Offline checks do not prove Photoshop completion.

### Pixel fill and rectangle selection

`photoshop_fill_layer` requires `scope: "selection" | "layer"` and integer
`red`, `green`, `blue` values from 0 to 255. It accepts only RGB documents at
8 bits/channel, an editable ordinary pixel layer, and the three component color
channels. Locked/background layers, smart objects, masks and Quick Mask targets
are refused; the tool does not unlock or rasterize layers.

`selection` requires a nonempty selection and fills its existing shape without
replacing or clearing it. `layer` requires no selection, fills the whole layer,
and restores the absence of selection even if fill fails. Successful responses
contain `scope`, `actualbounds` (canvas pixel `[left, top, right, bottom]`, clipped
to the canvas for selection scope), and `selection_preserved: true`. The latter
means preserving the original selection state, including no selection for layer
scope. Bounds describe the operation's scope, not a measured pixel difference.
This round's guarantee is limited to the verified visible-image use cases.
Hidden RGB in fully transparent unselected pixels is not preserved; workflows
that later reveal those pixels require separate verification.

`photoshop_select_rectangle` requires finite integer pixel coordinates satisfying
`0 <= left < right <= width` and `0 <= top < bottom <= height`. The rectangle is
half-open, replaces the selection, and requests zero feather and no antialiasing.
Runtime target and canvas checks precede mutation; script failures reach the tool
response. Native checks have calibrated RGB8 selection shape and state/RGBA
observation, Gray/16 observation without original pixel-byte measurement, and
verified eight sequential points, transparent one/four selected-pixel results
and the transparent one PSD save/reopen case. See
[the fill contract plan](docs/plans/002-selection-fill-contract.md) for the
visible-image scope, hidden-RGB limitation, incomplete matrix coverage and pending
final review; offline checks alone do not prove native behavior.

### Local layer previews

`photoshop_export_layer_preview` uses an authorized temporary document duplicate,
selects the layer/group by ID, hides other branches in the duplicate, and writes
PNG to the registered preview directory. Canvas coordinates are retained; masks
and effects are applied. The source is not cropped, resized or flattened. Clipped
layer arrangements are refused instead of silently producing misleading results.
Actual Photoshop behavior remains subject to a disposable-document local check.

Previews are always `local-only`; no base64/image blocks are returned. Cloud
recipient settings cannot enable a delivery route that is not implemented. A
separate host uploading a file requires its own user authorization. This MCP
cannot control other plugins/hosts or Adobe's own network activity. Keep existing
Adobe firewall/proxy restrictions unchanged. Cloud-only Adobe functions are not
part of this workflow.

## Scope and verification

Implementation scope is the MCP runtime, pnpm and directly affected documentation.
Global router deployment and Yueyue skill/art changes are deferred. Existing
bundled skill instructions are being aligned only to the available MCP surface;
no external skill installation is performed.

See [the plan](docs/plans/001-photoshop-hardening-pnpm-router.md) and
[implementation status](docs/implementation-status.md) for evidence and remaining
Windows/macOS checks. No art acceptance, reliable history rollback or production
security isolation is implied by a successful build.
