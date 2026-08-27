import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
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
  ) {}

  async upload(dto: UploadDeliverableDto): Promise<Deliverable> {
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
