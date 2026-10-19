import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { allowedOn, assembleAgent, foreignNatives } from "../scripts/assemble-agent.mjs";
import { parseSums, sha256File } from "../scripts/lib.mjs";
import { nativeKindOfFile } from "../scripts/natives.mjs";

// A fake bundle and a fake Node mirror (file://) whose binaries carry real headers,
// so the pruning is checked for all five targets without the network.
const elf = (machine) => { const b = Buffer.alloc(64); b.write("\x7fELF", 0, "latin1"); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18); return b; };
const macho = (cpu) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; };
const pe = (machine) => { const b = Buffer.alloc(256); b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1"); b.writeUInt16LE(machine, 0x84); return b; };
const BIN = { "darwin-arm64": macho(0x0100000c), "darwin-x64": macho(0x01000007), "linux-x64": elf(0x3e), "linux-arm64": elf(0xb7), "win32-x64": pe(0x8664) };
const NODE_PLAT = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-x64": "linux-x64", "linux-arm64": "linux-arm64", "win32-x64": "win-x64" };

const write = (file, data) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, data); };
const tar = (args, cwd) => assert.equal(spawnSync("tar", args, { cwd }).status, 0);

describe("assemble-agent", { skip: process.platform === "win32" && "the assembler runs on Linux/macOS (tar, zip)" }, () => {
  let tmp;
  let out;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexa-assemble-"));
    const pkg = join(tmp, "bundle", "package");
    write(join(pkg, "package.json"), JSON.stringify({ name: "@fabbi-product-nexa/nexa-cli", version: "3.9.0" }));
    write(join(pkg, "nexa-bundle.json"), "{}");
    write(join(pkg, "LICENSE"), "Fabbi");
    write(join(pkg, "dist", "main.js"), "console.log('3.9.0')\n");
    write(join(pkg, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.10.0", gypfile: false }));
    for (const [t, bin] of Object.entries(BIN)) {
      for (const abi of [127, 137]) write(join(pkg, "node_modules", "better-sqlite3", "lib", "binding", `node-v${abi}-${t}`, "better_sqlite3.node"), bin);
      write(join(pkg, "node_modules", "pi-tui-like", "prebuilds", t, "native.node"), bin);
    }
    write(join(pkg, "node_modules", "pi-tui-like", "package.json"), JSON.stringify({ name: "pi-tui-like", version: "1.0.0" }));
    const rg = { "rg-linux-x64-gnu": ["linux", "x64", "glibc", "linux-x64"], "rg-linux-x64-musl": ["linux", "x64", "musl", "linux-x64"], "rg-darwin-arm64": ["darwin", "arm64", null, "darwin-arm64"], "rg-win32-x64": ["win32", "x64", null, "win32-x64"] };
    for (const [name, [os, cpu, libc, t]] of Object.entries(rg)) {
      const dir = join(pkg, "node_modules", "@fabbi-product-nexa", name);
      write(join(dir, "package.json"), JSON.stringify({ name: `@fabbi-product-nexa/${name}`, version: "3.9.0", os: [os], cpu: [cpu], ...(libc ? { libc: [libc] } : {}) }));
      write(join(dir, "bin", os === "win32" ? "rg.exe" : "rg"), BIN[t]);
    }
    tar(["-czf", join(tmp, "nexa-3.9.0.tgz"), "package"], join(tmp, "bundle"));

    const mirror = join(tmp, "mirror", "v22.0.0");
    const sums = [];
    for (const [t, plat] of Object.entries(NODE_PLAT)) {
      const base = `node-v22.0.0-${plat}`;
      const stage = join(tmp, "nodes", base);
      write(join(stage, "LICENSE"), "Node.js license");
      write(join(stage, t === "win32-x64" ? "node.exe" : join("bin", "node")), BIN[t]);
      const asset = t === "win32-x64" ? `${base}.zip` : `${base}.tar.gz`;
      mkdirSync(mirror, { recursive: true });
      if (t === "win32-x64") assert.equal(spawnSync("zip", ["-q", "-r", join(mirror, asset), base], { cwd: join(tmp, "nodes") }).status, 0);
      else tar(["-czf", join(mirror, asset), base], join(tmp, "nodes"));
      sums.push(`${sha256File(join(mirror, asset))}  ${asset}`);
    }
    writeFileSync(join(mirror, "SHASUMS256.txt"), sums.join("\n") + "\n");
    out = join(tmp, "dist");
    assembleAgent({ bundle: join(tmp, "nexa-3.9.0.tgz"), out, version: "3.9.0", node: "22.0.0", mirror: pathToFileURL(join(tmp, "mirror")).href, cache: join(tmp, "cache") });
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes five archives and a SHA256SUMS that matches them", () => {
    const sums = parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8"));
    assert.deepEqual([...sums.keys()].sort(), ["nexa-agent-darwin-arm64.tar.gz", "nexa-agent-darwin-x64.tar.gz", "nexa-agent-linux-arm64.tar.gz", "nexa-agent-linux-x64.tar.gz", "nexa-agent-windows-x64.zip"]);
    for (const [name, sha] of sums) assert.equal(sha256File(join(out, name)), sha, name);
  });

  for (const [t, asset, ext] of [["linux-x64", "linux-x64", "tar.gz"], ["darwin-arm64", "darwin-arm64", "tar.gz"], ["win32-x64", "windows-x64", "zip"]]) {
    it(`${t}: only its own natives, its sqlite addon in build/Release, launchers and agent.json`, () => {
      const x = mkdtempSync(join(tmp, `x-${t}-`));
      const file = join(out, `nexa-agent-${asset}.${ext}`);
      if (ext === "zip") assert.equal(spawnSync("unzip", ["-q", file, "-d", x]).status, 0);
      else tar(["-xzf", file, "-C", x]);
      const root = join(x, `nexa-agent-3.9.0-${asset}`);
      const [os, arch] = t.split("-");
      const target = { os, arch };
      assert.deepEqual(foreignNatives(root, target), []);
      const info = JSON.parse(readFileSync(join(root, "agent.json"), "utf8"));
      assert.equal(info.version, "3.9.0");
      assert.equal(info.target, t);
      assert.equal(info.node, "22.0.0");
      assert.ok(existsSync(join(root, info.runtime)) && existsSync(join(root, info.entry)));
      const lib = join(root, "lib", "node_modules", "@fabbi-product-nexa", "nexa-cli");
      const addon = join(lib, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
      assert.deepEqual(nativeKindOfFile(addon), { os, arch: [arch] });
      assert.equal(existsSync(join(lib, "node_modules", "better-sqlite3", "lib", "binding")), false);
      const rgs = readdirSync(join(lib, "node_modules", "@fabbi-product-nexa")).sort();
      assert.deepEqual(rgs, { "linux-x64": ["rg-linux-x64-gnu"], "darwin-arm64": ["rg-darwin-arm64"], "win32-x64": ["rg-win32-x64"] }[t]);
      if (os === "win32") {
        assert.match(readFileSync(join(root, "bin", "nexa.cmd"), "utf8"), /runtime\\node\.exe/);
      } else {
        for (const name of ["nexa-agent", "nexa"]) assert.ok(statSync(join(root, "bin", name)).mode & 0o111, `${name} is executable`);
        assert.ok(statSync(join(root, "runtime", "node")).mode & 0o111);
      }
    });
  }

  it("refuses a bundle that was not built by build-bundle.mjs", () => {
    const pkg = join(tmp, "old", "package");
    write(join(pkg, "package.json"), JSON.stringify({ name: "@fabbi-product-nexa/nexa-cli", version: "3.7.1" }));
    tar(["-czf", join(tmp, "old.tgz"), "package"], join(tmp, "old"));
    assert.throws(() => assembleAgent({ bundle: join(tmp, "old.tgz"), out: join(tmp, "dist-old"), node: "22.0.0", mirror: "file:///nowhere" }), /no nexa-bundle\.json/);
  });

  it("applies npm's os/cpu/libc rules", () => {
    assert.equal(allowedOn({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, { os: "linux", arch: "x64" }), false);
    assert.equal(allowedOn({ os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, { os: "linux", arch: "x64" }), true);
    assert.equal(allowedOn({ os: ["darwin"], libc: ["musl"] }, { os: "darwin", arch: "arm64" }), true);
    assert.equal(allowedOn({ os: ["!win32"] }, { os: "win32", arch: "x64" }), false);
    assert.equal(allowedOn({ cpu: ["arm64"] }, { os: "linux", arch: "x64" }), false);
    assert.equal(allowedOn({}, { os: "win32", arch: "x64" }), true);
  });
});
