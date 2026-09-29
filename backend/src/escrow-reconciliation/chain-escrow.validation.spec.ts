import { InvalidChainStateError, parseChainEscrow } from './chain-escrow.validation';

const valid = {
  depositor: `G${'A'.repeat(55)}`,
  beneficiary: `G${'B'.repeat(55)}`,
  amount: '250',
  status: 'released',
};

describe('parseChainEscrow', () => {
  it('maps a valid value', () => {
    expect(parseChainEscrow('e1', valid)).toEqual({
      contractEscrowId: 'e1',
      depositor: `G${'A'.repeat(55)}`,
      beneficiary: `G${'B'.repeat(55)}`,
      amountXLM: '250',
      status: 'released',
    });
  });

  it('maps capitalised and one-element-array enum encodings, and bigint amounts', () => {
    expect(parseChainEscrow('e1', { ...valid, status: 'Active' }).status).toBe('active');
    expect(parseChainEscrow('e1', { ...valid, status: ['Disputed'], amount: 5n })).toMatchObject({
      status: 'disputed',
      amountXLM: '5',
    });
  });

  it.each([[7], ['bogus'], [['a', 'b']], [undefined], [null]])(
    'rejects unknown status %p',
    status => {
      expect(() => parseChainEscrow('e1', { ...valid, status })).toThrow(InvalidChainStateError);
    },
  );

  it.each(['depositor', 'beneficiary', 'amount', 'status'])('rejects missing %s', field => {
    expect(() => parseChainEscrow('e1', { ...valid, [field]: undefined })).toThrow(
      InvalidChainStateError,
    );
  });

  it('rejects a non-decimal amount', () => {
    expect(() => parseChainEscrow('e1', { ...valid, amount: '12abc' })).toThrow(
      InvalidChainStateError,
    );
  });

  it.each([null, undefined, 'str', 42, ['x']])('rejects non-object value %p', v => {
    expect(() => parseChainEscrow('e1', v)).toThrow(InvalidChainStateError);
  });
});
