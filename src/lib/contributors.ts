import type { ContributorRow, ReadinessStatus } from "@/types";

export type ContributorSortKey = "githubUsername" | "xlmBalance" | "lastCheckedAt" | "readiness";
export type ContributorFilter = "all" | "ready" | "needs_attention" | "low_reserve";

/** Column identifiers for the contributor table. */
export type ContributorColumnKey =
  | "githubUsername"
  | "stellarAddress"
  | "readiness"
  | "verified"
  | "xlmBalance"
  | "spendableXlmBalance"
  | "lastCheckedAt";

export interface ContributorColumnDef {
  key: ContributorColumnKey;
  label: string;
  defaultVisible: boolean;
}

/** All available columns in their default display order. */
export const CONTRIBUTOR_COLUMNS: ContributorColumnDef[] = [
  { key: "githubUsername",     label: "GitHub",         defaultVisible: true },
  { key: "stellarAddress",     label: "Stellar address", defaultVisible: true },
  { key: "readiness",          label: "Status",         defaultVisible: true },
  { key: "verified",           label: "Verified",       defaultVisible: true },
  { key: "xlmBalance",         label: "XLM",            defaultVisible: true },
  { key: "spendableXlmBalance",label: "Spendable XLM",  defaultVisible: false },
  { key: "lastCheckedAt",      label: "Last checked",   defaultVisible: true },
];

/** Returns the set of column keys that are visible by default. */
export function defaultVisibleColumns(): Set<ContributorColumnKey> {
  return new Set(
    CONTRIBUTOR_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
  );
}

export function readinessNeedsAttention(readiness: ReadinessStatus): boolean {
  return readiness !== "ready";
}

export function filterContributors(
  contributors: ContributorRow[],
  filter: ContributorFilter,
): ContributorRow[] {
  if (filter === "ready") {
    return contributors.filter((row) => row.readiness === "ready");
  }
  if (filter === "needs_attention") {
    return contributors.filter((row) => readinessNeedsAttention(row.readiness));
  }
  if (filter === "low_reserve") {
    return contributors.filter((row) => row.readiness === "low_reserve");
  }
  return [...contributors];
}

// ── Search injection guards (#777) ──────────────────────────────────────────
//
// Contributor search input is untrusted. Before it reaches any query parser
// (Prisma `where`, raw SQL fragments, or the in-memory matcher below) it is
// validated and normalized so it can never alter query structure. The guards
// are pure and deterministic so the API route and the UI share one contract.
//
// Documented reason codes (stable — do not rename without a docs update):
//   SEARCH_EMPTY      — query is empty/whitespace only (callers treat as "no filter")
//   SEARCH_TOO_LONG   — query exceeds CONTRIBUTOR_SEARCH_MAX_LENGTH characters
//   SEARCH_INVALID    — query contains characters outside the allowlist
//                       (control chars, quotes, comment markers, etc.)

/** Maximum accepted length of a raw contributor search query. */
export const CONTRIBUTOR_SEARCH_MAX_LENGTH = 128;

/** Stable reason codes returned by {@link validateContributorSearch}. */
export type ContributorSearchErrorCode =
  | "SEARCH_EMPTY"
  | "SEARCH_TOO_LONG"
  | "SEARCH_INVALID";

/**
 * Allowlist for search input: letters, digits, and the punctuation that can
 * legitimately appear in GitHub usernames or Stellar addresses (`@`, `-`, `_`,
 * `.`, `*`). Everything else — quotes, semicolons, backslashes, comment
 * markers, control characters — is rejected rather than stripped so callers
 * get a stable, documented failure instead of silent success.
 */
const CONTRIBUTOR_SEARCH_ALLOWED = /^[A-Za-z0-9@._*-]+$/;

/** Characters that are always rejected even if they slip past the allowlist. */
const CONTRIBUTOR_SEARCH_FORBIDDEN = /[\u0000-\u001f\u007f'"`;\\]/;

export type ContributorSearchValidation =
  | { ok: true; query: string }
  | { ok: false; code: ContributorSearchErrorCode; message: string };

/**
 * Validates and normalizes a raw contributor search query.
 *
 * Returns `{ ok: true, query }` with a trimmed, length-bounded value that is
 * safe to pass to a query parser, or `{ ok: false, code, message }` with a
 * stable reason code. An empty query is reported as `SEARCH_EMPTY` so callers
 * can decide whether that means "no filter" (the UI) or a 400 (the API).
 */
export function validateContributorSearch(
  raw: unknown,
): ContributorSearchValidation {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "SEARCH_EMPTY", message: "Search query is empty." };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "SEARCH_INVALID",
      message: "Search query must be a string.",
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "SEARCH_EMPTY", message: "Search query is empty." };
  }
  if (trimmed.length > CONTRIBUTOR_SEARCH_MAX_LENGTH) {
    return {
      ok: false,
      code: "SEARCH_TOO_LONG",
      message: `Search query must be at most ${CONTRIBUTOR_SEARCH_MAX_LENGTH} characters.`,
    };
  }
  if (
    CONTRIBUTOR_SEARCH_FORBIDDEN.test(trimmed) ||
    !CONTRIBUTOR_SEARCH_ALLOWED.test(trimmed)
  ) {
    return {
      ok: false,
      code: "SEARCH_INVALID",
      message:
        "Search query contains unsupported characters. Use letters, digits, and @ . _ - * only.",
    };
  }

  return { ok: true, query: trimmed };
}

