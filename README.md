# NEXA Agent releases

Builds of **NEXA Agent** (NEXA with its own Node runtime) and the download pages of
[downloads.agilekit.cc](https://downloads.agilekit.cc/nexa-agent-dl/). No NEXA source code lives here.

## Install

macOS / Linux:

```bash
curl -fsSL https://downloads.agilekit.cc/nexa-agent-dl/install.sh | bash
```

Windows (PowerShell, preview):

```powershell
irm https://downloads.agilekit.cc/nexa-agent-dl/install.ps1 | iex
```

Full instructions, direct downloads and checksum verification: https://downloads.agilekit.cc/nexa-agent-dl/.
The npm-based NEXA CLI (Node 22.19+) is at https://downloads.agilekit.cc/nexa-dl/.

## What is in this repository

| Path | What |
|---|---|
| [Releases](../../releases) | One release `v<version>` per NEXA version: `nexa-agent-<os>-<arch>.tar.gz` (macOS, Linux), `nexa-agent-windows-x64.zip`, `SHA256SUMS` |
| `site/nexa-dl/`, `site/nexa-agent-dl/` | The two download pages exactly as deployed, installers included |
| `scripts/` | Zero-dependency Node scripts: `render-site.mjs` (write a version into the pages), `assemble-agent.mjs` (bundle + Node runtime → archives), `smoke-agent.mjs` (install with the real installer and run NEXA), `deploy.mjs` (owner's machine: R2, release, Pages) |
| `.github/workflows/` | `ci` (tests on Ubuntu, macOS, Windows) and `agent-release` (staging branch → archives → smoke test on five real runners → draft release) |
| `staging/v<version>` branches | Short-lived: a staged NEXA bundle waiting for `/deploy`; deleted once deployed |

Releasing is driven from the NEXA repository (`/publish`, `/publish-cli`, `/publish-agent` in
claude.ai/code or locally, then `/deploy` on the owner's machine). Tests: `node --test "test/*.test.mjs"`.

## License

NEXA is proprietary software of Fabbi Holdings ([LICENSE](LICENSE)). Downloading a build does not grant a
license to use it.
