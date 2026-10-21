// Shared helpers for the release scripts. Zero dependencies: they run in GitHub
// Actions, in claude.ai/code and on the owner's machine with plain Node 22.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha256File = (file) => sha256(readFileSync(file));
export const today = () => new Date().toISOString().slice(0, 10);

export const SITE_BASE = "https://downloads.agilekit.cc";
export const TGZ_BASE = "https://dl.agilekit.cc";
export const RELEASES_REPO = "fabbisoftware/nexa-agent-releases";

/** Agent release assets, one per platform. `target` is the `<platform>-<arch>` of Node. */
export const AGENT_ASSETS = [
  { name: "nexa-agent-darwin-arm64.tar.gz", target: "darwin-arm64", label: "macOS", sub: "Apple silicon", os: "mac" },
  { name: "nexa-agent-darwin-x64.tar.gz", target: "darwin-x64", label: "macOS", sub: "Intel", os: "mac" },
  { name: "nexa-agent-linux-x64.tar.gz", target: "linux-x64", label: "Linux", sub: "x64, glibc", os: "linux" },
  { name: "nexa-agent-linux-arm64.tar.gz", target: "linux-arm64", label: "Linux", sub: "arm64, glibc", os: "linux" },
  { name: "nexa-agent-windows-x64.zip", target: "win32-x64", label: "Windows", sub: "x64, preview", os: "win" },
];

/** Compare two versions (x.y.z with an optional -pre.release); semver rules, numeric parts numeric. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, "").split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release sorts after its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) - Number(y.pre[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

export const isVersion = (v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v));

export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="k">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** The small Markdown subset release notes use: paragraphs, `- ` lists, `code`, **bold**, [links](https://…). */
export function markdownToHtml(md) {
  const blocks = String(md).replace(/\r/g, "").trim().split(/\n\s*\n/);
  return blocks
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*] /.test(l) || /^\s{2,}\S/.test(l))) {
        const items = [];
        for (const l of lines) {
          if (/^\s*[-*] /.test(l)) items.push(l.replace(/^\s*[-*] /, ""));
          else items[items.length - 1] += ` ${l.trim()}`;
        }
        return `<ul class="reqs">${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
      }
      return `<p>${inline(lines.map((l) => l.trim()).join(" "))}</p>`;
    })
    .join("\n");
}

/** Replace what sits between <!--nexa:name--> and <!--/nexa:name--> (spaces inside the comment allowed). */
export function replaceRegion(text, name, content) {
  const re = new RegExp(`(<!--\\s*nexa:${name}\\s*-->)([\\s\\S]*?)(<!--\\s*/nexa:${name}\\s*-->)`, "g");
  const matches = text.match(re);
  if (!matches || matches.length !== 1) throw new Error(`expected exactly one nexa:${name} region, found ${matches ? matches.length : 0}`);
  return text.replace(re, (_, open, _old, close) => `${open}${content}${close}`);
}

export function readRegion(text, name) {
  const m = new RegExp(`<!--\\s*nexa:${name}\\s*-->([\\s\\S]*?)<!--\\s*/nexa:${name}\\s*-->`).exec(text);
  if (!m) throw new Error(`nexa:${name} region not found`);
  return m[1];
}

export function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Parse a SHA256SUMS file (`<hex>  <name>` or `<hex> *<name>`) into Map name → hex. */
export function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) map.set(m[2].trim(), m[1]);
  }
  return map;
}

/** GET via curl (honours HTTPS_PROXY, unlike Node's fetch on 22): { status, body: Buffer }; status 0 when curl could not connect. */
export function httpGet(url) {
  const tmp = mkdtempSync(join(tmpdir(), "nexa-get-"));
  try {
    const r = spawnSync("curl", ["-sS", "-L", "-o", join(tmp, "body"), "-w", "%{http_code}", url], { encoding: "utf8" });
    if (r.error) throw new Error(`curl: ${r.error.message}`);
    return { status: Number(r.stdout) || 0, body: existsSync(join(tmp, "body")) ? readFileSync(join(tmp, "body")) : Buffer.alloc(0) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** True when the module at `url` is the script node started; node runs a symlinked script from its real path. */
export function isMain(url) {
  try {
    return url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, inlineValue] = a.slice(2).split(/=(.*)/s);
    if (flags.includes(k)) out[k] = true;
    else if (values.includes(k)) out[k] = inlineValue ?? argv[++i];
    else throw new Error(`unknown option --${k}`);
  }
  return out;
}
