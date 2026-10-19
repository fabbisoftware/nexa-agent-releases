#!/usr/bin/env node
// Write a new version into the deployable site under site/. The files stay plain
// HTML/JSON/sh that deploy as they are; this script only rewrites the version
// fields and the regions between <!--nexa:name--> markers.
//
//   node scripts/render-site.mjs cli   --bundle <bundle.json> --notes-file <notes.md> [--date YYYY-MM-DD]
//   node scripts/render-site.mjs agent --version <v> --dist <dir with archives + SHA256SUMS> --notes-file <notes.md> [--node <v>] [--date …]
//   node scripts/render-site.mjs check
//
// A version already listed is never rewritten: publish a new version instead.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENT_ASSETS,
  RELEASES_REPO,
  SITE_BASE,
  TGZ_BASE,
  compareVersions,
  escapeHtml,
  formatSize,
  isVersion,
  markdownToHtml,
  parseArgs,
  parseSums,
  readJson,
  readRegion,
  replaceRegion,
  today,
  writeJson,
} from "./lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NATIVES_MULTI_HTML = `
      <li><b>macOS or Linux</b>, x64 or arm64. <code class="k">better-sqlite3</code> for the knowledge base (<code class="k">nexa kb</code> / <code class="k">nexa scan</code>) ships prebuilt for each of them, for Node 22 and Node 24, so nothing compiles at install time. Windows x64 gets its prebuilt addon too; the TUI is not supported on Windows yet.</li>
      <li><b>Another Node version</b> and a native-module error from <code class="k">nexa kb</code>? Fetch the addon for your Node once:
        <div class="cmd">
          <div class="cmd-head"><span class="cmd-tag">only if kb reports a native error</span><button class="copy" type="button">Copy</button></div>
          <pre><code><span class="p">$</span>cd "$(npm root -g)/@fabbi-product-nexa/nexa-cli/node_modules/better-sqlite3" &amp;&amp; npx --yes prebuild-install@7.1.3</code></pre>
        </div>
      </li>
`;

const NATIVES_MULTI_MD = `
- **Knowledge Base engine** (\`better-sqlite3\`) ships prebuilt for macOS (arm64, x64), Linux
  (x64, arm64, glibc) and Windows x64, for Node 22 and Node 24. Nothing compiles at install time.
  On another Node version \`nexa kb ...\` fails with a load error until you fetch the addon once:

  \`\`\`bash
  cd "$(npm root -g)/@fabbi-product-nexa/nexa-cli/node_modules/better-sqlite3"
  npx --yes prebuild-install@7.1.3
  \`\`\`
- **Windows:** \`npm i -g <tgz>\` needs no build tools (no install script runs in the tarball).
  The TUI is not supported on Windows yet.
`;

function setDefaultVersion(file, version) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^DEFAULT_VERSION="[^"]*"/m, `DEFAULT_VERSION="${version}"`);
  if (next === text && !text.includes(`DEFAULT_VERSION="${version}"`)) throw new Error(`${file}: no DEFAULT_VERSION= line`);
  writeFileSync(file, next);
}

