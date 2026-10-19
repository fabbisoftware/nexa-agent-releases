import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, markdownToHtml, parseSums, readRegion, replaceRegion } from "../scripts/lib.mjs";
import { checkSite, renderAgent, renderCli } from "../scripts/render-site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "a".repeat(64);

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
    renderCli(site, { version: "3.7.2", sha256: SHA, size: 61234567, date: "2026-10-20", notesHtml: "<p>Notes for 3.7.2.</p>", multiPlatform: true });
    const after = readFileSync(join(site, "nexa-dl", "index.html"), "utf8");
    assert.deepEqual(checkSite(site), []);
    assert.equal(readRegion(after, "version"), "v3.7.2");
    assert.equal(readRegion(after, "tgz-url"), "https://dl.agilekit.cc/nexa-3.7.2.tgz");
    const log = readRegion(after, "changelog");
    assert.match(log, /^\s*<div class="item">\s*<span class="v">3\.7\.2<\/span><span class="tag-new">latest<\/span>\s*<p>Notes for 3\.7\.2\.<\/p>/);
    assert.equal(log.match(/tag-new">latest/g).length, 1);
    assert.ok(log.includes('<span class="v">3.7.1</span>'), "older entries stay");
    // Outside the marker regions the page is byte-for-byte unchanged.
    const strip = (html) => html.replace(/<!--\s*nexa:(\w[\w-]*)\s*-->[\s\S]*?<!--\s*\/nexa:\1\s*-->/g, "");
    assert.equal(strip(after), strip(before));

    const versions = JSON.parse(readFileSync(join(site, "nexa-dl", "versions.json"), "utf8"));
    assert.equal(versions.latest, "3.7.2");
    assert.deepEqual(versions.versions[0], { version: "3.7.2", url: "https://dl.agilekit.cc/nexa-3.7.2.tgz", sha256: SHA, date: "2026-10-20" });
    assert.ok(versions._note, "the existing note is kept");
    const manifest = JSON.parse(readFileSync(join(site, "nexa-dl", "manifest.json"), "utf8"));
    assert.equal(manifest.previous.version, "3.7.1");
    assert.equal(manifest.size, 61234567);
    assert.match(readFileSync(join(site, "nexa-dl", "install.sh"), "utf8"), /^DEFAULT_VERSION="3\.7\.2"/m);
    assert.match(readFileSync(join(site, "nexa-dl", "QUICKSTART.md"), "utf8"), /prebuilt for macOS \(arm64, x64\)/);
  });

  it("refuses to rewrite a published CLI version or go backwards", () => {
    assert.throws(() => renderCli(site, { version: "3.7.2", sha256: SHA, size: 1, notesHtml: "<p>x</p>" }), /never rewritten/);
    assert.throws(() => renderCli(site, { version: "3.7.0", sha256: SHA, size: 1, notesHtml: "<p>x</p>" }), /not newer/);
  });

  it("renders an agent release from a dist dir", () => {
    const dist = mkdtempSync(join(tmpdir(), "nexa-dist-"));
    writeFileSync(join(dist, "nexa-agent-linux-x64.tar.gz"), "x".repeat(2048));
    writeFileSync(join(dist, "nexa-agent-windows-x64.zip"), "y".repeat(4096));
    writeFileSync(join(dist, "SHA256SUMS"), `${SHA}  nexa-agent-linux-x64.tar.gz\n${"c".repeat(64)}  nexa-agent-windows-x64.zip\n`);
    renderAgent(site, { version: "3.7.2", dist, date: "2026-10-20", notesHtml: "<p>First standalone build.</p>", node: "22.22.0" });
    rmSync(dist, { recursive: true, force: true });
    assert.deepEqual(checkSite(site), []);
    const html = readFileSync(join(site, "nexa-agent-dl", "index.html"), "utf8");
    assert.equal(readRegion(html, "version"), "3.7.2");
    const rows = readRegion(html, "assets");
    assert.ok(rows.includes("releases/download/v3.7.2/nexa-agent-linux-x64.tar.gz"));
    assert.ok(rows.includes("releases/download/v3.7.2/nexa-agent-windows-x64.zip"));
    assert.ok(!rows.includes("darwin"), "no row for an archive the release does not ship");
    assert.match(readRegion(html, "releases"), /3\.7\.2<\/a><span class="tag-new">latest<\/span><span class="d">2026-10-20<\/span><span class="d">Node 22\.22\.0<\/span>/);
    const data = JSON.parse(readFileSync(join(site, "nexa-agent-dl", "releases.json"), "utf8"));
    assert.equal(data.latest, "3.7.2");
    assert.equal(data.releases[0].assets.find((a) => a.name === "nexa-agent-linux-x64.tar.gz").size, 2048);
    assert.throws(() => renderAgent(site, { version: "3.7.2", dist, notesHtml: "" }), /SHA256SUMS|never rewritten/);
  });
});
