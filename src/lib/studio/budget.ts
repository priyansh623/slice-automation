/**
 * A persistent, concurrency-safe budget for paid work (image analysis), kept in PostgreSQL so it survives restarts and is shared by
 * every worker. The unit is one image sent for analysis; the window is one UTC hour.
 *
 * reserve is ONE atomic statement: it adds 1 to the hour's counter only if the counter is still below the limit, so any number of
 * workers racing for the last slot get exactly one yes. Accounting:
 *   - a slot is reserved BEFORE an image is claimed (when the budget is used up, images simply stay pending);
 *   - it is refunded if nothing was sent to the paid service (no image to claim; the original could not be read or reduced);
 *   - a failed model call still counts (the service may have billed it), and so does an attempt cut off by a shutdown;
 *   - a call that succeeds counts once, however many times the image is analysed again later (each analysis is a new reservation).
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { studioBudgetUsage } from '@/db/schema.pg';

export const BUDGET_WINDOW_MS = 3_600_000;
export const ANALYSIS_KIND = 'analysis';
export const hourStart = (now: number): number => Math.floor(now / BUDGET_WINDOW_MS) * BUDGET_WINDOW_MS;

export interface BudgetSlot { ok: boolean; kind: string; windowStart: number }

/** Reserves one unit. limit <= 0 means "no limit" (usage is still counted for monitoring). */
export async function reserveBudget(kind: string, limit: number, now = Date.now()): Promise<BudgetSlot> {
  const windowStart = hourStart(now);
  if (limit <= 0) {
    await db.insert(studioBudgetUsage).values({ kind, windowStart, reserved: 1, limitPerWindow: null, updatedAt: now })
      .onConflictDoUpdate({ target: [studioBudgetUsage.kind, studioBudgetUsage.windowStart], set: { reserved: sql`${studioBudgetUsage.reserved} + 1`, limitPerWindow: null, updatedAt: now } });
    return { ok: true, kind, windowStart };
  }
  const rows = await db.insert(studioBudgetUsage).values({ kind, windowStart, reserved: 1, limitPerWindow: limit, updatedAt: now })
    .onConflictDoUpdate({
      target: [studioBudgetUsage.kind, studioBudgetUsage.windowStart],
      set: { reserved: sql`${studioBudgetUsage.reserved} + 1`, limitPerWindow: limit, updatedAt: now },
      setWhere: sql`${studioBudgetUsage.reserved} - ${studioBudgetUsage.refunded} < ${limit}`,
    }).returning({ reserved: studioBudgetUsage.reserved });
  if (rows.length > 0) return { ok: true, kind, windowStart };
  await db.update(studioBudgetUsage).set({ exhaustedAt: sql`coalesce(${studioBudgetUsage.exhaustedAt}, ${now})`, updatedAt: now }).where(and(eq(studioBudgetUsage.kind, kind), eq(studioBudgetUsage.windowStart, windowStart)));
  return { ok: false, kind, windowStart };
}

/** Gives a reserved unit back (nothing was sent to the paid service). Never refunds more than was reserved. */
export async function refundBudget(slot: BudgetSlot, now = Date.now()): Promise<void> {
  await db.update(studioBudgetUsage).set({ refunded: sql`${studioBudgetUsage.refunded} + 1`, updatedAt: now })
    .where(and(eq(studioBudgetUsage.kind, slot.kind), eq(studioBudgetUsage.windowStart, slot.windowStart), sql`${studioBudgetUsage.refunded} < ${studioBudgetUsage.reserved}`));
}

export async function recordBudgetOutcome(slot: BudgetSlot, outcome: 'succeeded' | 'failed', now = Date.now()): Promise<void> {
  await db.update(studioBudgetUsage).set(outcome === 'succeeded' ? { succeeded: sql`${studioBudgetUsage.succeeded} + 1`, updatedAt: now } : { failed: sql`${studioBudgetUsage.failed} + 1`, updatedAt: now })
    .where(and(eq(studioBudgetUsage.kind, slot.kind), eq(studioBudgetUsage.windowStart, slot.windowStart)));
}

export interface BudgetStatus {
  kind: string;
  /** null = no limit configured. */
  limit: number | null;
  windowStart: number;
  resetsAt: number;
  used: number;
  remaining: number | null;
  succeeded: number;
  failed: number;
  refunded: number;
  exhausted: boolean;
  exhaustedAt: number | null;
}

/** Usage in the current hour, for monitoring and for deciding to wait. */
export async function budgetStatus(kind: string, limit: number, now = Date.now()): Promise<BudgetStatus> {
  const windowStart = hourStart(now);
  const row = (await db.select().from(studioBudgetUsage).where(and(eq(studioBudgetUsage.kind, kind), eq(studioBudgetUsage.windowStart, windowStart))).limit(1))[0];
  const used = row ? row.reserved - row.refunded : 0;
  const lim = limit > 0 ? limit : null;
  return {
    kind, limit: lim, windowStart, resetsAt: windowStart + BUDGET_WINDOW_MS, used,
    remaining: lim === null ? null : Math.max(lim - used, 0),
    succeeded: row?.succeeded ?? 0, failed: row?.failed ?? 0, refunded: row?.refunded ?? 0,
    exhausted: lim !== null && used >= lim, exhaustedAt: row?.exhaustedAt ?? null,
  };
}

/** Forgets windows older than 30 days. */
export async function pruneBudgetHistory(now = Date.now()): Promise<number> {
  return (await db.delete(studioBudgetUsage).where(lt(studioBudgetUsage.windowStart, now - 30 * 24 * BUDGET_WINDOW_MS)).returning({ k: studioBudgetUsage.kind })).length;
}
