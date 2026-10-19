#!/usr/bin/env node
// Local deploy of one staged NEXA version: everything slow already happened in
// claude.ai/code (bundle build, page content) and in GitHub Actions (agent archives,
// smoke tests, draft release). This moves the finished bytes and checks the result.
//
//   node scripts/deploy.mjs --version <v> [--dry-run] [--smoke] [--assemble-local]
//        [--skip-cli] [--skip-agent] [--skip-pages] [--allow-remove] [--config <file>]
//
// Steps: staged tarball sha256 → R2 (never overwrites) → publish the draft release
// v<v> → copy site/nexa-dl and site/nexa-agent-dl into the local site root → refuse
// when a path that is live now would disappear → wrangler pages deploy → read the
// live site back → delete the staging branch. Needs `wrangler` (logged in), `gh`
// (logged in, write access to the releases repo), curl and git. Config (written by
// the /deploy command on first use): ~/.config/nexa-dist/deploy.json
//   { "siteRoot": "<folder deployed to Pages>", "pagesProject": "…", "pagesBranch": "main",
//     "r2Bucket": "…", "wrangler": "wrangler" }
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleAgent } from "./assemble-agent.mjs";
import { AGENT_ASSETS, RELEASES_REPO, SITE_BASE, TGZ_BASE, parseArgs, parseSums, readJson, sha256, sha256File, writeJson } from "./lib.mjs";
import { checkSite } from "./render-site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
export const MANAGED = ["nexa-dl", "nexa-agent-dl"];
/** Pages that exist on downloads.agilekit.cc today; their links seed the live-path guard. */
export const LIVE_ENTRIES = ["/nexa-dl/", "/dwb-dl/", "/nexa-agent-dl/"];
const CONFIG = join(homedir(), ".config", "nexa-dist", "deploy.json");

