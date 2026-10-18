# Local Photoshop MCP (unpublished fork)

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

## Access and execution

Enable this MCP through the host's sandbox and permissions. Tools are available
without project registration, a policy file or per-task grants. The old
`PHOTOSHOP_PROJECTS_FILE` setting is no longer read. The retired implementation
and its live-test drivers are kept locally under `legacy/project-authorization/`,
which is excluded from Git and packages.

Document tools require an explicit `document_id`, except open/create/list/sequence.
Layer-targeted operations also require `layer_id`. Get IDs with
`photoshop_get_open_documents` / `photoshop_get_layer_tree`. All open documents,
including unsaved documents, can be selected. Restarting Photoshop invalidates
the running MCP session; reconnect with a new MCP process.

File paths may be absolute or relative to the MCP process's working directory.
Output format and extension must agree. Use existing output directories.
File access and overwriting follow the host and operating-system permissions;
the runtime does not maintain project read/write directories or output grants.
Closing with an implicit save is refused: save explicitly before closing.

Multiple MCP processes may start and complete stdio handshakes without accessing
Photoshop or holding its operation lock. Requests are serialized locally. Before
input execution and document inspection, each outer tool call acquires the same
temporary-directory `photoshop-mcp-single-writer` directory lock. A sequence holds
it for all steps; nested calls still pass through the registry and input checks.
Only `photoshop_get_capabilities` is exempt; ping and version acquire the lock.
Busy operations immediately return a `WRITER_LOCK_*` error without inspecting
Photoshop or retrying. Different temporary directories, OS sessions, and other
automation software remain outside this coordination boundary.

Document/layer ID and expected saved path are rechecked in the **same Photoshop
script** that performs the operation. Each dispatch first persists `pending` in
the owned lock. Only definite `not-started` or `finished` completion returns it to
trusted `idle`. A returned script-error JSON is a finished dispatch. Timeout,
output limits, killed or disconnected execution, and unclassified post-dispatch
errors leave a sticky fault and retain pending and the lock, even if a handler
catches the error. Neither stop nor restart automatically clears an uncertain
operation.

Stale-lock recovery requires a valid PID, trusted idle state, and an `ESRCH`
probe. An adjacent fixed `.recovery` directory serializes recovery; its owner
rereads state and probes the PID before one removal and one acquisition attempt.
A new owner winning that gap is preserved. Live, unknown, untrusted, and pending
owners are never automatically removed, nor are existing recovery directories.
Shutdown rejects new and queued calls with `SERVER_STOPPING`, drains them, then
waits for the active call; it never releases an uncertain dispatch.

### Removed / intentionally unavailable

- External raw JSX/code execution, script-file execution, Photoshop Actions
- SendKeys, arbitrary keyboard shortcuts, UI focus/recovery automation
- Window and purported canvas screenshots (the old implementation captured desktop pixels)
- Implicit active-document resources and state-injecting prompts
- Transaction/automatic rollback, checkpoint restore and history mutation until independently validated
- Automatic Photoshop launch, cloud image delivery, model calls and runtime telemetry

`photoshop_run_sequence` is bounded, serial, and rechecks every step. Nested
workflows are denied. It stops on failure and **does not
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

`photoshop_export_layer_preview` uses a temporary document duplicate,
selects the layer/group by ID, hides other branches in the duplicate, and writes
PNG to the requested local path. Canvas coordinates are retained; masks
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
