# Sessions

## Authentication

Dashboard sessions are resolved from the `x-session-user` header set by the
auth proxy (see `src/lib/auth.ts`). Requests without a valid session are
rejected with `unauthenticated` (401); maintainer-only actions return
`forbidden` (403) when the caller lacks org-scoped maintainer privileges.

## Webhook deliveries

GitHub org membership webhooks are authenticated by signature, not by session.
Only `sha256` signatures (`X-Hub-Signature-256`) are accepted. Deliveries with
missing, oversized, malformed, weak/unknown-algorithm, or mismatched signatures
are rejected with the stable reason codes documented in
`docs/SECURITY_POLINRIDER.md` (`missing_signature`, `oversized_signature`,
`malformed_signature`, `unsupported_algorithm`, `signature_mismatch`).

Operators rotating the webhook secret should follow the rotation steps in
`docs/SECURITY_POLINRIDER.md`.