/** Render a new NEXA CLI version into site/nexa-dl. Returns the files written. */
export function renderCli(site, { version, sha256, size, date = today(), notesHtml, multiPlatform = false }) {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 hex characters");
  if (!Number.isInteger(size) || size <= 0) throw new Error("size must be a positive integer");
  const dir = join(site, "nexa-dl");
  const url = `${TGZ_BASE}/nexa-${version}.tgz`;

  const versionsFile = join(dir, "versions.json");
  const versions = readJson(versionsFile);
  if (versions.versions.some((v) => v.version === version)) throw new Error(`${version} is already in nexa-dl/versions.json; a published version is never rewritten`);
  const previous = versions.versions.find((v) => v.version === versions.latest);
  if (previous && compareVersions(version, previous.version) <= 0) throw new Error(`${version} is not newer than the latest ${previous.version}`);
  versions.latest = version;
  versions.url = url;
  versions.versions.unshift({ version, url, sha256, date });
  writeJson(versionsFile, versions);

  const manifestFile = join(dir, "manifest.json");
  const old = readJson(manifestFile);
  writeJson(manifestFile, {
    product: "nexa",
    version,
    rc: old.rc ?? 1,
    tgz: `nexa-${version}.tgz`,
    tgz_url: url,
    sha256,
    size,
    date,
    node: old.node ?? ">=22.19",
    install: `npm i -g ${url}`,
    previous: previous ? { version: previous.version, sha256: previous.sha256, url: previous.url } : undefined,
  });

  setDefaultVersion(join(dir, "install.sh"), version);
  setDefaultVersion(join(dir, "verify.sh"), version);

  const quickFile = join(dir, "QUICKSTART.md");
  let quick = readFileSync(quickFile, "utf8").replace(/^(nexa --version\s+# )\S+/m, `$1${version}`);
  if (multiPlatform) quick = replaceRegion(quick, "natives", NATIVES_MULTI_MD);
  writeFileSync(quickFile, quick);

  const indexFile = join(dir, "index.html");
  let html = readFileSync(indexFile, "utf8");
  html = replaceRegion(html, "version", `v${version}`);
  html = replaceRegion(html, "tgz-url", url);
  if (multiPlatform) html = replaceRegion(html, "natives", NATIVES_MULTI_HTML);
  const log = readRegion(html, "changelog").replace(/<span class="tag-new">latest<\/span>/g, "");
  const item = `
      <div class="item">
        <span class="v">${escapeHtml(version)}</span><span class="tag-new">latest</span>
        ${notesHtml.trim()}
      </div>`;
  html = replaceRegion(html, "changelog", `${item}${log.startsWith("\n") ? log : `\n${log}`}`);
  writeFileSync(indexFile, html);
  return [versionsFile, manifestFile, join(dir, "install.sh"), join(dir, "verify.sh"), quickFile, indexFile];
}

function assetRows(release) {
  const base = `https://github.com/${RELEASES_REPO}/releases/download/v${release.version}`;
  const rows = AGENT_ASSETS.filter((a) => release.assets.some((x) => x.name === a.name)).map((a) => {
    const asset = release.assets.find((x) => x.name === a.name);
    return `        <tr data-os="${a.os}"><td class="plat"><b>${a.label}</b> <span>${escapeHtml(a.sub)}</span></td><td class="file"><a href="${base}/${a.name}">${a.name}</a></td><td class="size">${formatSize(asset.size)}</td></tr>`;
  });
  rows.push(`        <tr><td class="plat"><b>Checksums</b> <span>all files</span></td><td class="file"><a href="${base}/SHA256SUMS">SHA256SUMS</a></td><td class="size">–</td></tr>`);
  return `\n${rows.join("\n")}\n        `;
}

function releaseLog(releases) {
  const items = releases.slice(0, 8).map((r, i) => {
    const tag = i === 0 ? '<span class="tag-new">latest</span>' : "";
    const node = r.node ? `<span class="d">Node ${escapeHtml(r.node)}</span>` : "";
    return `
      <div class="item">
        <a class="v" href="https://github.com/${RELEASES_REPO}/releases/tag/v${escapeHtml(r.version)}">${escapeHtml(r.version)}</a>${tag}<span class="d">${escapeHtml(r.date)}</span>${node}
        ${r.notes_html ?? ""}
      </div>`;
  });
  items.push(`
      <div class="item">
        <a class="v" href="https://github.com/${RELEASES_REPO}/releases">All releases on GitHub →</a>
      </div>`);
  return `${items.join("")}\n      `;
}

/** Render a new NEXA Agent release into site/nexa-agent-dl from the built dist dir. */
export function renderAgent(site, { version, dist, date = today(), notesHtml, node }) {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  const dir = join(site, "nexa-agent-dl");
  const sums = parseSums(readFileSync(join(dist, "SHA256SUMS"), "utf8"));
  const assets = AGENT_ASSETS.filter((a) => sums.has(a.name)).map((a) => ({ name: a.name, target: a.target, size: statSync(join(dist, a.name)).size, sha256: sums.get(a.name) }));
  if (assets.length === 0) throw new Error(`${dist}/SHA256SUMS lists no agent archive`);

  const releasesFile = join(dir, "releases.json");
  const data = existsSync(releasesFile) ? readJson(releasesFile) : { latest: null, releases: [] };
  if (data.releases.some((r) => r.version === version)) throw new Error(`${version} is already in nexa-agent-dl/releases.json; a published version is never rewritten`);
  if (data.latest && compareVersions(version, data.latest) <= 0) throw new Error(`${version} is not newer than the latest ${data.latest}`);
  const release = { version, date, node, assets, notes_html: notesHtml.trim() };
  data.latest = version;
  data.releases.unshift(release);
  writeJson(releasesFile, data);

  const indexFile = join(dir, "index.html");
  let html = readFileSync(indexFile, "utf8");
  html = replaceRegion(html, "version", escapeHtml(version));
  html = replaceRegion(html, "assets", assetRows(release));
  html = replaceRegion(html, "releases", releaseLog(data.releases));
  writeFileSync(indexFile, html);
  return [releasesFile, indexFile];
}

/** Problems that would make the deployed pages contradict each other; [] when consistent. */
export function checkSite(site) {
  const problems = [];
  const cli = join(site, "nexa-dl");
  const versions = readJson(join(cli, "versions.json"));
  const manifest = readJson(join(cli, "manifest.json"));
  const latest = versions.latest;
  const entry = versions.versions.find((v) => v.version === latest);
  if (!entry) problems.push(`nexa-dl/versions.json: latest ${latest} is not in versions[]`);
  if (versions.versions[0]?.version !== latest) problems.push("nexa-dl/versions.json: latest is not the first entry");
  if (manifest.version !== latest) problems.push(`nexa-dl/manifest.json is ${manifest.version}, versions.json latest is ${latest}`);
  if (entry && manifest.sha256 !== entry.sha256) problems.push("nexa-dl/manifest.json sha256 differs from versions.json");
  for (const f of ["install.sh", "verify.sh"]) {
    if (!readFileSync(join(cli, f), "utf8").includes(`DEFAULT_VERSION="${latest}"`)) problems.push(`nexa-dl/${f}: DEFAULT_VERSION is not ${latest}`);
  }
  if (!new RegExp(`^nexa --version\\s+# ${latest.replace(/\./g, "\\.")}$`, "m").test(readFileSync(join(cli, "QUICKSTART.md"), "utf8"))) problems.push(`nexa-dl/QUICKSTART.md: nexa --version line is not ${latest}`);
  const html = readFileSync(join(cli, "index.html"), "utf8");
  try {
    if (readRegion(html, "version") !== `v${latest}`) problems.push(`nexa-dl/index.html: version pill is not v${latest}`);
    if (readRegion(html, "tgz-url") !== `${TGZ_BASE}/nexa-${latest}.tgz`) problems.push("nexa-dl/index.html: npm install URL is not the latest tarball");
    const first = /<span class="v">([^<]+)<\/span>/.exec(readRegion(html, "changelog"));
    if (!first || first[1] !== latest) problems.push(`nexa-dl/index.html: first changelog item is not ${latest}`);
    if ((readRegion(html, "changelog").match(/tag-new">latest/g) ?? []).length !== 1) problems.push("nexa-dl/index.html: changelog must mark exactly one item latest");
  } catch (err) {
    problems.push(`nexa-dl/index.html: ${err.message}`);
  }

  const agent = join(site, "nexa-agent-dl");
  const agentHtml = readFileSync(join(agent, "index.html"), "utf8");
  const releasesFile = join(agent, "releases.json");
  const data = existsSync(releasesFile) ? readJson(releasesFile) : { latest: null, releases: [] };
  try {
    const pill = readRegion(agentHtml, "version");
    if (data.latest ? pill !== data.latest : pill !== "latest") problems.push(`nexa-agent-dl/index.html: version pill is ${pill}, releases.json latest is ${data.latest ?? "(none)"}`);
    readRegion(agentHtml, "assets");
    readRegion(agentHtml, "releases");
  } catch (err) {
    problems.push(`nexa-agent-dl/index.html: ${err.message}`);
  }
  for (const f of ["install.sh", "install.ps1"]) {
    if (!existsSync(join(agent, f))) problems.push(`nexa-agent-dl/${f} missing`);
  }
  return problems;
}

function main(argv) {
  const [mode, ...rest] = argv;
  const args = parseArgs(rest, { values: ["bundle", "notes-file", "date", "version", "dist", "node", "site"] });
  const site = resolve(args.site ?? join(REPO_ROOT, "site"));
  if (mode === "check") {
    const problems = checkSite(site);
    for (const p of problems) process.stderr.write(`✗ ${p}\n`);
    if (problems.length) return 1;
    process.stdout.write("✓ site is consistent\n");
    return 0;
  }
  if (!args["notes-file"]) throw new Error("--notes-file <notes.md> is required");
  const notesHtml = markdownToHtml(readFileSync(args["notes-file"], "utf8"));
  if (mode === "cli") {
    if (!args.bundle) throw new Error("--bundle <bundle.json> is required");
    const b = readJson(args.bundle);
    const files = renderCli(site, { version: b.version, sha256: b.sha256, size: b.size, date: args.date, notesHtml, multiPlatform: Array.isArray(b.targets) && b.targets.length > 1 });
    process.stdout.write(`✓ nexa-dl ${b.version}: ${files.length} files\n`);
  } else if (mode === "agent") {
    if (!args.version || !args.dist) throw new Error("--version and --dist are required");
    const files = renderAgent(site, { version: args.version.replace(/^v/, ""), dist: resolve(args.dist), date: args.date, notesHtml, node: args.node });
    process.stdout.write(`✓ nexa-agent-dl ${args.version}: ${files.length} files\n`);
  } else {
    throw new Error("usage: render-site.mjs cli|agent|check …");
  }
  const problems = checkSite(site);
  for (const p of problems) process.stderr.write(`✗ ${p}\n`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}

export { SITE_BASE };
