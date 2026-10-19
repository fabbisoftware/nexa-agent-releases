#!/usr/bin/env node
// Assemble the NEXA Agent archives: the NEXA CLI bundle (nexa-<v>.tgz, built by
// scripts/dist/build-bundle.mjs in the NEXA repo) plus an official Node 22 runtime,
// one archive per platform, each holding only that platform's native binaries.
//
//   node scripts/assemble-agent.mjs --bundle nexa-<v>.tgz --out dist [--version <v>]
//        [--node 22.x.y] [--targets darwin-arm64,linux-x64,…] [--node-mirror <url>] [--cache <dir>]
//
// Archive layout (the installers rely on agent.json and bin/):
//   nexa-agent-<v>-<os>-<arch>/
//     agent.json                 version, target, node, entry
//     bin/nexa-agent, bin/nexa   launchers (.cmd on Windows)
//     runtime/node[.exe], runtime/LICENSE
//     lib/node_modules/@fabbi-product-nexa/nexa-cli/   the bundle, pruned to this platform
//     LICENSE
// Writes the archives, SHA256SUMS and assets.json into --out. Nothing compiles: every
// binary comes prebuilt (Node from --node-mirror, verified against its SHASUMS256.txt).
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_ASSETS, compareVersions, parseArgs, parseSums, readJson, sha256File, writeJson } from "./lib.mjs";
import { nativeKindOfFile, runsOn } from "./natives.mjs";

const CLI = "@fabbi-product-nexa/nexa-cli";
export const ENTRY = `lib/node_modules/${CLI}/dist/main.js`;
const NODE_ABI = { 22: 127, 24: 137 };

const TARGETS = {
  "darwin-arm64": { os: "darwin", arch: "arm64", node: "darwin-arm64", ext: "tar.gz" },
  "darwin-x64": { os: "darwin", arch: "x64", node: "darwin-x64", ext: "tar.gz" },
  "linux-x64": { os: "linux", arch: "x64", node: "linux-x64", ext: "tar.gz" },
  "linux-arm64": { os: "linux", arch: "arm64", node: "linux-arm64", ext: "tar.gz" },
  "win32-x64": { os: "win32", arch: "x64", node: "win-x64", ext: "zip" },
};

export const SH_LAUNCHER = `#!/bin/sh
# NEXA Agent: run NEXA with the Node runtime shipped next to this script.
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
exec "$root/runtime/node" "$root/${ENTRY}" "$@"
`;

export const CMD_LAUNCHER = `@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\${ENTRY.replace(/\//g, "\\")}" %*\r\n`;

