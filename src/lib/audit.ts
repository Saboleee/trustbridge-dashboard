import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { toAuditLogEntry } from "@/lib/audit-format";
import { prisma } from "@/lib/prisma";
import type { AuditAction, AuditLogEntry } from "@/types";

export interface RecordAuditInput {
  action: AuditAction | string;
  actorId?: string | null;
  actorLogin?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Optional caller-supplied correlation id. When omitted a fresh id is
   * generated so every audit record is traceable from support tooling.
   */
  correlationId?: string | null;
}

/**
 * Generate a correlation id for a maintainer mutation.
 *
 * Correlation ids are surfaced on mutating maintainer API responses (success
 * and error payloads) so support can trace a Wave moderation action back to
 * its audit log entry. Uses `crypto.randomUUID` for a stable, opaque value.
 */
export function createCorrelationId(): string {
  return randomUUID();
}

/**
 * Persist a maintainer action to the audit log.
 *
 * Auditing is best-effort: a logging failure must never break the primary
 * action, so errors are swallowed (and surfaced to the server console).
 *
 * Returns the correlation id associated with the record (the caller-supplied
 * one when present, otherwise a freshly generated id) so mutation handlers can
 * echo it back to the client.
 */
export async function recordAuditLog(
  input: RecordAuditInput,
): Promise<string> {
  const correlationId = input.correlationId ?? createCorrelationId();
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actorId ?? null,
        actorLogin: input.actorLogin ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        metadata: {
          ...((input.metadata as Record<string, unknown> | undefined) ?? {}),
          correlationId,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record audit log", input.action, error);
  }
  return correlationId;
}

/**
 * Record a pubnet/testnet switch performed from settings.
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so the network switch trail stays consistent across call
 * sites. Best-effort like the underlying helper. Returns the correlation id.
 */
export async function recordNetworkSwitchAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  fromNetwork: string;
  toNetwork: string;
  confirmed: boolean;
  correlationId?: string | null;
}): Promise<string> {
  return recordAuditLog({
    action: "settings.network.switch",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.toNetwork,
    targetLabel: input.toNetwork,
    correlationId: input.correlationId ?? null,
    metadata: {
      fromNetwork: input.fromNetwork,
      toNetwork: input.toNetwork,
      confirmed: input.confirmed,
    },
  });
}

/**
 * Record a dispute status transition performed by a maintainer.
 *
 * Wraps {@link recordAuditLogStrict} with the canonical action name and a
 * stable metadata shape so the dispute trail stays consistent across call
 * sites. Strict: a transition must not succeed without an audit record, so
 * closed cases cannot reopen without a trail. Returns the correlation id.
 */
export async function recordDisputeTransitionAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  disputeId: string;
  fromStatus: string;
  toStatus: string;
  reason?: string | null;
  correlationId?: string | null;
}): Promise<string> {
  return recordAuditLogStrict({
    action: "dispute.status.transition",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.disputeId,
    targetLabel: input.disputeId,
    correlationId: input.correlationId ?? null,
    metadata: {
      disputeId: input.disputeId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
    },
  });
}

/**
 * Record a registration retention dry-run report generation.
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so operators can trace rehearsals before purging contributor
 * PII. Best-effort like the underlying helper; the report itself never
 * contains unmasked addresses (see `src/lib/cron-export.ts`). Returns the
 * correlation id.
 */
export async function recordRetentionDryRunAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  format: "json" | "csv";
  candidateCount: number;
  cutoff: string;
  reasonCode?: string | null;
  correlationId?: string | null;
}): Promise<string> {
  return recordAuditLog({
    action: "registrations.retention.dry_run",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.cutoff,
    targetLabel: input.format,
    correlationId: input.correlationId ?? null,
    metadata: {
      format: input.format,
      candidateCount: input.candidateCount,
      cutoff: input.cutoff,
      reasonCode: input.reasonCode ?? null,
    },
  });
}

/**
 * Record a DLQ replay attempt (success or failure).
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so the DLQ replay trail captures who forced a Wave
 * contributor recheck, which job was replayed, and the outcome. Best-effort
 * like the underlying helper: an audit failure must not break the replay.
 * Returns the correlation id.
 */
export async function recordDlqReplayAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  jobId: string;
  outcome: "success" | "failure";
  reason?: string | null;
  error?: string | null;
  correlationId?: string | null;
}): Promise<string> {
  return recordAuditLog({
    action: "queue.dlq.replay",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.jobId,
    targetLabel: input.jobId,
    correlationId: input.correlationId ?? null,
    metadata: {
      jobId: input.jobId,
      outcome: input.outcome,
      reason: input.reason ?? null,
      error: input.error ?? null,
    },
  });
}

/**
 * Persist a maintainer action to the audit log, surfacing failures.
 *
 * Unlike {@link recordAuditLog}, this variant rejects when the audit write
 * fails. Use it for privileged flows (e.g. ban appeal notes) where an
 * unaudited action must not be allowed to succeed. Returns the correlation id.
 */
export async function recordAuditLogStrict(
  input: RecordAuditInput,
): Promise<string> {
  const correlationId = input.correlationId ?? createCorrelationId();
  await prisma.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actorId ?? null,
      actorLogin: input.actorLogin ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      metadata: {
        ...((input.metadata as Record<string, unknown> | undefined) ?? {}),
        correlationId,
      } as Prisma.InputJsonValue,
    },
  });
  return correlationId;
}

/** Read the most recent audit log entries, newest first. */
export async function getRecentAuditLog(limit = 50): Promise<AuditLogEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return rows.map(toAuditLogEntry);
}
