import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256File } from "../scripts/lib.mjs";

// site/nexa-agent-dl/install.ps1 on Windows, against a release served from 127.0.0.1.
// The archive is real in shape: agent.json, runtime/node.exe (this Node), and an entry
// script that prints the version, so the generated .cmd shims are exercised for real.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(ROOT, "site", "nexa-agent-dl", "install.ps1");
const ASSET = "nexa-agent-windows-x64.zip";
const ENTRY = "lib/node_modules/@fabbi-product-nexa/nexa-cli/dist/main.js";

describe("install.ps1", { skip: process.platform !== "win32" && "install.ps1 runs on Windows" }, () => {
  let tmp;
  let server;
  let base;

  const archive = (version) => {
    const name = `nexa-agent-${version}-windows-x64`;
    const stage = join(tmp, `stage-${version}`, name);
    mkdirSync(join(stage, "runtime"), { recursive: true });
    mkdirSync(join(stage, dirname(ENTRY)), { recursive: true });
    cpSync(process.execPath, join(stage, "runtime", "node.exe"));
    writeFileSync(join(stage, ENTRY), `console.log(${JSON.stringify(version)})\n`);
    writeFileSync(join(stage, "agent.json"), JSON.stringify({ product: "nexa-agent", version, target: "win32-x64", entry: ENTRY, runtime: "runtime/node.exe" }));
    const dist = join(tmp, "rel", "download", `v${version}`);
    mkdirSync(dist, { recursive: true });
    const zip = spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}' -DestinationPath '${join(dist, ASSET)}' -Force`], { encoding: "utf8" });
    assert.equal(zip.status, 0, zip.stderr);
    writeFileSync(join(dist, "SHA256SUMS"), `${sha256File(join(dist, ASSET))}  ${ASSET}\n`);
  };

  // Async on purpose: the release server runs in this process; spawnSync would block it
  // and the installer's download would wait forever.
  const install = (args, env = {}) =>
    new Promise((ok) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL, ...args], {
        env: { ...process.env, NEXA_AGENT_HOME: join(tmp, "agent"), NEXA_AGENT_DL_BASE: base, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => ok({ status, stdout, stderr }));
    });

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nexa-ps1-"));
    archive("3.7.1");
    server = createServer((req, res) => {
      const file = join(tmp, "rel", decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
      res.writeHead(200, { "content-length": statSync(file).size });
      createReadStream(file).pipe(res);
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs a pinned version and writes working nexa-agent and nexa shims", async () => {
    const res = await install(["-Version", "3.7.1", "-NoModifyPath"]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /sha256 verified/);
    for (const name of ["nexa-agent", "nexa"]) {
      const shim = join(tmp, "agent", "bin", `${name}.cmd`);
      assert.ok(existsSync(shim), `${shim} exists`);
      const out = spawnSync(shim, ["--version"], { encoding: "utf8", shell: true });
      assert.equal(out.stdout.trim(), "3.7.1", out.stderr);
    }
    assert.match(readFileSync(join(tmp, "agent", "bin", "nexa.cmd"), "utf8"), /runtime\\node\.exe/);
  });

  it("refuses a download whose checksum does not match", async () => {
    const sums = join(tmp, "rel", "download", "v3.7.1", "SHA256SUMS");
    const good = readFileSync(sums, "utf8");
    writeFileSync(sums, `${"0".repeat(64)}  ${ASSET}\n`);
    try {
      const res = await install(["-Version", "3.7.1", "-NoModifyPath"], { NEXA_AGENT_HOME: join(tmp, "agent-bad") });
      assert.notEqual(res.status, 0);
      assert.match(`${res.stdout}${res.stderr}`, /checksum mismatch/);
      assert.equal(existsSync(join(tmp, "agent-bad", "bin", "nexa-agent.cmd")), false);
    } finally {
      writeFileSync(sums, good);
    }
  });
});
