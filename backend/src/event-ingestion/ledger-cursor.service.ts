import { Injectable, Logger } from '@nestjs/common';

export interface LedgerCheckpoint {
  ledgerSequence: number;
  lastProcessedLedger: number;
  cursorPosition: string;
  updatedAt: Date;
  networkHash: string;
}

@Injectable()
export class LedgerCursorService {
  private readonly logger = new Logger(LedgerCursorService.name);
  private checkpoints: Map<string, LedgerCheckpoint> = new Map();
  private readonly CURSOR_KEY_PREFIX = 'ledger_cursor:';

  async getCursor(contractId: string): Promise<LedgerCheckpoint | undefined> {
    return this.checkpoints.get(`${this.CURSOR_KEY_PREFIX}${contractId}`);
  }

  async updateCursor(
    contractId: string,
    ledgerSequence: number,
    cursorPosition: string,
    networkHash: string,
  ): Promise<void> {
    const checkpoint: LedgerCheckpoint = {
      ledgerSequence,
      lastProcessedLedger: ledgerSequence,
      cursorPosition,
      updatedAt: new Date(),
      networkHash,
    };

    this.checkpoints.set(`${this.CURSOR_KEY_PREFIX}${contractId}`, checkpoint);
    this.logger.log(`Cursor updated for contract ${contractId}: ledger ${ledgerSequence}`);
  }

  async resetCursor(contractId: string): Promise<void> {
    this.checkpoints.delete(`${this.CURSOR_KEY_PREFIX}${contractId}`);
    this.logger.log(`Cursor reset for contract ${contractId}`);
  }

  async getStartLedger(contractId: string): Promise<number> {
    const checkpoint = await this.getCursor(contractId);
    return checkpoint ? checkpoint.lastProcessedLedger + 1 : 0;
  }
}