const say = (msg) => process.stdout.write(`${msg}\n`);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${(r.stderr ?? "").toString().trim()}`);
  return r;
}

/** GET via curl (honours HTTPS_PROXY, unlike Node's fetch on 22): { status, body: Buffer }. */
export function httpGet(url) {
  const tmp = mkdtempSync(join(tmpdir(), "nexa-get-"));
  try {
    const r = sh("curl", ["-sS", "-L", "-o", join(tmp, "body"), "-w", "%{http_code}", url], { allowFail: true });
    const status = Number(r.stdout) || 0;
    return { status, body: existsSync(join(tmp, "body")) ? readFileSync(join(tmp, "body")) : Buffer.alloc(0) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Same-site paths a page links to: href/src attributes and absolute site URLs in the text. */
export function linkedPaths(pageUrl, text, siteBase = SITE_BASE) {
  const out = new Set();
  const candidates = [...text.matchAll(/(?:href|src)="([^"#?]+)[^"]*"/g)].map((m) => m[1]);
  candidates.push(...[...text.matchAll(new RegExp(`${siteBase.replace(/[.]/g, "\\.")}(/[A-Za-z0-9._~/-]*)`, "g"))].map((m) => `${siteBase}${m[1]}`));
  for (const c of candidates) {
    let url;
    try {
      url = new URL(c, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(siteBase).origin) continue;
    out.add(url.pathname);
  }
  return out;
}

/** URL path → the file Pages serves for it, relative to the site root. */
export const pathToFile = (p) => (p.endsWith("/") ? `${p}index.html` : p).replace(/^\//, "");

/** Every path reachable from the live entry pages (one level of links, plus scripts they name). */
export function livePaths(get = httpGet, entries = LIVE_ENTRIES, siteBase = SITE_BASE) {
  const found = new Set();
  const queue = entries.map((e) => ({ path: e, depth: 0 }));
  while (queue.length) {
    const { path, depth } = queue.shift();
    if (found.has(path)) continue;
    const res = get(`${siteBase}${path}`);
    if (res.status !== 200) continue;
    found.add(path);
    if (depth >= 2 || !/(\/|\.html|\.sh|\.md|\.json)$/.test(path)) continue;
    for (const next of linkedPaths(`${siteBase}${path}`, res.body.toString("utf8"), siteBase)) {
      if (next !== "/" && !found.has(next)) queue.push({ path: next, depth: depth + 1 });
    }
  }
  return [...found].sort();
}

export const missingLocally = (paths, siteRoot) => paths.map(pathToFile).filter((f) => !existsSync(join(siteRoot, f)));

function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield relative(base, full).split("\\").join("/");
  }
}

/** Files of the site root as { path: sha256 }. */
export const snapshot = (siteRoot) => Object.fromEntries([...walk(siteRoot)].filter((f) => !f.startsWith(".")).sort().map((f) => [f, sha256File(join(siteRoot, f))]));

/** What copying site/<managed> into the site root adds or changes (never removes). */
export function syncPlan(site, siteRoot, managed = MANAGED) {
  const plan = [];
  for (const dir of managed) {
    for (const f of walk(join(site, dir))) {
      const from = join(site, dir, f);
      const to = join(siteRoot, dir, f);
      if (!existsSync(to)) plan.push({ file: `${dir}/${f}`, change: "add", from, to });
      else if (sha256File(from) !== sha256File(to)) plan.push({ file: `${dir}/${f}`, change: "update", from, to });
    }
  }
  return plan;
}

function loadConfig(file) {
  if (!existsSync(file)) throw new Error(`no deploy config at ${file}; run /deploy once so it can set siteRoot, pagesProject and r2Bucket`);
  const cfg = { pagesBranch: "main", wrangler: "wrangler", ...readJson(file) };
  for (const k of ["siteRoot", "pagesProject", "r2Bucket"]) if (!cfg[k]) throw new Error(`${file}: ${k} is missing`);
  if (!existsSync(cfg.siteRoot) || !statSync(cfg.siteRoot).isDirectory()) throw new Error(`siteRoot ${cfg.siteRoot} is not a folder`);
  return cfg;
}

export async function deploy(opts) {
  const v = opts.version;
  const dry = Boolean(opts.dryRun);
  const step = (msg) => say(`${dry ? "[dry-run] " : ""}• ${msg}`);
  const cfg = loadConfig(opts.config ?? CONFIG);
  const wrangler = (args, o) => {
    const [cmd, ...pre] = cfg.wrangler.split(/\s+/);
    return sh(cmd, [...pre, ...args], o);
  };

  // --- preflight -----------------------------------------------------------------
  step("preflight: git, tools, staging branch, site consistency");
  if (sh("git", ["-C", ROOT, "status", "--porcelain"]).stdout.trim()) throw new Error(`${ROOT} has uncommitted changes`);
  sh("git", ["-C", ROOT, "fetch", "-q", "origin", "main"]);
  const head = sh("git", ["-C", ROOT, "rev-parse", "HEAD"]).stdout.trim();
  const main = sh("git", ["-C", ROOT, "rev-parse", "origin/main"]).stdout.trim();
  if (head !== main) throw new Error(`HEAD ${head.slice(0, 7)} is not origin/main ${main.slice(0, 7)}: git checkout main && git pull --ff-only`);
  const stagingRef = `origin/staging/v${v}`;
  const hasStaging = sh("git", ["-C", ROOT, "fetch", "-q", "origin", `staging/v${v}:refs/remotes/origin/staging/v${v}`], { allowFail: true }).status === 0;
  const staging = hasStaging ? JSON.parse(sh("git", ["-C", ROOT, "show", `${stagingRef}:staging/staging.json`]).stdout) : null;
  const problems = checkSite(SITE);
  if (problems.length) throw new Error(`site/ is inconsistent:\n  ${problems.join("\n  ")}`);
  wrangler(["--version"]);
  sh("gh", ["auth", "status"]);

  const versions = readJson(join(SITE, "nexa-dl", "versions.json"));
  const cliEntry = versions.versions.find((x) => x.version === v);
  const agentData = existsSync(join(SITE, "nexa-agent-dl", "releases.json")) ? readJson(join(SITE, "nexa-agent-dl", "releases.json")) : { releases: [] };
  const agentEntry = agentData.releases.find((x) => x.version === v);
  const doCli = !opts.skipCli && Boolean(staging?.cli);
  const doAgent = !opts.skipAgent && Boolean(staging?.agent || agentEntry);
  if (doCli && !cliEntry) throw new Error(`staging says cli, but site/nexa-dl/versions.json has no ${v}; run /publish-cli ${v} again`);
  say(`  version ${v}: cli=${doCli ? "yes" : "no"} agent=${doAgent ? "yes" : "no"} pages=${opts.skipPages ? "no" : "yes"} staging=${hasStaging ? stagingRef : "(none)"}`);

  const work = mkdtempSync(join(tmpdir(), "nexa-deploy-"));
  const report = [];
  try {
    // --- CLI tarball → R2 ------------------------------------------------------------
    if (doCli) {
      const name = `nexa-${v}.tgz`;
      const tgz = join(work, name);
      writeFileSync(tgz, sh("git", ["-C", ROOT, "cat-file", "blob", `${stagingRef}:staging/${name}`], { encoding: "buffer" }).stdout);
      const got = sha256File(tgz);
      const manifest = readJson(join(SITE, "nexa-dl", "manifest.json"));
      for (const [where, want] of [["staging.json", staging.bundle?.sha256], ["versions.json", cliEntry.sha256], ["manifest.json", manifest.version === v ? manifest.sha256 : cliEntry.sha256]]) {
        if (want !== got) throw new Error(`${name}: sha256 ${got} differs from ${where} (${want})`);
      }
      step(`R2: ${cfg.r2Bucket}/${name} (${(statSync(tgz).size / 1048576).toFixed(1)} MB, sha256 ${got.slice(0, 12)}…)`);
      const live = httpGet(`${TGZ_BASE}/${name}`);
      if (live.status === 200) {
        if (sha256(live.body) !== got) throw new Error(`${TGZ_BASE}/${name} already exists with different bytes; a published version is never overwritten`);
        say("  already on R2 with the same sha256, skipped");
      } else if (!dry) {
        wrangler(["r2", "object", "put", `${cfg.r2Bucket}/${name}`, "--file", tgz, "--content-type", "application/gzip", "--remote"]);
        const check = httpGet(`${TGZ_BASE}/${name}`);
        if (check.status !== 200 || sha256(check.body) !== got) throw new Error(`${TGZ_BASE}/${name} does not serve the uploaded bytes (HTTP ${check.status})`);
        say(`  ✓ ${TGZ_BASE}/${name} serves sha256 ${got.slice(0, 12)}…`);
      }
      report.push(`R2 ${TGZ_BASE}/${name}`);
    }

    // --- agent release: publish the draft --------------------------------------------
    if (doAgent) {
      if (!agentEntry) throw new Error(`site/nexa-agent-dl/releases.json has no ${v}; the agent-release workflow has not finished (or failed)`);
      const view = sh("gh", ["release", "view", `v${v}`, "--repo", RELEASES_REPO, "--json", "isDraft,assets,url"], { allowFail: true });
      if (view.status !== 0) {
        if (!opts.assembleLocal) throw new Error(`no release v${v} in ${RELEASES_REPO}; check the agent-release run, or pass --assemble-local`);
        step(`assemble the agent archives locally and create release v${v}`);
        if (!dry) {
          const bundle = join(work, `nexa-${v}.tgz`);
          if (!existsSync(bundle)) writeFileSync(bundle, sh("git", ["-C", ROOT, "cat-file", "blob", `${stagingRef}:staging/nexa-${v}.tgz`], { encoding: "buffer" }).stdout);
          const dist = join(work, "dist");
          assembleAgent({ bundle, out: dist, version: v, node: agentEntry.node });
          const files = [...AGENT_ASSETS.map((a) => join(dist, a.name)).filter(existsSync), join(dist, "SHA256SUMS")];
          sh("gh", ["release", "create", `v${v}`, "--repo", RELEASES_REPO, "--title", `NEXA Agent ${v}`, "--notes", `NEXA Agent ${v}. Install: ${SITE_BASE}/nexa-agent-dl/`, "--latest", ...files], { stdio: "inherit" });
        }
      } else {
        const rel = JSON.parse(view.stdout);
        const names = new Set(rel.assets.map((a) => a.name));
        const missing = [...agentEntry.assets.map((a) => a.name), "SHA256SUMS"].filter((n) => !names.has(n));
        if (missing.length) throw new Error(`release v${v} lacks ${missing.join(", ")}`);
        const sums = parseSums(sh("gh", ["release", "download", `v${v}`, "--repo", RELEASES_REPO, "-p", "SHA256SUMS", "-O", "-"]).stdout);
        for (const a of agentEntry.assets) if (sums.get(a.name) !== a.sha256) throw new Error(`release v${v}: SHA256SUMS for ${a.name} differs from releases.json`);
        step(`release v${v}: ${rel.isDraft ? "publish the draft" : "already published"} (${agentEntry.assets.length} archives, sums match releases.json)`);
        if (rel.isDraft && !dry) sh("gh", ["release", "edit", `v${v}`, "--repo", RELEASES_REPO, "--draft=false", "--latest"]);
      }
      if (!dry) {
        const r = sh("curl", ["-sSI", "-o", "/dev/null", "-w", "%{redirect_url}", `https://github.com/${RELEASES_REPO}/releases/latest/download/SHA256SUMS`], { allowFail: true });
        if (!r.stdout.includes(`/download/v${v}/`)) throw new Error(`releases/latest does not point at v${v} yet (${r.stdout || "no redirect"})`);
        say(`  ✓ releases/latest → v${v}`);
      }
      report.push(`release https://github.com/${RELEASES_REPO}/releases/tag/v${v}`);
    }

    // --- Pages ---------------------------------------------------------------------
    if (!opts.skipPages) {
      const plan = syncPlan(SITE, cfg.siteRoot);
      step(`Pages: copy ${plan.length} file(s) into ${cfg.siteRoot}`);
      for (const p of plan) say(`  ${p.change.padEnd(6)} ${p.file}`);
      const live = livePaths();
      const lastFile = join(dirname(opts.config ?? CONFIG), `last-deploy-${cfg.pagesProject}.json`);
      const willHave = new Set([...Object.keys(snapshot(cfg.siteRoot)), ...plan.map((p) => p.file)]);
      const missing = live.map(pathToFile).filter((f) => !willHave.has(f));
      if (missing.length) throw new Error(`deploying ${cfg.siteRoot} would take these live paths offline:\n  ${missing.join("\n  ")}\nPoint siteRoot at the folder that holds the whole site.`);
      say(`  live-path guard: ${live.length} live paths, all present`);
      if (existsSync(lastFile)) {
        const removed = Object.keys(readJson(lastFile)).filter((f) => !willHave.has(f));
        if (removed.length && !opts.allowRemove) throw new Error(`files deployed last time are gone from ${cfg.siteRoot}:\n  ${removed.join("\n  ")}\nRestore them, or pass --allow-remove.`);
      }
      if (!dry) {
        for (const p of plan) {
          mkdirSync(dirname(p.to), { recursive: true });
          copyFileSync(p.from, p.to);
        }
        wrangler(["pages", "deploy", cfg.siteRoot, "--project-name", cfg.pagesProject, "--branch", cfg.pagesBranch, "--commit-dirty=true", "--commit-message", `nexa ${v}`], { stdio: "inherit" });
        mkdirSync(dirname(lastFile), { recursive: true });
        writeJson(lastFile, snapshot(cfg.siteRoot));
        const stale = [];
        for (const dir of MANAGED) {
          for (const f of walk(join(SITE, dir))) {
            const res = httpGet(`${SITE_BASE}/${dir}/${f}`);
            if (res.status !== 200 || sha256(res.body) !== sha256File(join(SITE, dir, f))) stale.push(`${dir}/${f} (HTTP ${res.status})`);
          }
        }
        if (stale.length) throw new Error(`the live site does not serve what was deployed yet:\n  ${stale.join("\n  ")}\nPages can take a minute; run with --skip-cli --skip-agent to check again.`);
        say(`  ✓ ${SITE_BASE}/nexa-dl/ and /nexa-agent-dl/ serve the deployed files`);
      }
      report.push(`Pages ${SITE_BASE}/nexa-dl/ ${SITE_BASE}/nexa-agent-dl/`);
    }

    // --- smoke on this machine -------------------------------------------------------
    if (opts.smoke && !dry) {
      if (doCli) sh("bash", ["-c", `curl -fsSL ${SITE_BASE}/nexa-dl/verify.sh | bash -s -- --version ${v}`], { stdio: "inherit" });
      if (doAgent) sh(process.execPath, [join(ROOT, "scripts", "smoke-agent.mjs"), "--live", "--version", v], { stdio: "inherit" });
    }

    if (hasStaging && !dry) {
      sh("git", ["-C", ROOT, "push", "-q", "origin", "--delete", `staging/v${v}`]);
      say(`  ✓ deleted branch staging/v${v}`);
    }
    say(`${dry ? "Dry run done, nothing changed" : "Deployed"}: ${report.join(" · ")}`);
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["dry-run", "smoke", "assemble-local", "skip-cli", "skip-agent", "skip-pages", "allow-remove"], values: ["version", "config"] });
    if (!args.version) throw new Error("usage: deploy.mjs --version <v> [--dry-run] [--smoke] …");
    await deploy({
      version: args.version.replace(/^v/, ""),
      dryRun: args["dry-run"],
      smoke: args.smoke,
      assembleLocal: args["assemble-local"],
      skipCli: args["skip-cli"],
      skipAgent: args["skip-agent"],
      skipPages: args["skip-pages"],
      allowRemove: args["allow-remove"],
      config: args.config && resolve(args.config),
    });
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}
