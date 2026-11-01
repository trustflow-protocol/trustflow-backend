import { CreateEscrowSchema } from './escrow.dto';

const DEPOSITOR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const BENEFICIARY = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBN72';

describe('CreateEscrowSchema', () => {
  it('accepts a positive XLM amount', () => {
    const parsed = CreateEscrowSchema.parse({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '12.5',
    });
    expect(parsed.amountXLM).toBe('12.5');
  });

  it.each(['0', '0.0', '0.0000000'])('rejects zero amount %s', amountXLM => {
    const result = CreateEscrowSchema.safeParse({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('greater than zero'))).toBe(true);
    }
  });

  it('rejects a negative amount string at the format check', () => {
    const result = CreateEscrowSchema.safeParse({
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: '-1',
    });
    expect(result.success).toBe(false);
  });
});
