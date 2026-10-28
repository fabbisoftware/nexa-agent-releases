# NEXA CLI - Greenfield Quickstart (clean curl install)

End-to-end SDLC sequence on a **fresh machine**, starting from nothing. Steps 0-8 are
**verified** on a clean `npm i -g` install (node 22 & node 26). Steps 9-12 are the intended
downstream flow with exact command signatures; items QA flagged as workflow gaps are marked
**⚠ pending**.

> During offline evaluation the default `--provider stub` writes schema-valid skeletons
> (no LLM). Set a real provider (e.g. `--provider gemini`) for content generation.

```bash
# 0. Install (or update - idempotent)
curl -fsSL https://downloads.agilekit.cc/nexa-dl/install.sh | bash
nexa --version            # 3.10.1
nexa doctor               # environment / gate pre-flight (optional external tools may warn)

# 1. Activate the signed license supplied by your NEXA maintainer
LICENSE_FILE="$HOME/Downloads/nexa.license"
chmod 600 "$LICENSE_FILE"
if (
  set +x
  NEXA_LICENSE_KEY="$(tr -d '\r\n' < "$LICENSE_FILE")"
  nexa license activate "$NEXA_LICENSE_KEY"
); then
  nexa license status
else
  activation_status=$?
  exit "$activation_status"
fi

# 2. Scaffold the 6-phase project in an empty directory
mkdir my-project && cd my-project
nexa init                 # -> 683 files: 00-intake .. 06-delivery + .claude/.nexa/config

# 3. Intake - set project mode + domain registry
nexa intake               # wizard; persists mode/domain

# 4. Build the FARE knowledge base from the repo
nexa scan all             # code + docs scan -> 00-intake/knowledge/.fare (sqlite)

# 5. Bootstrap the canonical Knowledge Base (13 KB files)
nexa kb bootstrap
nexa kb status            # verify mode=INITIALIZED, 13 files present

# 6. Requirement Documents (system level)
nexa rd --domain MRB --lang vi     # -> 01-rd/*  (SYSTEM_OVERVIEW, SYSTEM_ARCHITECTURE, EXTERNAL_IF_LIST)

# 7. Basic Design (system catalogs)
nexa bd --domain MRB --lang vi     # -> 02-bd/*  (JOB_LIST, C4_CONTEXT, screen/api catalogs …)

# 8. Artifact matrix - initialize + inspect
nexa doc init-matrix
nexa doc status                    # matrix summary
```

## License lifecycle

- Keep the `.license` file private. Do not commit it, upload it, paste it into tickets, or expose it in logs.
- `nexa license status` should report `Revalidation: ✓ valid` and, while online, `Revocation: ✓ not revoked`.
- `Revocation: ? offline - using cached verdict` means local signature and expiry checks passed, but current revocation status was not confirmed. Restore network access and run status again.
- `nexa upgrade` and reinstalls under the same user and `HOME` preserve `~/.nexa/license.json`. Licenses signed by the verifier retired before alpha.22 must still be reissued and activated again.
- On a new machine or under a different `HOME`, securely transfer the original `.license` file and activate again.
- Expired licenses stop authorizing licensed commands immediately. Revoked licenses stop after the revoked verdict is fetched and cached; while offline, NEXA uses the last cached revocation verdict. Obtain a renewed or reissued license from the NEXA maintainer.
- Direct `nexa license activate 'NEXA-<key>'` is supported, but can store the license in shell history. Prefer the file-based procedure above.

## Downstream (design to code to test)

```bash
# 9. ⚠ pending: register rd/bd artifacts into the matrix
#    After rd/bd, `nexa doc status` currently shows 0 entries (no auto-registration).
#    Track the intended registration/approve step here once confirmed with PM.

# 10. Detail Design from an approved BD (needs a BD artifact id)
nexa doc status                    # find the BD id, e.g. BD-MRB-RD-REQ-001
nexa dd from-bd --bd-id <BD-ID> --domain MRB

# 11. Coding - scan matrix, generate a task tip, dispatch a work packet
nexa build scan                    # matrix integrity / broken-ref check
nexa build tip                     # task tip packet for next pending artifact
#    (vibecode/dispatch needs work packets derived from the design chain)

# 12. Test cases from a DD artifact
nexa test create-from-dd --dd-id <DD-ID>
```

## Update / pin / verify

```bash
# update in place (alpha.12+): built-in self-updater
nexa upgrade
nexa upgrade --check                    # current vs latest, no install
nexa upgrade --version 3.2.0-alpha.11   # pin / roll back
# or (any version): re-run the installer, idempotent
curl -fsSL https://downloads.agilekit.cc/nexa-dl/install.sh | bash
curl -fsSL https://downloads.agilekit.cc/nexa-dl/install.sh | bash -s -- --version 3.2.0-alpha.10
# smoke-test a published version in a throwaway prefix (no global changes)
curl -fsSL https://downloads.agilekit.cc/nexa-dl/verify.sh | bash
```

## Notes

<!-- nexa:natives -->
- **Knowledge Base engine** (`better-sqlite3`) ships prebuilt for macOS (arm64, x64), Linux
  (x64, arm64, glibc) and Windows x64, for Node 22 and Node 24. Nothing compiles at install time.
  On another Node version `nexa kb ...` fails with a load error until you fetch the addon once:

  ```bash
  cd "$(npm root -g)/@fabbi-product-nexa/nexa-cli/node_modules/better-sqlite3"
  npx --yes prebuild-install@7.1.3
  ```
- **Windows:** `npm i -g <tgz>` needs no build tools (no install script runs in the tarball).
  The TUI is not supported on Windows yet.
<!-- /nexa:natives -->
- `nexa rd` / `nexa bd` now exit non-zero if no documents are generated (so CI catches failures).
- Diagram stages (`mmdc`, `drawio`) and audit gates (`openpyxl`, LibreOffice) need external tools.
  `nexa doctor` lists them; the core flow above does not require them.
