# Feature flags

Ɛ Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

`src/lib/feature-flags.ts` is a small flags helper with two sources (env and an
optional database table) plus a built-in default per flag. It exists so shipping-freeze windows, new webhooks, i18n, and other risky changes can be
gated without a deploy — and turned **off** fast during a Wave.

Out of scope: LaunchDarkly / a hosted flag service. An in-app admin UI is
optional; `setFeatureFlag()` and `getAllFeatureFlags()` are provided for one.
An admin-only read-only panel lives at `/dashboard/settings` and lists each
flag's key, resolved value and source.

---

## Resolution order

For every flag, the first source that produces a value wins:

1. **Env override** — `FEATURE_FLAG_<KEY>` (e.g. `FEATURE_FLAG_BATCH_RECHECK=off`).
   Accepted truthy values: `1`, `true`, `on`, `yes`, `enabled`; falsy: `0`,
   `false`, `off`, `no`, `disabled` (case-insensitive). An unrecognised value is
   ignored and resolution falls through.
2. **Database row** — a `FeatureFlag` row, **only** when `FEATURE_FLAGS_DB_ENABLED`
   is truthy. Reads are cached in-process for `FEATURE_FLAGS_CACHE_TTL_MS`
   (default 30s); `clearFeatureFlagCache()` is called automatically after
   `setFeatureFlag()`.
3. **Built-in default** — the `default` in `FEATURE_FLAGS`.

### Fail closed

Flags marked `risky` gate a mutating or destructive path. If the DB source is
**enabled but unreadable** (connection error, table missing, …) a risky flag
resolves to `false` — never to its default. A DB outage therefore *closes*
risky writes rather than leaving them open. Non-risky flags fall back to their
default in the same situation. An env override always wins, even when the DB is
down.

---

## Percentage rollouts (sticky bucketing, issue #661)

A flag can be rolled out to a percentage of users or orgs without flickering
the UI between evaluations. Set `FEATURE_FLAG_<KEY>_ROLLOUT_PERCENT` to an
integer `0`–`100` (unset / invalid = full audience when the flag is on).

### Sticky bucketing keys (user vs org)

Every percentage rollout is bucketed by a **sticky key** so a subject lands in
the same bucket on every request. The key is built from a stable identifier —
never a display name, email, or session id that can change mid-session:

| Scope | `subjectId` source | When to use |
|---|---|---|
| `user` | GitHub **user id** (numeric, immutable) | Per-user rollouts (UI experiments, per-account features) |
| `org` | GitHub **org id** (numeric, immutable) | Per-org rollouts (org-scoped settings, billing, shared features) |

The scope is chosen by the caller and passed to
`isFeatureEnabledForSubject(flagKey, scope, subjectId)`. Pick **one** scope per
flag and keep it stable: switching a flag from `user` to `org` (or vice versa)
re-buckets every subject and can flip the Wave UI mid-session.

### Why sticky keys prevent mid-session flicker

A non-sticky rollout (e.g. `Math.random() < percent`, or hashing a value that
changes per request such as a session token or timestamp) re-rolls the dice on
every evaluation. A user who is "in" on page load can be "out" on the next
poll, so the Wave UI appears and disappears. Sticky bucketing hashes a stable
`(flag, scope, subjectId)` tuple, so the same subject always resolves to the
same bucket — the flag is stable for the whole session and across requests.

### Algorithm

1. Subject key = `${flagKey}:${scope}:${subjectId}` where `scope` is `user` or
   `org` and `subjectId` is a **stable** id (GitHub user/org id — never a
   display name that can change).
2. FNV-1a 32-bit hash of that key → unsigned 32-bit integer.
3. Bucket = `hash % 100` (range `0`–`99`).
4. Subject is in the rollout iff `bucket < rolloutPercent`.

**Boundaries:** `0` → always off; `≥ 100` → always on; non-finite / negative →
fail closed (off). The same `(flag, scope, subjectId)` always lands in the same
bucket, so repeated `isFeatureEnabledForSubject()` calls are **sticky** per
user/org.

### Failure paths

| Input | Result |
|---|---|
| Missing / empty `subjectId` | Fail closed — subject is **not** in the rollout |
| Unknown `scope` (not `user` / `org`) | Fail closed — subject is **not** in the rollout |
| Malformed `FEATURE_FLAG_<KEY>_ROLLOUT_PERCENT` (non-numeric) | Treated as unset → full audience when the flag is on |
| Out-of-range percent (`< 0` or `> 100`) | Clamped: `0` → off, `≥ 100` → on |
| Non-finite percent (`NaN`, `Infinity`) | Fail closed (off) |

Helpers live in `src/lib/feature-flags.ts`: `rolloutBucket()`, `isInRollout()`,
`getRolloutPercent()`, `isFeatureEnabledForSubject()`.

### Flags API auth (issue #661)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/settings/feature-flags` | Session + `isMaintainer` (401 / 403) |
| `POST` | `/api/settings/feature-flags` | Same-origin CSRF **and** maintainer session |

