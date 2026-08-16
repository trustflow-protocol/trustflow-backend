import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateGigDto } from './gig.dto';
import { DEFAULT_RESPONSE_WINDOW_HOURS, Gig, GigStatus } from './gig.entity';

@Injectable()
export class GigService {
  /** In-memory gig solicitation store — keyed by gig ID. */
  private readonly gigs = new Map<string, Gig>();

  create(dto: CreateGigDto): Gig {
    const id = `gig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const windowHours = dto.responseWindowHours ?? DEFAULT_RESPONSE_WINDOW_HOURS;

    const gig: Gig = {
      id,
      creator: dto.creator,
      title: dto.title,
      budgetXLM: dto.budgetXLM,
      status: GigStatus.OPEN,
      createdAt: now.toISOString(),
      respondBy: new Date(now.getTime() + windowHours * 60 * 60 * 1000).toISOString(),
    };
    this.gigs.set(id, gig);
    return gig;
  }

  findAll(): Gig[] {
    return [...this.gigs.values()];
  }

  findById(id: string): Gig {
    const gig = this.gigs.get(id);
    if (!gig) throw new NotFoundException(`Gig ${id} not found`);
    return gig;
  }

  findByCreator(address: string): Gig[] {
    return this.findAll().filter(g => g.creator === address);
  }

  /** Open gig solicitations whose response deadline has passed as of `now`. */
  findExpirable(now: Date = new Date()): Gig[] {
    return this.findAll().filter(g => g.status === GigStatus.OPEN && new Date(g.respondBy) <= now);
  }

  accept(id: string, responder: string): Gig {
    const gig = this.findById(id);
    if (gig.status !== GigStatus.OPEN) {
      throw new BadRequestException(`Cannot accept a gig with status "${gig.status}"`);
    }
    gig.status = GigStatus.ACCEPTED;
    gig.acceptedBy = responder;
    gig.acceptedAt = new Date().toISOString();
    return gig;
  }

  cancel(id: string): Gig {
    const gig = this.findById(id);
    if (gig.status !== GigStatus.OPEN) {
      throw new BadRequestException(`Cannot cancel a gig with status "${gig.status}"`);
    }
    gig.status = GigStatus.CANCELLED;
    gig.cancelledAt = new Date().toISOString();
    return gig;
  }

  /**
   * Marks a still-open gig as expired. Returns `undefined` (no-op) if it was already
   * resolved by the time the sweep reached it. Used by the expiry sweep worker.
   */
  expire(id: string): Gig | undefined {
    const gig = this.gigs.get(id);
    if (!gig || gig.status !== GigStatus.OPEN) return undefined;
    gig.status = GigStatus.EXPIRED;
    gig.expiredAt = new Date().toISOString();
    return gig;
  }
}
