import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { linkedPaths, livePaths, missingLocally, pathToFile, snapshot, syncPlan, unservedDownloads } from "../scripts/deploy.mjs";
import { sha256 } from "../scripts/lib.mjs";

const BASE = "https://downloads.agilekit.cc";

describe("deploy guard", () => {
  it("collects same-site links, relative and absolute, and ignores other sites", () => {
    const html = `<a href="/">home</a><a href="install.sh">i</a><a href="/dwb-dl/">dwb</a>
      <a href="https://github.com/x/y">gh</a><pre>npm i -g https://downloads.agilekit.cc/dwb-dl/dwb-0.2.2.tgz</pre>
      <a href="QUICKSTART.md#top">q</a>`;
    assert.deepEqual([...linkedPaths(`${BASE}/nexa-dl/`, html)].sort(), ["/", "/dwb-dl/", "/dwb-dl/dwb-0.2.2.tgz", "/nexa-dl/QUICKSTART.md", "/nexa-dl/install.sh"]);
  });

  it("maps URL paths to the files Pages serves", () => {
    assert.equal(pathToFile("/nexa-dl/"), "nexa-dl/index.html");
    assert.equal(pathToFile("/dwb-dl/dwb-0.2.2.tgz"), "dwb-dl/dwb-0.2.2.tgz");
  });

  it("crawls the live entry pages and the scripts they name", () => {
    const pages = {
      [`${BASE}/nexa-dl/`]: `<a href="install.sh">x</a><a href="/dwb-dl/">dwb</a>`,
      [`${BASE}/nexa-dl/install.sh`]: `curl ${BASE}/nexa-dl/versions.json`,
      [`${BASE}/nexa-dl/versions.json`]: "{}",
      [`${BASE}/dwb-dl/`]: `npm i -g ${BASE}/dwb-dl/dwb-0.2.2.tgz <a href="dwb-bootstrap-client.sh">c</a>`,
      [`${BASE}/dwb-dl/dwb-0.2.2.tgz`]: "tgz",
      [`${BASE}/dwb-dl/dwb-bootstrap-client.sh`]: "#!/bin/sh",
    };
    const get = (url) => (url in pages ? { status: 200, body: Buffer.from(pages[url]) } : { status: 404, body: Buffer.alloc(0) });
    assert.deepEqual(livePaths(get, ["/nexa-dl/", "/dwb-dl/", "/nexa-agent-dl/"], BASE), [
      "/dwb-dl/",
      "/dwb-dl/dwb-0.2.2.tgz",
      "/dwb-dl/dwb-bootstrap-client.sh",
      "/nexa-dl/",
      "/nexa-dl/install.sh",
      "/nexa-dl/versions.json",
    ]);
  });

  describe("with a site root on disk", () => {
    let root;
    let site;
    before(() => {
      const tmp = mkdtempSync(join(tmpdir(), "nexa-deploy-"));
      site = join(tmp, "site");
      root = join(tmp, "root");
      for (const d of [join(site, "nexa-dl"), join(site, "nexa-agent-dl"), join(root, "nexa-dl"), join(root, "dwb-dl")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(site, "nexa-dl", "index.html"), "new");
      writeFileSync(join(site, "nexa-dl", "install.sh"), "same");
      writeFileSync(join(site, "nexa-agent-dl", "index.html"), "agent");
      writeFileSync(join(root, "nexa-dl", "index.html"), "old");
      writeFileSync(join(root, "nexa-dl", "install.sh"), "same");
      writeFileSync(join(root, "nexa-dl", "nexa-old.tgz"), "kept");
      writeFileSync(join(root, "dwb-dl", "index.html"), "dwb");
      writeFileSync(join(root, ".DS_Store"), "x");
    });
    after(() => rmSync(join(root, ".."), { recursive: true, force: true }));

    it("plans adds and updates only, never removals", () => {
      assert.deepEqual(syncPlan(site, root).map(({ file, change }) => `${change} ${file}`), ["update nexa-dl/index.html", "add nexa-agent-dl/index.html"]);
    });

    it("reports live paths that the site root lacks", () => {
      assert.deepEqual(missingLocally(["/dwb-dl/", "/dwb-dl/dwb-0.2.2.tgz", "/nexa-dl/install.sh"], root), ["dwb-dl/dwb-0.2.2.tgz"]);
    });

    it("snapshots files with their sha256, skipping dotfiles", () => {
      assert.deepEqual(Object.keys(snapshot(root)), ["dwb-dl/index.html", "nexa-dl/index.html", "nexa-dl/install.sh", "nexa-dl/nexa-old.tgz"]);
    });
  });
});

describe("downloads guard (the pages never advertise what cannot be downloaded)", () => {
  let site;
  const TGZ = Buffer.from("the 3.8.0 tarball");
  const SUMS = `${"c".repeat(64)}  nexa-agent-linux-x64.tar.gz\n`;
  const TGZ_URL = "https://dl.agilekit.cc/nexa-3.8.0.tgz";
  const SUMS_URL = "https://github.com/fabbisoftware/nexa-agent-releases/releases/download/v3.8.0/SHA256SUMS";
  const server = (pages) => {
    const asked = [];
    const get = (url) => {
      asked.push(url);
      return url in pages ? { status: 200, body: Buffer.from(pages[url]) } : { status: 404, body: Buffer.alloc(0) };
    };
    return { get, asked };
  };
  before(() => {
    site = join(mkdtempSync(join(tmpdir(), "nexa-unserved-")), "site");
    mkdirSync(join(site, "nexa-dl"), { recursive: true });
    mkdirSync(join(site, "nexa-agent-dl"), { recursive: true });
    writeFileSync(join(site, "nexa-dl", "versions.json"), JSON.stringify({ latest: "3.8.0", versions: [{ version: "3.8.0", sha256: sha256(TGZ) }, { version: "3.7.1", sha256: "a".repeat(64) }] }));
    writeFileSync(join(site, "nexa-agent-dl", "releases.json"), JSON.stringify({ latest: "3.8.0", releases: [{ version: "3.8.0", assets: [{ name: "nexa-agent-linux-x64.tar.gz", sha256: "c".repeat(64) }] }] }));
  });
  after(() => rmSync(join(site, ".."), { recursive: true, force: true }));

  it("passes when the latest tarball and the latest release are both downloadable", () => {
    assert.deepEqual(unservedDownloads(site, { get: server({ [TGZ_URL]: TGZ, [SUMS_URL]: SUMS }).get }), []);
  });

  it("refuses a nexa-dl page whose latest tarball is not on R2 (a lost staging branch)", () => {
    assert.deepEqual(unservedDownloads(site, { get: server({ [SUMS_URL]: SUMS }).get }), [`nexa-dl advertises 3.8.0, but ${TGZ_URL} answers HTTP 404`]);
    assert.match(unservedDownloads(site, { get: server({ [TGZ_URL]: "other bytes", [SUMS_URL]: SUMS }).get })[0], /is not the tarball nexa-dl\/versions.json lists/);
  });

  it("refuses an agent page whose latest release is still a draft, or has other archives", () => {
    assert.deepEqual(unservedDownloads(site, { get: server({ [TGZ_URL]: TGZ }).get }), [`nexa-agent-dl advertises 3.8.0, but release v3.8.0 is not published (${SUMS_URL}: HTTP 404)`]);
    assert.deepEqual(unservedDownloads(site, { get: server({ [TGZ_URL]: TGZ, [SUMS_URL]: `${"d".repeat(64)}  nexa-agent-linux-x64.tar.gz\n` }).get }), [
      "release v3.8.0: SHA256SUMS differs from nexa-agent-dl/releases.json for nexa-agent-linux-x64.tar.gz",
    ]);
  });

  it("leaves the version this run uploads or publishes to that step", () => {
    const { get, asked } = server({});
    assert.deepEqual(unservedDownloads(site, { uploads: "3.8.0", publishes: "3.8.0", get }), []);
    assert.deepEqual(asked, []);
  });
});
