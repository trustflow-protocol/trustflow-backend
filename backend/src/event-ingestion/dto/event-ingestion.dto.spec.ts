import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { StartPollingDto, IngestLedgerDto, HandleReorgDto } from './event-ingestion.dto';

// A well-formed Stellar contract ID: starts with 'C', 56 base-32 characters, valid checksum.
const VALID_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

// Invalid values that must be rejected by IsValidStellarContract.
const INVALID_IDS = [
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', // G-address (account, not contract)
  'not-a-stellar-id',
  '',
  'C',
  'CSHORT',
];

describe('IsValidStellarContract decorator', () => {
  // ── StartPollingDto ─────────────────────────────────────────────────────────

  describe('StartPollingDto', () => {
    it('passes when contractId is a valid contract ID', async () => {
      const dto = Object.assign(new StartPollingDto(), { contractId: VALID_CONTRACT_ID });
      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });

    it('passes when contractId is omitted (field is optional)', async () => {
      const dto = new StartPollingDto();
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it.each(INVALID_IDS)(
      'rejects contractId "%s" with an isValidStellarContract error',
      async badId => {
        const dto = Object.assign(new StartPollingDto(), { contractId: badId });
        const errors = await validate(dto);
        const contractErrors = errors.find(e => e.property === 'contractId');
        expect(contractErrors).toBeDefined();
        expect(Object.keys(contractErrors!.constraints ?? {})).toContain('isValidStellarContract');
      },
    );
  });

  // ── IngestLedgerDto ─────────────────────────────────────────────────────────

  describe('IngestLedgerDto', () => {
    it('passes when contractId is a valid contract ID', async () => {
      const dto = Object.assign(new IngestLedgerDto(), {
        contractId: VALID_CONTRACT_ID,
        ledger: 1,
      });
      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });

    it.each(INVALID_IDS)(
      'rejects contractId "%s" with an isValidStellarContract error',
      async badId => {
        const dto = Object.assign(new IngestLedgerDto(), { contractId: badId, ledger: 1 });
        const errors = await validate(dto);
        const contractErrors = errors.find(e => e.property === 'contractId');
        expect(contractErrors).toBeDefined();
        expect(Object.keys(contractErrors!.constraints ?? {})).toContain('isValidStellarContract');
      },
    );
  });

  // ── HandleReorgDto ──────────────────────────────────────────────────────────

  describe('HandleReorgDto', () => {
    it('passes when contractId is a valid contract ID', async () => {
      const dto = Object.assign(new HandleReorgDto(), {
        contractId: VALID_CONTRACT_ID,
        fromLedger: 1,
      });
      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });

    it.each(INVALID_IDS)(
      'rejects contractId "%s" with an isValidStellarContract error',
      async badId => {
        const dto = Object.assign(new HandleReorgDto(), { contractId: badId, fromLedger: 1 });
        const errors = await validate(dto);
        const contractErrors = errors.find(e => e.property === 'contractId');
        expect(contractErrors).toBeDefined();
        expect(Object.keys(contractErrors!.constraints ?? {})).toContain('isValidStellarContract');
      },
    );
  });

  // ── Casing normalization (#979) ─────────────────────────────────────────────
  //
  // NestJS's ValidationPipe runs with `transform: true`, which turns an incoming request body
  // into a class instance via `plainToInstance` before `validate()` runs — that's the path
  // where `@Transform` (and so `NormalizeContractId`) actually takes effect, unlike the plain
  // `Object.assign` + `validate()` used in the tests above.
  describe('contract ID casing normalization', () => {
    it('StartPollingDto: normalizes a lowercase-typed contractId so it passes validation', async () => {
      const dto = plainToInstance(StartPollingDto, { contractId: VALID_CONTRACT_ID.toLowerCase() });
      expect(dto.contractId).toBe(VALID_CONTRACT_ID);

      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });

    it('IngestLedgerDto: normalizes a lowercase-typed contractId so it passes validation', async () => {
      const dto = plainToInstance(IngestLedgerDto, {
        contractId: VALID_CONTRACT_ID.toLowerCase(),
        ledger: 1,
      });
      expect(dto.contractId).toBe(VALID_CONTRACT_ID);

      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });

    it('HandleReorgDto: normalizes a lowercase-typed contractId so it passes validation', async () => {
      const dto = plainToInstance(HandleReorgDto, {
        contractId: VALID_CONTRACT_ID.toLowerCase(),
        fromLedger: 1,
      });
      expect(dto.contractId).toBe(VALID_CONTRACT_ID);

      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'contractId')).toHaveLength(0);
    });
  });
});
