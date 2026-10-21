import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, markdownToHtml, parseSums, readRegion, replaceRegion } from "../scripts/lib.mjs";
import { checkSite, driftFrom, liveSite, renderAgent, renderCli } from "../scripts/render-site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
// The renderer refuses versions that are not newer than what site/ lists, and site/
// moves with every release: render one patch above the newest version there.
const readSite = (f) => JSON.parse(readFileSync(join(ROOT, "site", f), "utf8"));
const LATEST = readSite("nexa-dl/versions.json").latest;
const AGENT_LATEST = readSite("nexa-agent-dl/releases.json").latest;
const NEXT = [LATEST, AGENT_LATEST ?? LATEST].sort(compareVersions)[1].replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
const re = (v) => v.replace(/\./g, "\\.");

describe("lib", () => {
  it("orders versions like semver, prereleases before the release", () => {
    const sorted = ["3.7.1", "3.2.0-alpha.10", "3.2.0-alpha.23.1", "3.2.0-alpha.9", "3.10.0", "3.2.0", "3.2.0-alpha.23"].sort(compareVersions);
    assert.deepEqual(sorted, ["3.2.0-alpha.9", "3.2.0-alpha.10", "3.2.0-alpha.23", "3.2.0-alpha.23.1", "3.2.0", "3.7.1", "3.10.0"]);
  });

  it("turns release notes into escaped HTML", () => {
    assert.equal(markdownToHtml("Adds `nexa x` <b>now</b>.\n\n- one\n- **two**"), '<p>Adds <code class="k">nexa x</code> &lt;b&gt;now&lt;/b&gt;.</p>\n<ul class="reqs"><li>one</li><li><b>two</b></li></ul>');
    assert.equal(markdownToHtml("[docs](https://example.com/a) and [bad](javascript:alert(1))"), '<p><a href="https://example.com/a">docs</a> and [bad](javascript:alert(1))</p>');
  });

  it("replaces exactly one marker region", () => {
    assert.equal(replaceRegion("a<!--nexa:v-->1<!--/nexa:v-->b", "v", "2"), "a<!--nexa:v-->2<!--/nexa:v-->b");
    assert.equal(readRegion("x<!-- nexa:n -->keep<!-- /nexa:n -->", "n"), "keep");
    assert.throws(() => replaceRegion("no markers", "v", "2"), /exactly one nexa:v region/);
  });

  it("parses SHA256SUMS in both sha256sum formats", () => {
    const sums = parseSums(`${SHA}  a.tar.gz\n${"b".repeat(64)} *b.zip\n`);
    assert.equal(sums.get("a.tar.gz"), SHA);
    assert.equal(sums.get("b.zip"), "b".repeat(64));
  });
});

