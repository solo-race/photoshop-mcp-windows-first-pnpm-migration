# P6 session identity repair

This addendum narrows P6 of [the main plan](001-photoshop-hardening-pnpm-router.md)
to the reported `PHOTOSHOP_SESSION_CHANGED` failure. It does not advance the
remaining native-document or Yueyue acceptance work.

## Acceptance status (2026-10-03)

U1–U4 acceptance is complete on the observed Windows host. U3 independent review
passed; final independent session-repair review PASS.

The selected identity is a unique CustomOptions key and epoch token installed
once with `persistent: false`, then compared by inspections and scoped dispatch
without replenishment. This choice is supported by cross-call observations and
an actual human-controlled restart, not by the parameter name or PID enumeration.

- Offline: this round, tester reported `pnpm run format:check` and lint passed;
  `pnpm test`: 58 passed.
- Same-session native: real inspections and registry create/query calls succeeded
  with the same Node process, Connection and document binding.
- Restart-native: the retained Connection rejected its old identity and document
  binding before the handler; a fresh Connection succeeded in the same Node
  process. COM/process binding remains unknown and is not used as identity.

Owned current-token, temporary-file and writer-lock cleanup completed; the
unavailable retired token was recorded separately. Document cleanup remained a
human responsibility. Broader P6 native checks, rendering and Yueyue integration
remain UNVERIFIED; these results do not establish behavior on other hosts or
Photoshop versions.

## Evidence and objective

At baseline `dcc7cb95230ef993e9d82958a23b0ba0254bf7ed`,
`src/platform/connection.ts` installs an epoch in `$.global` on the first
`inspectDocuments()` and checks it on later inspections and scoped dispatch.
`src/platform/windows-executor.ts` attaches with `GetObject` and executes each
temporary script through `DoJavaScriptFile`. The Yueyue report
`docs/media/photoshop/output/yp3-session-check.md` records one successful empty
query followed by failed create/query calls. It proves neither a Photoshop
restart nor the loss of the script marker.

Establish the actual cross-call COM storage semantics before selecting a fix.
Same-session inspections and scoped dispatch must succeed; a real session change
must still reject old document bindings. Reinstalling a missing marker on every
call or removing the session check is not an acceptable repair.

## Units, order and acceptance

The order is U1 → U2 → U3 → U4. The supervisor coordinates; the selected
implementer changes code, tester validates, and reviewer independently reviews
this unattended plan and its completed units.

### U1 — Prepare and review a bounded diagnostic probe

Prepare a temporary `.mjs` probe, outside the MCP registration chain. Do not
change production source, policy or dependencies. Its first group must use the
current WindowsExecutor invocation boundaries: install one uniquely named
diagnostic marker once, read it in that call, then read without reinstalling in
at least two separate calls. Capture marker presence/value and `$.engineName`.
Its second group must repeat the real Connection `inspectDocuments()` path,
including factory/API serialization, without extra COM calls between inspections.
Do not fabricate a document or task grant to exercise a scoped write.

Record process count, PID and creation time before and after the groups. Record
the actual COM-to-process binding if it can be established; otherwise explicitly
record it as unknown. Never select the first of multiple Photoshop processes.
Preserve original errors and distinguish an executed script reporting marker
absence from script-execution or response-parsing failure.

Only if the baseline evidence is insufficient, prepare a separately selected
comparison using the same GetObject attachment with DoJavaScript and $.evalFile.
Further targetengine or CustomOptions comparisons need a concrete unresolved
question and separate namespaces. No CreateObject, automatic launch/restart,
document edits, production artwork, policy changes or plugin installation.
Clean only probe-owned temporary files and diagnostic state, reporting cleanup
failure separately.

Acceptance: a concrete command and implementation are statically reviewable,
including writes and cleanup. Preparation is not native verification.

### U2 — Observe COM behavior and choose one identity

Run the reviewed probe only within an explicit execution contract. The managed
runtime route currently has only an Office adapter, so Photoshop COM execution
is blocked under that skill. Before running the prepared probe, obtain an
explicit user instruction allowing this bounded project-native execution in
place of that missing adapter; do not invent or install an adapter.

Compare the observed behavior with the production failure. Choose one minimal
identity mechanism: validated script-session storage, or PID plus creation time
for the process actually attached by COM. A process enumeration alone is not
proof of COM binding. Engine names and CustomOptions parameter names are not
proof of restart invalidation. If neither candidate is supported by evidence,
return the precise missing evidence rather than selecting a speculative fallback.

Acceptance: saved raw observations, a supported cross-call conclusion, and an
explicit identity decision. Cross-call stability and restart invalidation remain
separate claims.

### U3 — Implement and validate the minimum repair

Change only session identity acquisition/comparison and the necessary executor
interface. Keep inspection and actual dispatch tied to the same identity. Preserve
scope/grant checks, document/layer ID targeting, single-writer locking, protocol
stdout and manual Photoshop startup. No task-grant redesign, dual-mode fallback
or compatibility framework.

Add meaningful `.mjs` regressions that exercise the real Connection inspection
and guard paths using controlled executor responses, rather than replacing
`inspectDocuments()` itself. Cover successive calls within one identity, changed
identity rejection before an operation, and unavailable identity/execution errors
without silent acceptance. Update normative descriptions only if made inaccurate.

Tester runs applicable checks from `package.json`: `pnpm test` includes build;
do not precede it with a redundant build. Run lint and format checks, distinguishing
pre-existing failures from this change. Acceptance is scoped offline evidence,
followed by independent review; it is not P6 native acceptance.

### U4 — Validate native behavior with separate restart scope

Under the corresponding execution authorization, repeat the same-session
inspection sequence and the original failing path. Document creation or mutation
requires a specifically authorized disposable project/task/document; U1's
diagnostic permission does not imply that scope.

Verify restart invalidation separately while retaining the original MCP process,
Connection and old identity. A human must handle unsaved documents and control
Photoshop shutdown/reopening; do not quit an unattended Photoshop containing
unsaved work. Restarting MCP at the same time cannot prove rejection of old state.

Acceptance: direct evidence for same-session native behavior and for rejection
after a real restart, plus diagnostic cleanup. An unavailable restart check stays
UNVERIFIED and prevents declaring this repair subphase fully complete.

## Exit, exclusions and recovery

Report offline, same-session native and restart-native results separately. The
repair subphase completes only after U1–U4 criteria and independent review pass.
No full P6 rendering, history recovery, deployment, merge, Yueyue integration or
production-art acceptance is implied.

The main risks are diagnostic interference with the call environment, session
storage surviving a restart, and unknown COM/process binding. Use the unchanged
inspection sequence, independent restart check and explicit binding evidence to
resolve those risks. Temporary probes are removed or retained locally as evidence;
they never become externally callable MCP tools. Production changes remain
reviewable and reversible in the working tree; no automatic Photoshop recovery
is introduced.
