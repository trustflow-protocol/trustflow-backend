import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
import { GigService } from '../gig/gig.service';
import { GigStatus } from '../gig/gig.entity';
import { UploadDeliverableDto } from './deliverable.dto';
import { Deliverable, DeliverableStatus } from './deliverable.entity';

const DELIVERABLE_KEY_PREFIX = 'deliverable:';
const DELIVERABLES_BY_GIG_PREFIX = 'deliverables:gig:';

@Injectable()
export class DeliverableService {
  private readonly logger = new Logger(DeliverableService.name);
  private readonly deliverables = new Map<string, Deliverable>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly ipfsPinningService: IpfsPinningService,
    private readonly gigService: GigService,
  ) {}

  /**
   * Pins a deliverable for a gig. `requester` is the authenticated wallet (from the JWT);
   * the gig must exist, be accepted, and have been accepted by both `dto.freelancer` and the
   * requester. Nothing is decoded or pinned until those checks pass.
   */
  async upload(dto: UploadDeliverableDto, requester: string): Promise<Deliverable> {
    await this.assertMayDeliver(dto, requester);

    const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const pinResult = await this.ipfsPinningService.pinContent({
      content: dto.content,
      filename: dto.filename,
    });

    const deliverable: Deliverable = {
      id,
      gigId: dto.gigId,
      freelancer: dto.freelancer,
      cid: pinResult.cid,
      filename: dto.filename,
      size: pinResult.size,
      status: DeliverableStatus.PINNED,
      createdAt: now,
      updatedAt: now,
    };

    if (this.redis) {
      try {
        await this.redis
          .multi()
          .set(this.deliverableKey(id), JSON.stringify(deliverable))
          .sadd(this.gigKey(dto.gigId), id)
          .exec();
        return deliverable;
      } catch (err) {
        this.logger.error('Redis unavailable for deliverable upload, using in-memory', err);
      }
    }

    this.deliverables.set(id, deliverable);
    return deliverable;
  }

  /**
   * @throws NotFoundException (404) when the gig does not exist
   * @throws ConflictException (409) when the gig has not been accepted (open, expired, cancelled)
   * @throws ForbiddenException (403) unless the gig's accepted freelancer is both the
   *   `freelancer` in the body and the authenticated requester
   */
  private async assertMayDeliver(dto: UploadDeliverableDto, requester: string): Promise<void> {
    const gig = await this.gigService.findById(dto.gigId);

    if (gig.status !== GigStatus.ACCEPTED) {
      throw new ConflictException(
        `Gig ${gig.id} is "${gig.status}"; deliverables can only be uploaded for accepted gigs`,
      );
    }
    if (gig.acceptedBy !== dto.freelancer) {
      throw new ForbiddenException('freelancer must be the freelancer who accepted the gig');
    }
    if (gig.acceptedBy !== requester) {
      throw new ForbiddenException(
        'Only the freelancer who accepted the gig can upload its deliverables',
      );
    }
  }

  async findById(id: string): Promise<Deliverable> {
    const d = await this.tryFindById(id);
    if (!d) throw new NotFoundException(`Deliverable ${id} not found`);
    return d;
  }

  async findByGig(gigId: string): Promise<Deliverable[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(this.gigKey(gigId));
        return await this.fetchMany(ids);
      } catch (err) {
        this.logger.error('Redis unavailable for deliverable.findByGig', err);
      }
    }
    return [...this.deliverables.values()].filter(d => d.gigId === gigId);
  }

  private async tryFindById(id: string): Promise<Deliverable | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.deliverableKey(id));
        return raw ? (JSON.parse(raw) as Deliverable) : undefined;
      } catch {
        // fall through
      }
    }
    return this.deliverables.get(id);
  }

  private async fetchMany(ids: string[]): Promise<Deliverable[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.deliverableKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Deliverable);
  }

  private deliverableKey(id: string): string {
    return `${DELIVERABLE_KEY_PREFIX}${id}`;
  }

  private gigKey(gigId: string): string {
    return `${DELIVERABLES_BY_GIG_PREFIX}${gigId}`;
  }
}