describe("render-site", () => {
  let site;
  before(() => {
    site = join(mkdtempSync(join(tmpdir(), "nexa-site-")), "site");
    cpSync(join(ROOT, "site"), site, { recursive: true });
  });
  after(() => rmSync(dirname(site), { recursive: true, force: true }));

  it("the committed site is consistent", () => {
    assert.deepEqual(checkSite(join(ROOT, "site")), []);
  });

  it("renders a CLI version into every place that names it, and nothing else changes", () => {
    const before = readFileSync(join(site, "nexa-dl", "index.html"), "utf8");
    renderCli(site, { version: NEXT, sha256: SHA, size: 61234567, date: "2026-10-20", notesHtml: `<p>Notes for ${NEXT}.</p>`, multiPlatform: true });
    const after = readFileSync(join(site, "nexa-dl", "index.html"), "utf8");
    assert.deepEqual(checkSite(site), []);
    assert.equal(readRegion(after, "version"), `v${NEXT}`);
    assert.equal(readRegion(after, "tgz-url"), `https://dl.agilekit.cc/nexa-${NEXT}.tgz`);
    const log = readRegion(after, "changelog");
    assert.match(log, new RegExp(`^\\s*<div class="item">\\s*<span class="v">${re(NEXT)}</span><span class="tag-new">latest</span>\\s*<p>Notes for ${re(NEXT)}\\.</p>`));
    assert.equal(log.match(/tag-new">latest/g).length, 1);
    assert.ok(log.includes(`<span class="v">${LATEST}</span>`), "older entries stay");
    // Outside the marker regions the page is byte-for-byte unchanged.
    const strip = (html) => html.replace(/<!--\s*nexa:(\w[\w-]*)\s*-->[\s\S]*?<!--\s*\/nexa:\1\s*-->/g, "");
    assert.equal(strip(after), strip(before));

    const versions = JSON.parse(readFileSync(join(site, "nexa-dl", "versions.json"), "utf8"));
    assert.equal(versions.latest, NEXT);
    assert.deepEqual(versions.versions[0], { version: NEXT, url: `https://dl.agilekit.cc/nexa-${NEXT}.tgz`, sha256: SHA, date: "2026-10-20" });
    assert.ok(versions._note, "the existing note is kept");
    const manifest = JSON.parse(readFileSync(join(site, "nexa-dl", "manifest.json"), "utf8"));
    assert.equal(manifest.previous.version, LATEST);
    assert.equal(manifest.size, 61234567);
    assert.match(readFileSync(join(site, "nexa-dl", "install.sh"), "utf8"), new RegExp(`^DEFAULT_VERSION="${re(NEXT)}"`, "m"));
    assert.match(readFileSync(join(site, "nexa-dl", "QUICKSTART.md"), "utf8"), /prebuilt for macOS \(arm64, x64\)/);
  });

  it("refuses to rewrite a published CLI version or go backwards", () => {
    assert.throws(() => renderCli(site, { version: NEXT, sha256: SHA, size: 1, notesHtml: "<p>x</p>" }), /never rewritten/);
    assert.throws(() => renderCli(site, { version: "3.7.0", sha256: SHA, size: 1, notesHtml: "<p>x</p>" }), /not newer/);
  });

  it("renders an agent release from a dist dir", () => {
    const dist = mkdtempSync(join(tmpdir(), "nexa-dist-"));
    writeFileSync(join(dist, "nexa-agent-linux-x64.tar.gz"), "x".repeat(2048));
    writeFileSync(join(dist, "nexa-agent-windows-x64.zip"), "y".repeat(4096));
    writeFileSync(join(dist, "SHA256SUMS"), `${SHA}  nexa-agent-linux-x64.tar.gz\n${"c".repeat(64)}  nexa-agent-windows-x64.zip\n`);
    renderAgent(site, { version: NEXT, dist, date: "2026-10-20", notesHtml: "<p>First standalone build.</p>", node: "22.22.0" });
    rmSync(dist, { recursive: true, force: true });
    assert.deepEqual(checkSite(site), []);
    const html = readFileSync(join(site, "nexa-agent-dl", "index.html"), "utf8");
    assert.equal(readRegion(html, "version"), NEXT);
    const rows = readRegion(html, "assets");
    assert.ok(rows.includes(`releases/download/v${NEXT}/nexa-agent-linux-x64.tar.gz`));
    assert.ok(rows.includes(`releases/download/v${NEXT}/nexa-agent-windows-x64.zip`));
    assert.ok(!rows.includes("darwin"), "no row for an archive the release does not ship");
    assert.match(readRegion(html, "releases"), new RegExp(`${re(NEXT)}</a><span class="tag-new">latest</span><span class="d">2026-10-20</span><span class="d">Node 22\\.22\\.0</span>`));
    const data = JSON.parse(readFileSync(join(site, "nexa-agent-dl", "releases.json"), "utf8"));
    assert.equal(data.latest, NEXT);
    assert.equal(data.releases[0].assets.find((a) => a.name === "nexa-agent-linux-x64.tar.gz").size, 2048);
    assert.throws(() => renderAgent(site, { version: NEXT, dist, notesHtml: "" }), /SHA256SUMS|never rewritten/);
  });
});

describe("drift (site/ against the live site or the deployed folder)", () => {
  let tmp;
  let site;
  const cli = (latest, ...versions) => ({ latest, versions: versions.map(([version, sha256]) => ({ version, sha256 })) });
  const agent = (latest, ...releases) => ({ latest, releases: releases.map(([version, sha256]) => ({ version, assets: [{ name: "nexa-agent-linux-x64.tar.gz", sha256 }] })) });
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexa-drift-"));
    site = join(tmp, "site");
    mkdirSync(join(site, "nexa-dl"), { recursive: true });
    mkdirSync(join(site, "nexa-agent-dl"), { recursive: true });
    writeFileSync(join(site, "nexa-dl", "versions.json"), JSON.stringify(cli("3.8.0", ["3.8.0", SHA], ["3.7.1", OTHER])));
    writeFileSync(join(site, "nexa-agent-dl", "releases.json"), JSON.stringify(agent("3.8.0", ["3.8.0", SHA])));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("passes when site/ carries everything, including when it is ahead", () => {
    assert.deepEqual(driftFrom(site, { cli: cli("3.8.0", ["3.8.0", SHA], ["3.7.1", OTHER]), agent: agent("3.8.0", ["3.8.0", SHA]) }, "live"), []);
    assert.deepEqual(driftFrom(site, { cli: cli("3.7.1", ["3.7.1", OTHER]), agent: null }, "live"), []);
  });

  it("refuses a site/ that is behind: a newer live version (the 3.8.0-by-hand case)", () => {
    assert.deepEqual(driftFrom(site, { cli: cli("3.8.1", ["3.8.1", SHA], ["3.8.0", SHA], ["3.7.1", OTHER]), agent: null }, "live"), [
      "nexa-dl: live lists 3.8.1, site/ does not",
      "nexa-dl: latest is 3.8.1 in live, 3.8.0 in site/",
    ]);
  });

  it("refuses a site/ that would drop an older version or change its bytes", () => {
    assert.deepEqual(driftFrom(site, { cli: cli("3.8.0", ["3.8.0", SHA], ["3.7.5", SHA], ["3.7.1", OTHER]), agent: null }, "live"), ["nexa-dl: live lists 3.7.5, site/ does not"]);
    assert.deepEqual(driftFrom(site, { cli: cli("3.8.0", ["3.8.0", OTHER], ["3.7.1", OTHER]), agent: agent("3.8.0", ["3.8.0", OTHER]) }, "root"), [
      "nexa-dl: sha256 of 3.8.0 in root differs from site/",
      "nexa-agent-dl: sha256 of 3.8.0 in root differs from site/",
    ]);
  });

  it("treats a site/ without agent releases as empty", () => {
    rmSync(join(site, "nexa-agent-dl", "releases.json"));
    try {
      assert.deepEqual(driftFrom(site, { cli: null, agent: agent("3.8.0", ["3.8.0", SHA]) }, "live"), [
        "nexa-agent-dl: live lists 3.8.0, site/ does not",
        "nexa-agent-dl: latest is 3.8.0 in live, (none) in site/",
      ]);
    } finally {
      writeFileSync(join(site, "nexa-agent-dl", "releases.json"), JSON.stringify(agent("3.8.0", ["3.8.0", SHA])));
    }
  });

  it("reads the live files, 404 meaning no page yet and anything else an error", () => {
    const pages = { "https://x/nexa-dl/versions.json": JSON.stringify(cli("3.8.0", ["3.8.0", SHA])) };
    const get = (url) => (url in pages ? { status: 200, body: Buffer.from(pages[url]) } : { status: 404, body: Buffer.alloc(0) });
    assert.deepEqual(liveSite(get, "https://x"), { cli: cli("3.8.0", ["3.8.0", SHA]), agent: null });
    assert.throws(() => liveSite(() => ({ status: 0, body: Buffer.alloc(0) }), "https://x"), /HTTP 0; cannot compare/);
  });
});