const log = (msg) => process.stderr.write(`${msg}\n`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${r.stderr ?? ""}`);
  return r.stdout ?? "";
}

function download(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return file;
  if (url.startsWith("file://")) {
    cpSync(new URL(url), file);
    return file;
  }
  run("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", `${file}.part`, url]);
  renameSync(`${file}.part`, file);
  return file;
}

/** Latest Node 22.x from the mirror's index.json. */
function latestNode22(mirror, cache) {
  const index = JSON.parse(readFileSync(download(`${mirror}/index.json`, join(cache, "node-index.json")), "utf8"));
  const v22 = index.map((r) => r.version.replace(/^v/, "")).filter((v) => v.startsWith("22.")).sort(compareVersions);
  if (!v22.length) throw new Error(`no Node 22 release in ${mirror}/index.json`);
  return v22.at(-1);
}

/** Does a package manifest's os/cpu/libc allow it on this target? (npm's rules; libc only on Linux.) */
export function allowedOn(manifest, target) {
  const ok = (list, value) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    if (list.includes(`!${value}`)) return false;
    const positive = list.filter((x) => !x.startsWith("!"));
    return positive.length === 0 || positive.includes(value);
  };
  if (!ok(manifest.os, target.os) || !ok(manifest.cpu, target.arch)) return false;
  if (target.os === "linux" && !ok(manifest.libc, "glibc")) return false;
  return true;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Remove packages and native files that cannot run on `target`; returns what was removed. */
export function pruneForTarget(pkgRoot, target, nodeMajor) {
  const removed = { packages: [], natives: [] };
  // Platform packages (rg-*, clipboard-*, …) declare os/cpu/libc; drop the other platforms'.
  const visit = (nodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dirs = entry.name.startsWith("@") ? readdirSync(join(nodeModules, entry.name)).map((n) => join(nodeModules, entry.name, n)) : [join(nodeModules, entry.name)];
      for (const dir of dirs) {
        const manifestFile = join(dir, "package.json");
        if (!existsSync(manifestFile)) continue;
        if (!allowedOn(readJson(manifestFile), target)) {
          rmSync(dir, { recursive: true, force: true });
          removed.packages.push(relative(pkgRoot, dir));
          continue;
        }
        visit(join(dir, "node_modules"));
      }
    }
  };
  visit(join(pkgRoot, "node_modules"));

  // better-sqlite3: keep the one prebuild for this platform and the bundled Node, in build/Release.
  const abi = NODE_ABI[nodeMajor];
  for (const file of walk(join(pkgRoot, "node_modules"))) {
    if (basename(file) !== "package.json") continue;
    const manifest = readJson(file);
    if (manifest.name !== "better-sqlite3") continue;
    const dir = join(file, "..");
    const prebuilt = join(dir, "lib", "binding", `node-v${abi}-${target.os}-${target.arch}`, "better_sqlite3.node");
    if (!existsSync(prebuilt)) throw new Error(`${relative(pkgRoot, dir)} has no prebuild for node-v${abi}-${target.os}-${target.arch}; rebuild the bundle with scripts/dist/build-bundle.mjs`);
    mkdirSync(join(dir, "build", "Release"), { recursive: true });
    renameSync(prebuilt, join(dir, "build", "Release", "better_sqlite3.node"));
    rmSync(join(dir, "lib", "binding"), { recursive: true, force: true });
  }

  // Any native file left that cannot run here (prebuilds other packages ship for every platform).
  for (const file of walk(pkgRoot)) {
    const kind = nativeKindOfFile(file);
    if (kind && !runsOn(kind, target)) {
      rmSync(file);
      removed.natives.push(relative(pkgRoot, file));
    }
  }
  return removed;
}

/** Native files under dir that cannot run on target; [] when the tree is clean. */
export function foreignNatives(dir, target) {
  return [...walk(dir)].filter((f) => {
    const kind = nativeKindOfFile(f);
    return kind && !runsOn(kind, target);
  });
}

function nodeRuntime(mirror, nodeVersion, target, sums, cache, dest) {
  const base = `node-v${nodeVersion}-${target.node}`;
  const asset = `${base}.${target.ext}`;
  const file = download(`${mirror}/v${nodeVersion}/${asset}`, join(cache, asset));
  const want = sums.get(asset);
  if (!want) throw new Error(`${asset} is not listed in SHASUMS256.txt of Node ${nodeVersion}`);
  const got = sha256File(file);
  if (got !== want) throw new Error(`${asset}: sha256 ${got} does not match SHASUMS256.txt (${want})`);
  const x = mkdtempSync(join(cache, "x-"));
  if (target.ext === "zip") run("unzip", ["-q", file, `${base}/node.exe`, `${base}/LICENSE`, "-d", x]);
  else run("tar", ["-xzf", file, "-C", x, `${base}/bin/node`, `${base}/LICENSE`]);
  mkdirSync(dest, { recursive: true });
  const binary = target.os === "win32" ? "node.exe" : "node";
  cpSync(join(x, base, target.os === "win32" ? "node.exe" : "bin/node"), join(dest, binary));
  cpSync(join(x, base, "LICENSE"), join(dest, "LICENSE"));
  if (binary === "node") chmodSync(join(dest, binary), 0o755);
  rmSync(x, { recursive: true, force: true });
  const kind = nativeKindOfFile(join(dest, binary));
  if (!runsOn(kind, target)) throw new Error(`${asset}: node binary is ${JSON.stringify(kind)}`);
}

function archive(stageParent, dirName, outFile, ext) {
  rmSync(outFile, { force: true });
  if (ext === "zip") {
    run("zip", ["-q", "-r", "-X", outFile, dirName], { cwd: stageParent });
    return;
  }
  const gnu = run("tar", ["--version"]).includes("GNU");
  const flags = gnu ? ["--owner=0", "--group=0", "--numeric-owner", "--sort=name"] : [];
  run("tar", ["-czf", outFile, ...flags, dirName], { cwd: stageParent });
}

export function assembleAgent({ bundle, out, version, node, targets = Object.keys(TARGETS), mirror = "https://nodejs.org/dist", cache }) {
  mkdirSync(out, { recursive: true });
  cache = cache ?? join(out, ".cache");
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "nexa-agent-"));
  try {
    run("tar", ["-xzf", bundle, "-C", work]);
    const pkg = join(work, "package");
    const manifest = readJson(join(pkg, "package.json"));
    if (manifest.name !== CLI) throw new Error(`${bundle} is ${manifest.name}, not ${CLI}`);
    if (version && manifest.version !== version) throw new Error(`${bundle} is ${manifest.version}, not ${version}`);
    version = manifest.version;
    if (!existsSync(join(pkg, "nexa-bundle.json"))) throw new Error(`${bundle} has no nexa-bundle.json: build it with scripts/dist/build-bundle.mjs (NEXA repo), which ships every platform's natives`);
    const nodeVersion = node ?? latestNode22(mirror, cache);
    const nodeMajor = Number(nodeVersion.split(".")[0]);
    if (!NODE_ABI[nodeMajor]) throw new Error(`Node ${nodeVersion}: no prebuilt better-sqlite3 ABI is known for major ${nodeMajor}`);
    const sums = parseSums(readFileSync(download(`${mirror}/v${nodeVersion}/SHASUMS256.txt`, join(cache, `SHASUMS256-${nodeVersion}.txt`)), "utf8"));
    const bundleSha = sha256File(bundle);

    const assets = [];
    for (const id of targets) {
      const target = TARGETS[id];
      if (!target) throw new Error(`unknown target ${id}; known: ${Object.keys(TARGETS).join(", ")}`);
      const asset = AGENT_ASSETS.find((a) => a.target === id);
      const dirName = `nexa-agent-${version}-${asset.name.replace(/^nexa-agent-/, "").replace(/\.(tar\.gz|zip)$/, "")}`;
      const stageParent = join(work, id);
      const root = join(stageParent, dirName);
      const lib = join(root, "lib", "node_modules", ...CLI.split("/"));
      log(`• ${id}: node ${nodeVersion} + bundle ${version}`);
      mkdirSync(lib, { recursive: true });
      cpSync(pkg, lib, { recursive: true });
      const removed = pruneForTarget(lib, target, nodeMajor);
      nodeRuntime(mirror, nodeVersion, target, sums, cache, join(root, "runtime"));
      mkdirSync(join(root, "bin"));
      for (const name of ["nexa-agent", "nexa"]) {
        if (target.os === "win32") writeFileSync(join(root, "bin", `${name}.cmd`), CMD_LAUNCHER);
        else {
          writeFileSync(join(root, "bin", name), SH_LAUNCHER);
          chmodSync(join(root, "bin", name), 0o755);
        }
      }
      if (existsSync(join(pkg, "LICENSE"))) cpSync(join(pkg, "LICENSE"), join(root, "LICENSE"));
      writeJson(join(root, "agent.json"), { product: "nexa-agent", version, target: id, node: nodeVersion, entry: ENTRY, runtime: target.os === "win32" ? "runtime/node.exe" : "runtime/node", bundle_sha256: bundleSha });
      const foreign = foreignNatives(root, target);
      if (foreign.length) throw new Error(`${id}: foreign native files left: ${foreign.slice(0, 5).join(", ")}`);
      const outFile = join(out, asset.name);
      archive(stageParent, dirName, outFile, target.ext);
      rmSync(stageParent, { recursive: true, force: true });
      assets.push({ name: asset.name, target: id, size: statSync(outFile).size, sha256: sha256File(outFile), pruned_packages: removed.packages.length, pruned_natives: removed.natives.length });
      log(`  ✓ ${asset.name} ${(statSync(outFile).size / 1048576).toFixed(1)} MB`);
    }
    writeFileSync(join(out, "SHA256SUMS"), assets.map((a) => `${a.sha256}  ${a.name}`).join("\n") + "\n");
    const info = { product: "nexa-agent", version, node: nodeVersion, bundle_sha256: bundleSha, assets };
    writeJson(join(out, "assets.json"), info);
    return info;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2), { values: ["bundle", "out", "version", "node", "targets", "node-mirror", "cache"] });
    if (!args.bundle || !args.out) throw new Error("usage: assemble-agent.mjs --bundle nexa-<v>.tgz --out <dir> [--version <v>] [--node 22.x.y] [--targets a,b]");
    const info = assembleAgent({
      bundle: resolve(args.bundle),
      out: resolve(args.out),
      version: args.version?.replace(/^v/, ""),
      node: args.node?.replace(/^v/, ""),
      targets: args.targets ? args.targets.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      mirror: args["node-mirror"]?.replace(/\/$/, ""),
      cache: args.cache ? resolve(args.cache) : undefined,
    });
    process.stdout.write(`✓ NEXA Agent ${info.version} (node ${info.node}): ${info.assets.length} archives in ${resolve(args.out)}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}
