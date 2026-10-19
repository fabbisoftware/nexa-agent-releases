import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256File } from "../scripts/lib.mjs";

// site/nexa-agent-dl/install.sh against a fake file:// release laid out like GitHub's
// (download/v<ver>/<asset>, latest/download/<asset>), so no network is needed.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = join(ROOT, "site", "nexa-agent-dl", "install.sh");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `nexa-agent-${OS}-${ARCH}.tar.gz`;
const posix = process.platform === "linux" || process.platform === "darwin";

describe("install.sh", { skip: !posix && "install.sh is for macOS and Linux" }, () => {
  let tmp;
  let rel;

  const run = (args, env = {}) =>
    spawnSync("bash", [INSTALL, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: join(tmp, "home"), SHELL: "/bin/bash", NEXA_AGENT_DL_BASE: `file://${rel}`, NEXA_AGENT_HOME: join(tmp, "agent"), ...env },
    });

  /** A release dir holding one archive in the real layout: agent.json, bin/nexa-agent, bin/nexa. */
  const release = (version, { withInfo = true } = {}) => {
    const name = `nexa-agent-${version}-${OS}-${ARCH}`;
    const stage = join(tmp, `stage-${version}-${withInfo}`);
    mkdirSync(join(stage, name, "bin"), { recursive: true });
    for (const cmd of ["nexa-agent", "nexa"]) {
      writeFileSync(join(stage, name, "bin", cmd), `#!/bin/sh\necho "${version}"\n`);
      chmodSync(join(stage, name, "bin", cmd), 0o755);
    }
    if (withInfo) writeFileSync(join(stage, name, "agent.json"), JSON.stringify({ product: "nexa-agent", version, target: `${OS}-${ARCH}` }));
    const dist = join(tmp, `dist-${version}-${withInfo}`);
    mkdirSync(dist);
    assert.equal(spawnSync("tar", ["-czf", join(dist, ASSET), "-C", stage, name]).status, 0);
    writeFileSync(join(dist, "SHA256SUMS"), `${sha256File(join(dist, ASSET))}  ${ASSET}\n`);
    return dist;
  };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexa-agent-install-"));
    rel = join(tmp, "rel");
    mkdirSync(join(tmp, "home"));
    cpSync(release("3.7.1"), join(rel, "download", "v3.7.1"), { recursive: true });
    cpSync(release("3.7.2"), join(rel, "download", "v3.7.2"), { recursive: true });
    cpSync(join(rel, "download", "v3.7.2"), join(rel, "latest", "download"), { recursive: true });
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("installs the latest release, links nexa-agent and nexa, and adds PATH once", () => {
    const first = run([]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /sha256 verified/);
    assert.match(first.stdout, /commands: nexa nexa-agent|commands: nexa-agent nexa/);
    for (const cmd of ["nexa-agent", "nexa"]) {
      assert.equal(spawnSync(join(tmp, "agent", "bin", cmd), { encoding: "utf8" }).stdout.trim(), "3.7.2");
    }
    assert.equal(readlinkSync(join(tmp, "agent", "current")), "versions/3.7.2");
    assert.equal(run([]).status, 0);
    const rc = readFileSync(join(tmp, "home", OS === "darwin" ? ".bash_profile" : ".bashrc"), "utf8");
    assert.equal(rc.split("# NEXA Agent").length - 1, 1);
  });

  it("pins an older version and leaves the profile alone with --no-modify-path", () => {
    mkdirSync(join(tmp, "home2"));
    const res = run(["--version", "3.7.1", "--no-modify-path"], { HOME: join(tmp, "home2") });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(spawnSync(join(tmp, "agent", "bin", "nexa"), { encoding: "utf8" }).stdout.trim(), "3.7.1");
    assert.equal(existsSync(join(tmp, "home2", ".bashrc")), false);
  });

  it("refuses an archive whose checksum does not match SHA256SUMS", () => {
    const bad = join(tmp, "rel-bad");
    cpSync(rel, bad, { recursive: true });
    appendFileSync(join(bad, "latest", "download", ASSET), "tampered");
    const res = run([], { NEXA_AGENT_DL_BASE: `file://${bad}`, NEXA_AGENT_HOME: join(tmp, "agent-bad") });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(tmp, "agent-bad", "bin", "nexa-agent")), false);
  });

  it("refuses an archive that is not a NEXA Agent archive", () => {
    const odd = join(tmp, "rel-odd");
    cpSync(release("9.0.0", { withInfo: false }), join(odd, "download", "v9.0.0"), { recursive: true });
    const res = run(["--version", "9.0.0"], { NEXA_AGENT_DL_BASE: `file://${odd}`, NEXA_AGENT_HOME: join(tmp, "agent-odd") });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no agent\.json/);
  });

  it("points to the npm CLI when the release has no build for this platform", () => {
    const empty = join(tmp, "rel-empty", "download", "v2.0.0");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "SHA256SUMS"), `${"0".repeat(64)}  nexa-agent-windows-x64.zip\n`);
    const res = run(["--version", "2.0.0"], { NEXA_AGENT_DL_BASE: `file://${join(tmp, "rel-empty")}` });
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`no build for ${OS}-${ARCH}.*nexa-dl`));
  });
});
