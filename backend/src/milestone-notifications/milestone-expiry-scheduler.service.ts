import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  Optional,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { GigService } from '../gig/gig.service';
import { GigStatus, Gig } from '../gig/gig.entity';
import { MetricsService } from '../monitoring/metrics.service';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';

/** How often to run the expiry check sweep (every 24 hours). */
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Reminder thresholds in milliseconds — matching the 7d / 3d / 24h requirements. */
export const REMINDER_THRESHOLDS_MS = [
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '3d', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

export type ReminderThresholdLabel = (typeof REMINDER_THRESHOLDS_MS)[number]['label'];

/** Redis key prefix for deduplication records (TTL = threshold window). */
const REMINDER_DEDUP_PREFIX = 'milestone:reminder:sent:';

/** Redis key prefix for overdue-notification deduplication records (#973). */
const OVERDUE_DEDUP_PREFIX = 'milestone:overdue:sent:';

/** Maximum deduplication entries tracked in-memory when Redis is unavailable. */
const IN_MEMORY_DEDUP_MAX = 10_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Overdue escalation policy (#973): the first week past deadline gets a notification once
 * per day, then weekly thereafter — instead of flooding the recipient with an identical
 * notification on every sweep tick for as long as the gig stays unresolved.
 */
const OVERDUE_DAILY_ESCALATION_DAYS = 7;

/**
 * How long an overdue-notification dedup record is kept. Must cover the longest window a
 * single escalation stage can remain "current" (the weekly cadence) so a key never expires
 * while its stage is still the active one — each stage has its own key, so over-covering is
 * harmless, it just means a stale key outlives its stage, not that it gets reused.
 */
const OVERDUE_DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

export interface ReminderEvent {
  gigId: string;
  gigTitle: string;
  creator: string;
  respondBy: string;
  threshold: ReminderThresholdLabel;
  msRemaining: number;
}

export interface OverdueEvent {
  gigId: string;
  gigTitle: string;
  creator: string;
  respondBy: string;
  msOverdue: number;
  /** 0-based escalation stage: 0-6 are the daily stages in the first week, 7+ are weekly. */
  escalationWindow: number;
}

/**
 * MilestoneExpiryScheduler runs a daily sweep over open gig milestones and
 * dispatches reminder notifications at the 7-day, 3-day, and 24-hour marks
 * before the response deadline.
 *
 * It also dispatches overdue notifications for gigs whose deadline has already passed but
 * which are still OPEN (the parallel `GigExpiryWorkerService` sweep hasn't yet marked them
 * EXPIRED) — once immediately, then daily for a week, then weekly thereafter (#973), rather
 * than on every sweep tick for as long as the gig stays unresolved.
 *
 * Deduplication:
 *   Each (gigId × threshold) pair, and each (gigId × overdue escalation stage) pair, is
 *   deduplicated so a given notification fires at most once per window. Redis is the
 *   primary dedup store (TTL = window length), with an in-memory LRU fallback when Redis
 *   is unavailable.
 *
 * Follows the `GigExpiryWorkerService` pattern: plain `setInterval`, no
 * `@nestjs/schedule` decorators, configurable via env, single-concurrency guard,
 * and graceful shutdown.
 */
@Injectable()
export class MilestoneExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MilestoneExpiryScheduler.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  /** In-memory fallback dedup set when Redis is unavailable. */
  private readonly inMemoryDedup = new Set<string>();
  private readonly inMemoryDedupQueue: string[] = [];

  constructor(
    private readonly gigService: GigService,
    private readonly metrics: MetricsService,
    private readonly gateway: MilestoneNotificationsGateway,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Milestone expiry scheduler disabled (MILESTONE_EXPIRY_SWEEP_INTERVAL_MS <= 0)');
      return;
    }

    // Run once immediately so the first sweep doesn't wait a full day after startup.
    this.runSweep().catch(err =>
      this.logger.error('Initial milestone expiry sweep failed', err),
    );

    this.timer = setInterval(() => {
      this.runSweep().catch(err =>
        this.logger.error('Milestone expiry sweep tick failed', err),
      );
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Milestone expiry scheduler started — sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Run a single sweep over all open gigs, computing each one's time-to-deadline
   * and dispatching reminder notifications for gigs that fall within a threshold
   * window and have not already had that reminder sent.
   *
   * Exposed publicly so tests and admin endpoints can trigger a sweep on demand.
   */
  async runSweep(now: Date = new Date()): Promise<ReminderEvent[]> {
    if (this.sweeping) {
      this.logger.debug('Previous milestone sweep still in flight — skipping this tick');
      this.metrics.increment('milestone_expiry_sweep_skipped_total');
      return [];
    }

    this.sweeping = true;
    const startMs = Date.now();
    const dispatched: ReminderEvent[] = [];
    let overdueDispatched = 0;

    try {
      // Only open gigs can be nearing expiry — expired/accepted/cancelled are irrelevant.
      const openGigs = await this.gigService.findByStatus(GigStatus.OPEN);

      for (const gig of openGigs) {
        const reminders = await this.computeReminders(gig, now);
        for (const reminder of reminders) {
          const claimed = await this.claimReminder(reminder.gigId, reminder.threshold);
          if (!claimed) {
            this.logger.debug(
              `Reminder ${reminder.threshold} for gig ${reminder.gigId} already claimed or sent — skipping`,
            );
            continue;
          }

          await this.dispatchReminder(reminder);
          dispatched.push(reminder);
        }

        const overdue = this.computeOverdue(gig, now);
        if (overdue) {
          const claimed = await this.claimOverdueNotification(
            overdue.gigId,
            overdue.escalationWindow,
          );
          if (claimed) {
            await this.dispatchOverdue(overdue);
            overdueDispatched += 1;
          } else {
            this.logger.debug(
              `Overdue notification (stage ${overdue.escalationWindow}) for gig ${overdue.gigId} already sent — skipping`,
            );
          }
        }
      }

      const durationMs = Date.now() - startMs;
      this.metrics.increment('milestone_expiry_sweep_reminders_total', {}, dispatched.length);
      this.metrics.increment('milestone_overdue_notifications_total', {}, overdueDispatched);
      this.metrics.increment('milestone_expiry_sweep_duration_ms', { status: 'success' });
      this.logger.log(
        `Milestone expiry sweep completed in ${durationMs}ms — ${dispatched.length} reminder(s) and ` +
          `${overdueDispatched} overdue notification(s) dispatched across ${openGigs.length} open gig(s)`,
      );
    } catch (err) {
      this.metrics.increment('milestone_expiry_sweep_duration_ms', { status: 'error' });
      this.logger.error('Milestone expiry sweep failed', err);
    } finally {
      this.sweeping = false;
    }

    return dispatched;
  }

  /**
   * Determine which reminder thresholds apply to `gig` relative to `now`.
   * A threshold applies when the deadline is within that window but outside
   * the next-smaller window (so each gig triggers each reminder at most once
   * per sweep, regardless of how many thresholds it falls inside).
   *
   * `msRemaining` is computed from the full deadline timestamp (`respondBy`) minus `now`,
   * both to millisecond precision — never truncated to a calendar day — so a threshold
   * crossing is always exactly `threshold.ms` before the real deadline instant, regardless
   * of what time of day the deadline itself falls on (#972).
   */
  computeReminders(gig: Gig, now: Date = new Date()): ReminderEvent[] {
    const deadline = new Date(gig.respondBy).getTime();
    const msRemaining = deadline - now.getTime();

    if (msRemaining <= 0) {
      // Already past deadline — handled by computeOverdue()/the expiry worker, not reminders.
      return [];
    }

    const reminders: ReminderEvent[] = [];

    for (const threshold of REMINDER_THRESHOLDS_MS) {
      if (msRemaining <= threshold.ms) {
        reminders.push({
          gigId: gig.id,
          gigTitle: gig.title,
          creator: gig.creator,
          respondBy: gig.respondBy,
          threshold: threshold.label,
          msRemaining,
        });
      }
    }

    return reminders;
  }

  /**
   * Determine the overdue escalation stage for `gig` relative to `now`, or `undefined` if
   * its deadline hasn't passed yet. Like `computeReminders`, this compares full millisecond
   * timestamps, never calendar-day boundaries (#972).
   *
   * `escalationWindow` buckets how overdue the gig is: 0-6 for each of the first 7 days
   * overdue (daily cadence), then one bucket per week after that (weekly cadence) — so
   * `claimOverdueNotification` dispatches at most once per bucket instead of once per sweep
   * tick for as long as the gig stays unresolved (#973).
   */
  computeOverdue(gig: Gig, now: Date = new Date()): OverdueEvent | undefined {
    const deadline = new Date(gig.respondBy).getTime();
    const msOverdue = now.getTime() - deadline;
    if (msOverdue < 0) return undefined;

    const daysOverdue = Math.floor(msOverdue / MS_PER_DAY);
    const escalationWindow =
      daysOverdue < OVERDUE_DAILY_ESCALATION_DAYS
        ? daysOverdue
        : OVERDUE_DAILY_ESCALATION_DAYS +
          Math.floor((daysOverdue - OVERDUE_DAILY_ESCALATION_DAYS) / 7);

    return {
      gigId: gig.id,
      gigTitle: gig.title,
      creator: gig.creator,
      respondBy: gig.respondBy,
      msOverdue,
      escalationWindow,
    };
  }

  // ─── Deduplication ────────────────────────────────────────────────────────────

  /**
   * Atomically claims the right to send a (gigId × threshold) reminder.
   * Returns true if this replica won the claim and should dispatch the reminder;
   * false if another replica already claimed it or it was already sent.
   *
   * Uses Redis SET NX EX for atomic cross-replica deduplication, falling back
   * to in-memory when Redis is unavailable (#799).
   */
  async claimReminder(gigId: string, threshold: ReminderThresholdLabel): Promise<boolean> {
    const ttlMs = REMINDER_THRESHOLDS_MS.find(t => t.label === threshold)?.ms ?? DEFAULT_SWEEP_INTERVAL_MS;
    return this.claim(this.dedupKey(gigId, threshold), Math.ceil(ttlMs / 1000));
  }

  /**
   * Atomically claims the right to send the overdue notification for `gigId` at
   * `escalationWindow`. Each escalation stage has its own dedup key, so this returns true
   * exactly once per stage per gig — the sweep calls it every tick, but it only dispatches
   * on stage transitions (#973).
   */
  async claimOverdueNotification(gigId: string, escalationWindow: number): Promise<boolean> {
    return this.claim(this.overdueDedupKey(gigId, escalationWindow), OVERDUE_DEDUP_TTL_SEC);
  }

  private async claim(key: string, ttlSec: number): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
        if (result !== 'OK') {
          // Another replica already claimed this notification
          return false;
        }
        return true;
      } catch (err) {
        this.logger.warn(`Redis dedup claim failed for ${key}, falling back to in-memory`, err);
      }
    }

    // In-memory LRU fallback
    if (this.inMemoryDedup.has(key)) {
      return false;
    }
    this.inMemoryDedup.add(key);
    this.inMemoryDedupQueue.push(key);
    if (this.inMemoryDedupQueue.length > IN_MEMORY_DEDUP_MAX) {
      const oldest = this.inMemoryDedupQueue.shift();
      if (oldest) this.inMemoryDedup.delete(oldest);
    }
    return true;
  }

  // ─── Notification dispatch ───────────────────────────────────────────────────

  /**
   * Dispatches a reminder notification to the WebSocket gateway so connected
   * clients subscribed to the gig room receive real-time alerts.
   */
  private async dispatchReminder(reminder: ReminderEvent): Promise<void> {
    try {
      this.gateway.emitMilestoneUpdate(reminder.gigId, 'milestone.expiry_reminder', {
        gigId: reminder.gigId,
        gigTitle: reminder.gigTitle,
        creator: reminder.creator,
        respondBy: reminder.respondBy,
        threshold: reminder.threshold,
        msRemaining: reminder.msRemaining,
        message: `Milestone deadline in ${reminder.threshold}: "${reminder.gigTitle}"`,
      });

      this.logger.log(
        `Dispatched ${reminder.threshold} expiry reminder for gig ${reminder.gigId} (${reminder.gigTitle})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to dispatch reminder for gig ${reminder.gigId}`,
        err,
      );
      throw err;
    }
  }

  /**
   * Dispatches an overdue-notification to the WebSocket gateway, escalating tone with the
   * stage so a recipient can tell a fresh overdue notice from a long-standing one (#973).
   */
  private async dispatchOverdue(event: OverdueEvent): Promise<void> {
    try {
      const daysOverdue = Math.floor(event.msOverdue / MS_PER_DAY);
      this.gateway.emitMilestoneUpdate(event.gigId, 'milestone.overdue', {
        gigId: event.gigId,
        gigTitle: event.gigTitle,
        creator: event.creator,
        respondBy: event.respondBy,
        msOverdue: event.msOverdue,
        escalationWindow: event.escalationWindow,
        message: `Milestone deadline passed ${daysOverdue} day(s) ago: "${event.gigTitle}"`,
      });

      this.logger.log(
        `Dispatched overdue notification (stage ${event.escalationWindow}) for gig ${event.gigId} (${event.gigTitle})`,
      );
    } catch (err) {
      this.logger.error(`Failed to dispatch overdue notification for gig ${event.gigId}`, err);
      throw err;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private dedupKey(gigId: string, threshold: ReminderThresholdLabel): string {
    return `${REMINDER_DEDUP_PREFIX}${gigId}:${threshold}`;
  }

  private overdueDedupKey(gigId: string, escalationWindow: number): string {
    return `${OVERDUE_DEDUP_PREFIX}${gigId}:${escalationWindow}`;
  }

  private getIntervalMs(): number {
    const raw = Number(process.env.MILESTONE_EXPIRY_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && raw !== 0 ? raw : DEFAULT_SWEEP_INTERVAL_MS;
  }
}
