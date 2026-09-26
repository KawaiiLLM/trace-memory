// Test the distributable, not a checkout alias. No registry, credentials or real model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageJSON } from "node:module";
import { DefaultPackageManager, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "trace-memory-package-"));
const cwd = process.cwd(), environment = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TRACE_MEMORY_CONFIG: process.env.TRACE_MEMORY_CONFIG, NODE_PATH: process.env.NODE_PATH };
const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
// Native ESM resolution handles import-only packages and SDK-nested dependencies alike.
const peerManifest = (peer, from = sdkEntry) => {
  const path = findPackageJSON(peer, from);
  assert.ok(path, `Cannot resolve declared peer ${peer} from ${from}`);
  return realpathSync(path);
};
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*", "runtime TUI import must be a declared peer");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  assert.deepEqual(lock.packages[""].engines, manifest.engines);
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8", timeout: 60000 }));
  const files = pack.files.map(file => file.path);
  for (const required of ["src/hosts/phase-settings.ts", "src/hosts/status-line.ts", "src/hosts/trace-menu.ts", "src/hosts/pi/index.ts", "src/hosts/pi/session-status.ts", "src/hosts/pi/context-composition.ts", "src/hosts/pi/session-panel.ts", "src/hosts/pi/native.ts", "src/hosts/pi/fork.ts", "src/core/prompts/noting.md", "src/core/prompts/dreaming.md", "src/core/dreaming/index.ts", "docs/core.md", "docs/pi.md", "docs/live-verification.md", "CONTEXT.md", "README.md", "LICENSE"])
    assert.ok(files.includes(required), `Missing runtime file: ${required}`);
  assert.ok(!files.some(path => path.startsWith("src/core/consolidation/") || path === "src/core/prompts/consolidation.md"), "Retired live C must not ship");
  assert.deepEqual(files.filter(path => /\.test\.ts$|__snapshots__|^tests?\/|^src\/hosts\/cc\/|test-host|native-fixture|smoke\.ts$|^\.scratch\/|\.(sqlite|db)$/.test(path)), [], "Development files or databases must not ship");

  // 76 review: no registry step. Every runtime dependency must already sit in this checkout's
  // node_modules at the version package-lock.json pins; pack that local directory (not the registry)
  // and install its tarball beside the package's own, fully offline against an unreachable registry.
  const dependencyTarballs = Object.keys(manifest.dependencies ?? {}).map(name => {
    const lockEntry = lock.packages[`node_modules/${name}`];
    assert.ok(lockEntry, `package-lock.json has no entry for node_modules/${name}`);
    const depDir = join(root, "node_modules", name);
    let installedManifest;
    try { installedManifest = JSON.parse(readFileSync(join(depDir, "package.json"), "utf8")); }
    catch { throw new Error(`Missing local dependency: node_modules/${name}/package.json (run npm install first)`); }
    assert.equal(installedManifest.version, lockEntry.version,
      `node_modules/${name}@${installedManifest.version} does not match package-lock.json's pinned ${name}@${lockEntry.version}`);
    const [depPack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: depDir, encoding: "utf8", timeout: 60000 }));
    return { name, version: lockEntry.version, filename: depPack.filename };
  });

  const consumer = join(temporary, "consumer"), agentDir = join(temporary, "agent");
  mkdirSync(consumer); mkdirSync(agentDir);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const isolatedCache = join(temporary, "cache");
  execFileSync("npm", ["install", join(temporary, pack.filename), ...dependencyTarballs.map(dep => join(temporary, dep.filename)),
      "--offline", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund",
      "--registry", "http://127.0.0.1:9", "--cache", isolatedCache],
    { cwd: consumer, encoding: "utf8", timeout: 60000 });
  const installed = join(consumer, "node_modules", manifest.name);
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, manifest.version);
  for (const dep of dependencyTarballs) {
    const installedVersion = JSON.parse(readFileSync(join(consumer, "node_modules", dep.name, "package.json"), "utf8")).version;
    assert.equal(installedVersion, dep.version, `installed ${dep.name}@${installedVersion} does not match package-lock.json's ${dep.version}`);
  }
  // Pi supplies its SDK peers. Link only those installed packages, never this repository or its fixtures.
  for (const peer of Object.keys(manifest.peerDependencies)) {
    const destination = join(consumer, "node_modules", peer);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(dirname(peerManifest(peer)), destination, "dir");
  }

  process.env.NODE_PATH = "";
  process.chdir(consumer);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath: join(temporary, "discovery.sqlite") });
  const packages = new DefaultPackageManager({ cwd: consumer, agentDir, settingsManager: SettingsManager.inMemory() });
  const resources = await packages.resolveExtensionSources([installed], { temporary: true });
  assert.equal(resources.extensions.length, 1, "Pi must discover exactly one extension");
  assert.equal(resources.extensions[0].enabled, true);
  const entry = resources.extensions[0].path;
  assert.ok(entry.startsWith(installed + "/"), "discovery must not fall back to checkout");
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedManifest.peerDependencies, manifest.peerDependencies);
  // Verify every declared peer through native ESM resolution from the installed entry.
  // The separate real Pi loader below remains the runtime acceptance gate.
  for (const peer of Object.keys(manifest.peerDependencies)) {
    const linked = JSON.parse(readFileSync(join(consumer, "node_modules", peer, "package.json"), "utf8"));
    assert.equal(linked.name, peer);
    assert.equal(peerManifest(peer, entry), peerManifest(peer));
  }
  const loaded = await discoverAndLoadExtensions([entry], consumer, agentDir);
  try {
    assert.deepEqual(loaded.errors, [], "The installed extension must load without errors");
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["memory", "note", "search", "trace"]);
  } finally {
    for (const extension of loaded.extensions)
      for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({ type: "session_shutdown", reason: "quit" }, {});
  }
  // Reuse the native-worker smoke with the installed factory; only its test harness comes from source.
  process.stdout.write(execFileSync(process.execPath, [join(root, "tests/hosts/pi/smoke.ts"), entry],
    { cwd: consumer, encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_PATH: "" } }));
  console.log(`Package smoke passed: ${manifest.name}@${manifest.version}, ${files.length} shipped files, ${pack.size} packed bytes; offline tarball install, Pi discovery/load, Current session overlay and native Noting/Dreaming.`);
} finally {
  process.chdir(cwd);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temporary, { recursive: true, force: true });
}
