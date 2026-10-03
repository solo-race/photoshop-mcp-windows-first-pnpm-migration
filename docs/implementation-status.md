# MCP-only implementation status

Baseline: `d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b`.
Plan: `d3f2a1e` on `plan/ps-hardening-pnpm-router`.
Owner narrowed scope on 2026-10-02: this MCP only; router and Yueyue skill work deferred.

Status: **MCP-only offline verification passed; P6 session identity repair U1–U4 accepted on the observed Windows host, final independent session-repair review PASS; remaining native Photoshop use UNVERIFIED**.

- P0: source paths reviewed; project policy and explicit expiring task grants defined.
- P1: pnpm 10.18.3 import, frozen installation (scripts disabled), build, lint and existing offline tests passed.
- P2: external raw-script, Actions, SendKeys, automatic recovery and legacy smoke fixture removed.
- P3: runtime validation, centralized project/file/task checks, bound document/layer ID dispatch,
  serial workflows, local-only preview, and scoped metadata implemented; bounded offline policy and protocol probes passed.
- P4: only stale bundled MCP instructions aligned. Skill rename/router packaging deferred.
- P5: OUT OF SCOPE, no external repository changes or deployment.
- P6: bounded session identity repair U1–U4 accepted; remaining P6 native, rendering and Yueyue integration checks UNVERIFIED. Never run the old Action-based smoke script.

## P6 session identity repair acceptance (2026-10-03, Windows)

The repair uses a unique nonpersistent CustomOptions token, installed once with
a one-way flag. Missing or mismatched tokens reject without replenishment;
scope/grant ordering is unchanged. Tester reported tests and lint passed;
format checking still reports pre-existing source failures. U3 review passed;
final independent session-repair review PASS.

Native acceptance retained the same Node process and Connection: repeated
inspections and real registry creation/query of an authorized disposable unsaved
document succeeded. After a human-controlled Photoshop restart, the original
identity stayed unchanged and both inspection and the retained document binding
rejected with `PHOTOSHOP_SESSION_CHANGED` before the document handler. A fresh
Connection succeeded. Process observations are not the identity; COM/process
binding remains unknown. These results apply to the observed host only.

Diagnostic cleanup completed: the current owned token, writer lock and temporary
files were removed; the unavailable old token was reported as a retired identity,
not proof of absolute absence. Document cleanup remains the human's responsibility.
This does not accept the remaining P6 native, rendering or Yueyue integration work.

## Native disposable-document check (separate authorization)

Open Photoshop manually. Register a dedicated empty test project and short-lived
task grants outside its root; use copies only. Confirm version, COM attachment,
registered document listing, denied foreign/unsaved documents, ID targeting after
manual active-document switches, non-destructive working copy, save-copy/preview
confinement, and intact source layers/masks/canvas. Check exported PNG dimensions,
alpha and appearance manually. No cloud upload, production asset or model call is
part of this procedure. History recovery and desktop screenshots remain disabled.

## Limits

Directory checks are application-level confinement, not an OS sandbox. Same-user
hostile processes can race filesystem/Photoshop state. Policy files must be protected
from other host tools. Only one MCP process may write to Photoshop. Existing PSD
linked resources and installed Photoshop plugins are outside this runtime's file
broker. Native output rendering, COM behavior beyond the bounded session identity
checks, and filesystem reparse semantics on Windows require local evidence.
No production art or S6 acceptance is claimed.

## Verification actually performed (2026-10-02, cloud Linux)

Environment: Node v24.19.0, pnpm 10.18.3. The existing CI remains Node 20;
initial implementation CI passed on GitHub (run `36999672682`).

- `pnpm import`, then `pnpm install --frozen-lockfile --ignore-scripts` succeeded.
- Compared every `(package, resolved version)` pair: npm input 191, pnpm output 191,
  no added/removed resolved versions. SDK remained 1.28.0, TypeScript 5.9.3.
- pnpm exposed a pre-existing undeclared `@eslint/js` import in eslint.config.js.
  Added it explicitly at its already locked 9.39.4 version; no dependency upgrade.
- `pnpm run build` and `pnpm run lint` passed. Clean build removes stale emitted
  files, so deleted Action/UI implementations cannot survive in `dist/`.
- `pnpm test`: 11 passed. Retired Action-parser/SendKeys assertions were replaced
  by removal/denial checks; one existing serializer test file gained a regression
  for the upstream response encoder's broken quoted/control-character strings.
- A bounded temporary policy probe passed 32 assertions: registered reads, traversal,
  drive/UNC/ADS/device rejection, write scope, extension restrictions, symlinks,
  hardlinks, overwrite denial, task/document binding, destructive denial, exact
  output grants, no foreign/unsaved metadata, sequence authorization and policy-change
  invalidation. This used temporary files and a mock Photoshop connection.
- A JavaScript VM probe verified the generated script selects the expected document
  and layer, rejects an altered saved path, restores the dialog setting, and round-trips
  quoted/backslash/control-character strings. This is **not ExtendScript/COM execution**.
- Actual stdio MCP initialize/list/call probes exposed 73 structured tools, rejected
  removed names and unregistered document operations, returned no implicit resources
  or prompts, and allowed capability inspection without Photoshop. Two consecutive
  start/close runs passed after correcting normal-exit writer-lock cleanup.

The temporary probes are bounded verification, not a new Windows test platform.
No Photoshop process, binary Action fixture, model/API, real art or cloud image
upload was used. No independent human reviewer or native machine PASS is claimed.
The work is not global router deployment and does not advance Yueyue/S6 acceptance.

## PR #1 review corrections (2026-10-02)

- P1: removed implicit rasterization from all ten retained filter/adjustment
  templates. Non-NORMAL inputs are rejected before edits with safe
  `RASTERIZATION_REQUIRED` guidance. Explicit `photoshop_rasterize_layer` remains
  subject to both project and task destructive grants. Gaussian Blur retains its
  response field with `wasRasterized: false`.
- P2: document, output and overwrite grants share the same platform-aware path
  comparison as containment/alias checks. Windows path comparisons accept case
  variants; POSIX comparisons remain case sensitive. No tool/task identifier
  folding, traversal acceptance or alias-check removal was introduced. The
  dispatch guard likewise no longer lowercases paths on non-Windows hosts.
- Added 14 bounded offline regression tests: ten templates each exercised with
  NORMAL/TEXT/SMARTOBJECT/SOLIDFILL mocks, Windows/POSIX path positive and negative
  comparisons, exact tool/task grants and destructive denial, safe error guidance,
  and distinct case-sensitive filesystem files plus symlink denial.
- Final local `pnpm test`: 25 passed; build and lint passed. Existing temporary
  32-assertion policy probe, VM dispatch probe and actual stdio protocol probe
  were rerun successfully. Windows path probes use `node:path.win32` on Linux;
  these are not Windows filesystem or Photoshop/COM live verification.
- Native rendering/COM/reparse behavior remains UNVERIFIED. Review corrections
  do not claim independent reviewer approval or authorize merging/deployment.
