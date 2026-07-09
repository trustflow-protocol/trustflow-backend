import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { GigListing, GigStatus } from './gig.entity';
import { CreateGigDto, GigFilters, UpdateGigDto } from './gig.dto';

@Injectable()
export class GigService {
  private readonly gigs: Map<string, GigListing> = new Map();

  async create(dto: CreateGigDto): Promise<GigListing> {
    const now = new Date().toISOString();
    const gig: GigListing = {
      id: randomUUID(),
      clientAddress: dto.clientAddress,
      title: dto.title,
      description: dto.description,
      budgetXLM: dto.budgetXLM,
      category: dto.category,
      skills: dto.skills ?? [],
      status: GigStatus.OPEN,
      deadline: dto.deadline,
      createdAt: now,
      updatedAt: now,
    };

    this.gigs.set(gig.id, gig);
    return gig;
  }

  async findAll(filters: GigFilters = {}): Promise<GigListing[]> {
    return Array.from(this.gigs.values()).filter(gig => {
      if (filters.clientAddress && gig.clientAddress !== filters.clientAddress) return false;
      if (filters.status && gig.status !== filters.status) return false;
      if (filters.category && gig.category?.toLowerCase() !== filters.category.toLowerCase()) {
        return false;
      }
      if (
        filters.skill &&
        !gig.skills.some(skill => skill.toLowerCase() === filters.skill?.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }

  async findById(id: string): Promise<GigListing> {
    const gig = this.gigs.get(id);
    if (!gig) {
      throw new NotFoundException('Gig listing not found');
    }
    return gig;
  }

  async update(id: string, dto: UpdateGigDto): Promise<GigListing> {
    const gig = await this.findById(id);

    if (
      gig.status === GigStatus.CLOSED &&
      dto.status !== undefined &&
      dto.status !== GigStatus.CLOSED
    ) {
      throw new BadRequestException('Closed gig listings cannot be reopened');
    }

    const nextStatus = dto.status ?? gig.status;
    const now = new Date().toISOString();
    const updated: GigListing = {
      ...gig,
      ...dto,
      skills: dto.skills ?? gig.skills,
      status: nextStatus,
      updatedAt: now,
      closedAt: nextStatus === GigStatus.CLOSED ? (gig.closedAt ?? now) : gig.closedAt,
    };

    this.gigs.set(id, updated);
    return updated;
  }

  async close(id: string): Promise<GigListing> {
    return this.update(id, { status: GigStatus.CLOSED });
  }

  async delete(id: string): Promise<void> {
    await this.findById(id);
    this.gigs.delete(id);
  }

  clear(): void {
    this.gigs.clear();
  }
}
