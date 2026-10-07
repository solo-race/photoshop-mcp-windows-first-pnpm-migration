import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmpRoot = path.resolve(repoRoot, '.tmp');
const evidenceDirectories = ['cscript-host-gate-evidence', 'cscript-host-gate-unsandboxed-evidence'];
const script = 'WScript.Echo "CSCRIPT_HOST_GATE"\r\n';
const marker = 'CSCRIPT_HOST_GATE';

function ownedPath(outDir, name) {
  const target = path.resolve(outDir, name);
  const relative = path.relative(tmpRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Host diagnostic path must remain within repository .tmp');
  }
  return target;
}

// The dependency seam supports offline tests; the CLI selects only the two fixed evidence directories.
export async function runHostGate({
  execFile = nodeExecFile,
  mkdir = fsMkdir,
  writeFile = fsWriteFile,
} = {}, evidenceDirectory = evidenceDirectories[0]) {
  if (!evidenceDirectories.includes(evidenceDirectory)) throw new Error('Unsupported host evidence directory');
  const outDir = path.resolve(tmpRoot, evidenceDirectory);
  ownedPath(outDir, '.');
  // Exclusive directory creation is the one-run flag. Never reuse or remove it.
  await mkdir(outDir, { recursive: false });
  const startedAt = new Date().toISOString();
  await writeFile(ownedPath(outDir, 'run-started.json'), JSON.stringify({
    scope: 'wsh-host-only', startedAt,
  }, null, 2) + '\n', { flag: 'wx' });
  const scriptPath = ownedPath(outDir, 'host-gate.vbs');
  await writeFile(scriptPath, script, { encoding: 'ascii', flag: 'wx' });

  const started = performance.now();
  const { error, stdout, stderr } = await new Promise((resolve) => {
    execFile('cscript.exe', ['//nologo', scriptPath], {
      encoding: 'buffer', windowsHide: true, timeout: 5000,
      maxBuffer: 16384, shell: false,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  const elapsedMs = Math.round(performance.now() - started);
  await writeFile(ownedPath(outDir, 'stdout.bin'), stdout, { flag: 'wx' });
  await writeFile(ownedPath(outDir, 'stderr.bin'), stderr, { flag: 'wx' });

  const markerMatched = stdout.equals(Buffer.from(`${marker}\r\n`, 'ascii')) ||
    stdout.equals(Buffer.from(`${marker}\n`, 'ascii'));
  const passed = !error && markerMatched && stderr.length === 0;
  const result = {
    scope: 'wsh-host-only',
    phase: 'hostdiag',
    status: passed ? 'PASS' : 'STOP',
    startedAt,
    elapsedMs,
    executable: 'cscript.exe',
    args: ['//nologo', path.relative(repoRoot, scriptPath)],
    exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
    errorCode: error?.code ?? null,
    killed: error?.killed === true,
    signal: error?.signal ?? null,
    markerMatched,
    stdout: { file: 'stdout.bin', bytes: stdout.length, decoder: 'none' },
    stderr: { file: 'stderr.bin', bytes: stderr.length, decoder: 'none' },
    classification: 'exit result and exact raw ASCII marker; no text decoder',
    offlineDecodePolicy: 'Candidate decoding (including GBK) cannot change this classification.',
    originalPhotoshopDispatchInference: 'none',
    pendingStateAction: 'none',
  };
  await writeFile(ownedPath(outDir, 'run-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

export async function main(argv = process.argv.slice(2), dependencies) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    console.log('Usage: node tests/helpers/cscript-host-gate.mjs --run [--evidence-dir <directory>]\n' +
      'Default/--help performs no work. --run executes one fixed WSH Echo diagnostic.\n' +
      'Evidence directory: cscript-host-gate-evidence (default) or cscript-host-gate-unsandboxed-evidence, under .tmp (must not exist).\n' +
      'All evidence is retained. No retry, cleanup, Photoshop/COM access or pending-state change.');
    return 0;
  }
  const evidenceDirectory = argv.length === 1 && argv[0] === '--run' ? evidenceDirectories[0] :
    argv.length === 3 && argv[0] === '--run' && argv[1] === '--evidence-dir' &&
      evidenceDirectories.includes(argv[2]) ? argv[2] : undefined;
  if (!evidenceDirectory) {
    console.error('Use --help or --run [--evidence-dir <fixed directory>]; no script or arbitrary path input is accepted.');
    return 2;
  }
  try {
    const result = await runHostGate(dependencies, evidenceDirectory);
    console.log(JSON.stringify({ phase: result.phase, status: result.status,
      evidence: `.tmp/${evidenceDirectory}` }));
    return result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(`hostdiag STOP: evidence preparation or persistence failed (${error.code ?? error.name}). No retry or cleanup.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
