# Environment Variables

This document lists environment variables used by the TrustBridge dashboard.
Values shown are placeholders; never commit real secrets.

## Core

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `NEXTAUTH_SECRET` | yes | Session signing secret. |
| `NEXTAUTH_URL` | yes | Public base URL of the dashboard. |

## Feature flags

Feature flag evaluation is configured in code (`src/lib/feature-flags.ts`) and
served via `GET /api/settings/feature-flags`. Percentage rollouts use a sticky
bucketing key (`user` or `org`) so a subject always resolves to the same bucket
across requests. See `docs/FEATURE_FLAGS.md` for rollout semantics and reason
codes.

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `FEATURE_FLAGS_PAUSED` | no | When `true`, flag evaluation returns the frozen snapshot instead of live values. |

Operators changing rollout percentages should expect sticky bucketing: a user
or org already inside a rollout stays inside it, and one outside stays outside,
until the percentage changes.