`POST` body: `{ "key": "<flag-key>", "enabled": true|false }`. Unknown keys and
non-boolean `enabled` return `400`. Writes go through `setFeatureFlag()` and
require `FEATURE_FLAGS_DB_ENABLED`; there is **no** unauthenticated toggle path.

---

## Freeze windows

A **freeze window** is a period (typically during a Wave) when risky, mutating
paths are turned off so contributors can't accidentally ship or re-queue work.
Freeze windows are implemented entirely with the flags below — there is no
separate freeze subsystem. To open a freeze, flip the relevant flags off (env
override or DB row); to close it, flip them back on.

| Flag | Freeze effect when off |
|---|---|
| `batch_recheck` | `POST /api/contributors` returns `403` — no per-contributor Horizon fan-out |
| `invite_generation` | `POST /api/invites/generate` returns `403` — invite issuance frozen |
| `dlq_retry` | Contributor and Soroban outbox replay endpoints return `403` — failed items stay parked |
| `maintenance_mode` | Composes with the `MAINTENANCE` env var to take the app read-only |

Because these flags are `risky`, a DB outage during a freeze keeps them **off**
(fail closed) — see [Fail closed](#fail-closed) above. The env vars that drive
freeze windows (`FEATURE_FLAG_*`, `FEATURE_FLAGS_DB_ENABLED`,
`FEATURE_FLAGS_CACHE_TTL_MS`, `MAINTENANCE`) are documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#feature-flags-and-freeze-windows).

### Freeze interactions with the registration UI

Registration is gated by the same flags, so a freeze must be **visible** in the
UI rather than surfacing as a dead end. The registration page
(`src/app/register/`) resolves the freeze state server-side and renders a
read-only notice instead of the form when registration is frozen; the operator
panel at `/dashboard/settings` shows the same state so maintainers can confirm
why sign-ups are closed.

| Flag | Freeze effect when off | Registration UI |
|---|---|---|
| `invite_generation` | `POST /api/invites/generate` returns `403` | `/register` shows the freeze notice; the invite form is hidden and no submit is attempted |
| `maintenance_mode` | App is read-only (composes with `MAINTENANCE`) | `/register` shows the freeze notice; the form is disabled |

When registration is frozen the page renders a stable, actionable message
(`Registration is currently paused during a freeze window. Please try again
later.`) instead of the form, and the API still returns `403` for any direct
`POST` — the UI copy and the API guard stay consistent.

Example — open a registration freeze with an env override:

```bash
FEATURE_FLAG_INVITE_GENERATION=off \
FEATURE_FLAG_MAINTENANCE_MODE=on \
  npm run start
```

Example — open the same freeze with a database row:

```sql
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('invite_generation', false, now())
ON CONFLICT ("key") DO UPDATE SET "enabled" = excluded."enabled", "updatedAt" = now();
```

Because `invite_generation` and `maintenance_mode` are `risky`, a DB outage
during the freeze keeps registration **closed** (fail closed) — the UI notice
stays up and the API keeps returning `403`.

### Freeze-window env vars

The `freeze_window` flag gates the helpers in `src/lib/freeze-window.ts`. When
it is **off**, those helpers never block a request regardless of the
`FREEZE_WINDOW_*` env vars below. When it is **on** (the default), the
`FREEZE_WINDOW_*` vars decide whether a freeze is currently active. These are
the same variables documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#freeze-window-issue-536) — keep both pages in
sync when changing parsing or defaults.

| Env var | Type | Default | Effect |
|---|---|---|---|
| `FREEZE_WINDOW_ENABLED` | boolean | `false` | Master switch. When falsy, no freeze is ever active and the other `FREEZE_WINDOW_*` vars are ignored. |
| `FREEZE_WINDOW_START` | ISO-8601 timestamp | _(unset)_ | Start of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_END` | ISO-8601 timestamp | _(unset)_ | End of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_MESSAGE` | string | _(built-in)_ | Operator-facing message returned with `403` responses while a freeze is active. |

A freeze is active only when `FREEZE_WINDOW_ENABLED` is truthy **and** the
current time falls within `[FREEZE_WINDOW_START, FREEZE_WINDOW_END)`. If either
timestamp is missing or invalid, no scheduled freeze is active (fail open on
misconfiguration, but the `freeze_window` flag still gates the helpers).

Example — schedule a freeze for a Wave:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=on
FREEZE_WINDOW_ENABLED=true
FREEZE_WINDOW_START=2026-03-01T00:00:00Z
FREEZE_WINDOW_END=2026-03-08T00:00:00Z
FREEZE_WINDOW_MESSAGE="Wave 12 freeze in effect — mutating APIs are paused."
```

Example — disable freeze-window blocking entirely:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=off
```

---

## The fl

/* … truncated 4288 chars — edit only what you need near the top … */
