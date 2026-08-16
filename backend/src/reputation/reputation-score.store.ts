import { Injectable } from '@nestjs/common';
import { ReputationScoreRecord } from './reputation.types';

@Injectable()
export class ReputationScoreStore {
  private readonly records: Map<string, ReputationScoreRecord> = new Map();

  get(address: string): ReputationScoreRecord | undefined {
    return this.records.get(address);
  }

  save(record: ReputationScoreRecord): void {
    this.records.set(record.address, record);
  }

  findAll(): ReputationScoreRecord[] {
    return [...this.records.values()];
  }
}