/**
 * Normalizes contributor search values so matching is resilient to case,
 * whitespace, leading @ symbols, and punctuation-heavy addresses.
 */
function normalizeSearchValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );

  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );

      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }

  return matrix[left.length][right.length];
}

function fuzzyMatches(value: string, query: string): boolean {
  const normalizedValue = normalizeSearchValue(value);
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;
  if (normalizedValue.includes(normalizedQuery)) return true;

  const maxDistance = Math.max(1, Math.min(2, Math.floor(normalizedQuery.length * 0.2)));
  const vLen = normalizedValue.length;
  const qLen = normalizedQuery.length;
  if (Math.abs(vLen - qLen) > maxDistance + 2) return false;

  return levenshteinDistance(normalizedValue, normalizedQuery) <= maxDistance;
}

/**
 * Search contributors by GitHub username or Stellar address.
 * Performs case-insensitive matching and tolerates small typing errors.
 *
 * The query is validated through {@link validateContributorSearch} first; an
 * empty query returns all contributors (no filter), while an oversized or
 * malformed query throws a `ContributorSearchError` carrying a stable reason
 * code so callers never silently succeed on rejected input.
 */
export function searchContributors(
  contributors: ContributorRow[],
  query: string,
): ContributorRow[] {
  const validation = validateContributorSearch(query);
  if (!validation.ok) {
    if (validation.code === "SEARCH_EMPTY") return contributors;
    throw new ContributorSearchError(validation.code, validation.message);
  }

  const q = validation.query;

  return contributors.filter((row) => {
    const githubUsername = row.githubUsername ?? "";
    const stellarAddress = row.stellarAddress ?? "";

    return (
      fuzzyMatches(githubUsername, q) ||
      fuzzyMatches(stellarAddress, q) ||
      githubUsername.toLowerCase().includes(q.toLowerCase()) ||
      stellarAddress.toLowerCase().includes(q.toLowerCase())
    );
  });
}

/** Error thrown when a contributor search query fails validation. */
export class ContributorSearchError extends Error {
  readonly code: ContributorSearchErrorCode;

  constructor(code: ContributorSearchErrorCode, message: string) {
    super(message);
    this.name = "ContributorSearchError";
    this.code = code;
  }
}

export function compareContributors(
  a: ContributorRow,
  b: ContributorRow,
  sortKey: ContributorSortKey,
): number {
  if (sortKey === "githubUsername") {
    return a.githubUsername.localeCompare(b.githubUsername);
  }

  if (sortKey === "xlmBalance") {
    return Number.parseFloat(a.xlmBalance) - Number.parseFloat(b.xlmBalance);
  }

  if (sortKey === "readiness") {
    const order: Record<string, number> = { ready: 0, low_reserve: 1, not_ready: 2 };
    return (order[a.readiness] ?? 3) - (order[b.readiness] ?? 3);
  }

  const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
  const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
  return aTime - bTime;
}

export function sortContributors(
  contributors: ContributorRow[],
  sortKey: ContributorSortKey,
  ascending = true,
): ContributorRow[] {
  return [...contributors].sort((a, b) => {
    const comparison = compareContributors(a, b, sortKey);
    return ascending ? comparison : -comparison;
  });
}

export function countReadyContributors(contributors: ContributorRow[]): number {
  return contributors.filter((row) => row.readiness === "ready").length;
}

// ── Duplicate wallet claim conflict (#694) ───────────────────────────────────
//
// One copy for every path that rejects a wallet already claimed by someone
// else: POST /api/register (pre-check and P2002 race), the maintainer restore
// route, and the register form's fallback in register-error.ts. Each rejection
// from /api/register is also recorded as a RegistrationConflict that
// maintainers review via GET /api/maintainer/conflicts — see
// docs/MAINTAINER_WORKFLOW.md § "Duplicate Wallet Claim Conflicts".

/** Machine-readable code; matches REGISTER_ERROR_CODES.addressTaken. */
export const WALLET_CLAIM_CONFLICT_CODE = "ADDRESS_TAKEN" as const;

/** User-facing copy: what happened, and the two next steps. */
export const WALLET_CLAIM_CONFLICT_MESSAGE =
  "That Stellar address is already registered to another contributor. " +
  "Use a different wallet address, or contact a maintainer if you believe it is yours — " +
  "the conflict has been logged for maintainer review.";

/** JSON body for a 409 duplicate wallet claim response. */
export function walletClaimConflictBody(): {
  error: string;
  code: typeof WALLET_CLAIM_CONFLICT_CODE;
} {
  return { error: WALLET_CLAIM_CONFLICT_MESSAGE, code: WALLET_CLAIM_CONFLICT_CODE };
}
