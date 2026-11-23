# PolinRider malware protection

This repository includes a **read-only** scanner for indicators associated with the **PolinRider** (Contagious Interview / Famous Chollima–linked) supply-chain campaign.

## What we look for

Confirmed fail conditions:

- Obfuscation / loader markers such as `rmcej%otb%`, `$_1e42`, `global['!']`, `global["_V"]`, `global.i="A…"`
- Fake font payloads (`.woff`/`.woff2`/etc. that are text/JavaScript instead of real font binaries)
- `.vscode/tasks.json` with `runOn: folderOpen` executing `node` on a non-JS asset (classic PolinRider trigger)
- `.gitignore` entries for `temp_auto_push.bat` / `temp_interactive_push.bat`
- Those batch helper filenames in the tree
- Unexpected `dist/setup.js`
- Build configs with extreme line length **and** obfuscation markers (inline config-injection variant)
- `package.json` lifecycle scripts that curl/wget-pipe to shell or `node -e` remote payloads

Warnings (human review, do not auto-fail unless combined with confirmed markers):

- `folderOpen` tasks without a non-JS `node` target
- Unexpected `.bat`/`.cmd` files
- Extreme config line length without markers

## CI workflow

Workflow: `.github/workflows/polinrider-security.yml`  
Required check name to configure: **`PolinRider Security Scan`**

Runs on:

- Every pull request (`opened`, `synchronize`, `reopened`, `ready_for_review`)
- Pushes to `main` / `master`
- Manual `workflow_dispatch` (`repo` or `self-test`)

Safety guarantees:

- No `npm install` / no dependency install from the PR
- Does not execute scanned JS/fonts/configs
- Uses `persist-credentials: false`
- Only `contents: read` + `pull-requests: read` permissions
- Fixtures under `security/fixtures/polinrider/` are excluded from production scans

## Important: this is NOT full CI

The required GitHub ruleset only enforces **`PolinRider Security Scan`**.

- Failing Jest / typecheck / lint / cargo / other CI jobs does **not** block merge via this ruleset.
- That matches Wave operations: contributors often cannot get full CI green; maintainers merge assigned PRs and clean CI after the wave.
- If **PolinRider Security Scan** is red, **do not merge** — that means malware indicators, not a normal test flake.

## Make the check required (branch protection / ruleset)

Already configured on TrustBridge repos as ruleset **Require PolinRider Security Scan**.

To recreate elsewhere:

1. Settings → Rules → Rulesets (or classic branch protection) targeting `main`.
2. Enable **Require status checks to pass**.
3. Add required check: **`PolinRider Security Scan`** only (do **not** add the whole CI suite unless you intend to block on tests).
4. Keep admin bypass for emergencies.

### GitHub CLI example (ruleset)

```bash
# Adjust owner/repo. Requires admin.
gh api repos/Stellar-TrustBridge/REPO/rulesets \
  --method POST \
  --input - <<'EOF'
{
  "name": "PolinRider required check",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "PolinRider Security Scan" }
        ]
      }
    }
  ],
  "bypass_actors": []
}
EOF
```

## Local usage

```bash
# Clean tree scan
./scripts/security/scan-polinrider.sh .

# Prove detection using harmless fixtures
./scripts/security/scan-polinrider.sh . self-test
```

Self-test **must fail the nested scan** (exit 0 from self-test wrapper means fixtures were detected).

## Investigating false positives

1. Open the Actions log for **PolinRider Security Scan**.
2. Identify the `CONFIRMED:` / `::error::` lines.
3. If a legitimate file matches a marker string by coincidence, adjust the file or open an issue to refine the scanner — do **not** disable the required check globally.
4. Fixtures intentionally contain markers under `security/fixtures/polinrider/` and are excluded from normal scans.

## Limitations

- History advisory job is informational (pickaxe on recent commits); attackers can rewrite history.
- Binary packing / novel obfuscators may evade static markers — treat unexpected `folderOpen` tasks and text “fonts” as high signal.
- Scanner does not rotate credentials or quarantine developer machines. If you opened an infected tree in VS Code with auto-tasks enabled, treat the machine as compromised and rotate secrets from a clean device.

## Credential exposure

This tooling **does not** rotate credentials. If malware was confirmed on a machine that had GitHub/npm/cloud access:

1. Stop using that machine for privileged work.
2. From a clean device, rotate GitHub, npm, cloud, SSH, wallet, and CI secrets.
3. Review recent publishes and force-pushes on your accounts.

## Webhook signature algorithm allowlist

The GitHub org-membership webhook (`src/lib/github-org-membership-webhook.ts`) verifies the
`X-Hub-Signature-256` header using an explicit allowlist of documented GitHub signature
algorithms. Only **`sha256`** is accepted; weak (`sha1`, `md5`) and unknown algorithms are
rejected before any HMAC comparison runs.

Stable reason codes returned by the verifier (never silently accepted):

| Reason code | Meaning |
| --- | --- |
| `signature_missing` | No `X-Hub-Signature-256` header present |
| `signature_malformed` | Header not in `sha256=<hex>` form, or non-hex digest |
| `signature_oversized` | Header exceeds the documented maximum length |
| `signature_algorithm_unsupported` | Algorithm prefix is not on the allowlist (e.g. `sha1`, `md5`, unknown) |
| `signature_mismatch` | Well-formed `sha256` signature that does not match the computed HMAC |
| `secret_missing` | Webhook secret is not configured |

### Secret rotation

When rotating the webhook secret:

1. Generate a new high-entropy secret and store it in the secret manager (never in the repo).
2. Update the GitHub org webhook configuration to the new secret.
3. Deploy the new secret to the dashboard environment.
4. Confirm deliveries succeed (HTTP 2xx) and no `signature_mismatch` reason codes appear in logs.
5. Revoke the old secret after the overlap window closes.

Signature verification is constant-time and algorithm-pinned; rotating the secret does not
change the accepted algorithm (`sha256` only).
