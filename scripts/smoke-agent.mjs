#!/usr/bin/env node
// Install NEXA Agent with the real installer of this platform and check it runs.
//
//   node scripts/smoke-agent.mjs --dist <dir> --version <v>   serve <dir> (archives + SHA256SUMS) as a
//                                                              GitHub-like release on 127.0.0.1
//   node scripts/smoke-agent.mjs --live [--version <v>]       the published installer and release
//
// Installs into a throwaway NEXA_AGENT_HOME with --no-modify-path, so nothing on the
// machine changes. Checks: nexa-agent/nexa --version, --help, the bundled Node loads
// better-sqlite3, ripgrep runs, `nexa init` scaffolds > 100 files, `nexa status`.
// One line per check; exit 1 on the first failure.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, readJson, SITE_BASE } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

/** Serve <dist> at /download/v<version>/<file> and /latest/download/<file>. */
function serve(dist, version) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const m = /^\/(?:download\/v[^/]+|latest\/download)\/([^/]+)$/.exec(path);
    const prefix = `/download/v${version}/`;
    const file = m && (path.startsWith(prefix) || path.startsWith("/latest/")) ? join(dist, normalize(m[1])) : null;
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** spawn, but async: the local release server lives in this process and must keep serving. */
function runAsync(cmd, args, opts) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => ok({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  return n;
}

const hostRg = () => {
  if (process.platform === "linux") return `rg-linux-${process.arch}-gnu`;
  if (process.platform === "darwin") return `rg-darwin-${process.arch}`;
  return "rg-win32-x64";
};

export async function smokeAgent({ dist, version, live = false }) {
  const check = (name, ok, detail = "") => {
    process.stdout.write(`${ok ? "✓" : "✗"} ${name}${detail ? ` - ${detail}` : ""}\n`);
    if (!ok) throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  };
  const home = mkdtempSync(join(tmpdir(), "nexa-agent-home-"));
  const work = mkdtempSync(join(tmpdir(), "nexa-agent-work-"));
  let server;
  try {
    const env = { ...process.env, NEXA_AGENT_HOME: home, NEXA_LICENSE_DEV: "1", NO_COLOR: "1" };
    if (!live) {
      server = await serve(dist, version);
      env.NEXA_AGENT_DL_BASE = `http://127.0.0.1:${server.address().port}`;
    }
    const versionArgs = version ? (WIN ? ["-Version", version] : ["--version", version]) : [];
    let install;
    const t0 = Date.now();
    if (WIN) {
      const script = live ? join(work, "install.ps1") : join(ROOT, "site", "nexa-agent-dl", "install.ps1");
      if (live) spawnSync("curl", ["-fsSL", "-o", script, `${SITE_BASE}/nexa-agent-dl/install.ps1`]);
      install = await runAsync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...versionArgs, "-NoModifyPath"], { env });
    } else if (live) {
      install = await runAsync("bash", ["-c", `curl -fsSL ${SITE_BASE}/nexa-agent-dl/install.sh | bash -s -- --no-modify-path ${versionArgs.join(" ")}`], { env });
    } else {
      install = await runAsync("bash", [join(ROOT, "site", "nexa-agent-dl", "install.sh"), ...versionArgs, "--no-modify-path"], { env });
    }
    check("installer", install.status === 0, install.status === 0 ? `${((Date.now() - t0) / 1000).toFixed(1)}s` : `${install.stdout}\n${install.stderr}`.trim().split("\n").slice(-6).join(" | "));

    const bin = (name) => join(home, "bin", WIN ? `${name}.cmd` : name);
    const run = (name, args, opts = {}) => spawnSync(bin(name), args, { env, encoding: "utf8", shell: WIN, timeout: 180000, ...opts });
    for (const name of ["nexa-agent", "nexa"]) {
      const r = run(name, ["--version"]);
      const got = (r.stdout ?? "").trim();
      check(`${name} --version`, r.status === 0 && (!version || got === version), `${got || r.stderr?.trim() || "(none)"}${version ? ` (want ${version})` : ""}`);
    }
    check("nexa --help", run("nexa", ["--help"]).status === 0);

    // The installed tree: <home>/versions/<v>/<dir>/{agent.json,runtime,lib}
    const versionsDir = join(home, "versions");
    const installed = readdirSync(versionsDir)[0];
    const [agentDirName] = readdirSync(join(versionsDir, installed)).filter((d) => existsSync(join(versionsDir, installed, d, "agent.json")));
    const agentDir = join(versionsDir, installed, agentDirName);
    const info = readJson(join(agentDir, "agent.json"));
    const node = join(agentDir, info.runtime);
    const cli = join(agentDir, "lib", "node_modules", "@fabbi-product-nexa", "nexa-cli");
    const sqlite = spawnSync(node, ["-e", `const D=require(${JSON.stringify(join(cli, "node_modules", "better-sqlite3"))});new D(':memory:').exec('create table t(x)');console.log(process.version)`], { encoding: "utf8" });
    check("bundled Node loads better-sqlite3", sqlite.status === 0, sqlite.status === 0 ? `node ${sqlite.stdout.trim()}` : (sqlite.stderr ?? "").trim().split("\n")[0]);
    const rgBin = join(cli, "node_modules", "@fabbi-product-nexa", hostRg(), "bin", WIN ? "rg.exe" : "rg");
    const rg = existsSync(rgBin) ? spawnSync(rgBin, ["--version"], { encoding: "utf8" }) : null;
    check("ripgrep runs", Boolean(rg && rg.status === 0), rg ? (rg.error ? String(rg.error.code) : (rg.stdout ?? "").split("\n")[0]) : `${rgBin} missing`);

    const init = run("nexa", ["init"], { cwd: work });
    const files = init.status === 0 ? countFiles(work) : 0;
    check("nexa init", init.status === 0 && files > 100, `${files} files${init.status === 0 ? "" : `; ${(init.stderr ?? "").trim().split("\n").slice(-2).join(" | ")}`}`);
    check("nexa status", run("nexa", ["status"], { cwd: work }).status === 0);
    return { home, version: info.version, node: info.node };
  } finally {
    server?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["live"], values: ["dist", "version"] });
    if (!args.live && (!args.dist || !args.version)) throw new Error("usage: smoke-agent.mjs --dist <dir> --version <v> | --live [--version <v>]");
    await smokeAgent({ dist: args.dist && resolve(args.dist), version: args.version?.replace(/^v/, ""), live: Boolean(args.live) });
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}

