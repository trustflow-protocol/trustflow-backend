import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GigStatus } from './gig.entity';
import { GigService } from './gig.service';

const clientAddress = `G${'A'.repeat(55)}`;

describe('GigService', () => {
  let service: GigService;

  beforeEach(() => {
    service = new GigService();
  });

  const createGig = () =>
    service.create({
      clientAddress,
      title: 'Build a Soroban escrow dashboard',
      description: 'Create a dashboard for tracking escrow milestones and gig delivery state.',
      budgetXLM: '250.0000000',
      category: 'development',
      skills: ['NestJS', 'Soroban'],
    });

  it('creates an open gig listing', async () => {
    const gig = await createGig();

    expect(gig.id).toBeDefined();
    expect(gig.clientAddress).toBe(clientAddress);
    expect(gig.status).toBe(GigStatus.OPEN);
    expect(gig.createdAt).toBeDefined();
    expect(gig.updatedAt).toBeDefined();
  });

  it('lists and filters gig listings', async () => {
    const first = await createGig();
    await service.create({
      clientAddress: `G${'B'.repeat(55)}`,
      title: 'Design milestone review flow',
      description: 'Design and document a milestone approval flow for client reviews.',
      budgetXLM: '125',
      category: 'design',
      skills: ['Figma'],
    });

    await service.close(first.id);

    await expect(service.findAll()).resolves.toHaveLength(2);
    await expect(service.findAll({ clientAddress })).resolves.toHaveLength(1);
    await expect(service.findAll({ status: GigStatus.CLOSED })).resolves.toHaveLength(1);
    await expect(service.findAll({ category: 'DEVELOPMENT' })).resolves.toHaveLength(1);
    await expect(service.findAll({ skill: 'soroban' })).resolves.toHaveLength(1);
  });

  it('updates mutable fields and closes listings', async () => {
    const gig = await createGig();

    const updated = await service.update(gig.id, {
      title: 'Build an escrow analytics dashboard',
      skills: ['NestJS', 'Analytics'],
    });

    expect(updated.title).toBe('Build an escrow analytics dashboard');
    expect(updated.skills).toEqual(['NestJS', 'Analytics']);

    const closed = await service.close(gig.id);
    expect(closed.status).toBe(GigStatus.CLOSED);
    expect(closed.closedAt).toBeDefined();
  });

  it('does not reopen closed listings', async () => {
    const gig = await createGig();
    await service.close(gig.id);

    await expect(service.update(gig.id, { status: GigStatus.OPEN })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('deletes listings and reports missing records', async () => {
    const gig = await createGig();
    await service.delete(gig.id);

    await expect(service.findById(gig.id)).rejects.toThrow(NotFoundException);
    await expect(service.delete('missing-id')).rejects.toThrow(NotFoundException);
  });
});
