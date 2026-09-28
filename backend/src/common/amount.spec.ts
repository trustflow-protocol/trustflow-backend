import {
  parseAmount,
  validateAmount,
  normalizeAmount,
  compareAmounts,
  sumAmounts,
  stroopsToXLM,
  xlmToStroops,
  amountsEqual,
  amountLessThan,
  amountLessThanOrEqual,
  amountGreaterThan,
  amountGreaterThanOrEqual,
  STROOPS_PER_XLM,
} from './amount';

describe('Amount Utilities', () => {
  describe('parseAmount', () => {
    it('parses valid decimal strings', () => {
      expect(parseAmount('10').toFixed()).toBe('10');
      expect(parseAmount('10.5').toFixed()).toBe('10.5');
      expect(parseAmount('0.0000001').toFixed()).toBe('0.0000001');
    });

    it('throws on non-string input', () => {
      expect(() => parseAmount(10 as any)).toThrow('Amount must be a string');
      expect(() => parseAmount(null as any)).toThrow('Amount must be a string');
    });

    it('throws on NaN', () => {
      expect(() => parseAmount('abc')).toThrow('is not a valid number');
      expect(() => parseAmount('10.10.10')).toThrow('is not a valid number');
    });
  });

  describe('validateAmount', () => {
    it('validates positive amounts', () => {
      expect(validateAmount('10')).toBe('10');
      expect(validateAmount('0')).toBe('0');
      expect(validateAmount('10.5')).toBe('10.5');
    });

    it('rejects negative amounts', () => {
      expect(() => validateAmount('-10')).toThrow('must be non-negative');
    });

    it('rounds down amounts with >7 decimal places', () => {
      const result = validateAmount('10.12345678');
      expect(result).toBe('10.1234567');
    });

    it('throws on invalid input', () => {
      expect(() => validateAmount('abc')).toThrow();
      expect(() => validateAmount('NaN')).toThrow();
    });
  });

  describe('normalizeAmount', () => {
    it('normalizes amounts to their decimal representation', () => {
      expect(normalizeAmount('10')).toBe('10');
      expect(normalizeAmount('10.0')).toBe('10');
      expect(normalizeAmount('10.5000')).toBe('10.5');
    });

    it('rounds down amounts with >7 decimal places', () => {
      expect(normalizeAmount('10.12345678')).toBe('10.1234567');
      expect(normalizeAmount('0.99999999')).toBe('0.9999999');
    });

    it('handles very large numbers', () => {
      const result = normalizeAmount('99999999999.9999999');
      expect(result).toBe('99999999999.9999999');
    });
  });

  describe('compareAmounts', () => {
    it('returns -1 when a < b', () => {
      expect(compareAmounts('10', '20')).toBe(-1);
      expect(compareAmounts('10.1', '10.2')).toBe(-1);
    });

    it('returns 0 when a == b', () => {
      expect(compareAmounts('10', '10')).toBe(0);
      expect(compareAmounts('10.0', '10')).toBe(0);
      expect(compareAmounts('10.5000', '10.5')).toBe(0);
    });

    it('returns 1 when a > b', () => {
      expect(compareAmounts('20', '10')).toBe(1);
      expect(compareAmounts('10.2', '10.1')).toBe(1);
    });
  });

  describe('sumAmounts', () => {
    it('sums multiple amounts', () => {
      expect(sumAmounts(['10', '20', '30'])).toBe('60');
      expect(sumAmounts(['0.1', '0.2'])).toBe('0.3');
    });

    it('handles empty array', () => {
      expect(sumAmounts([])).toBe('0');
    });

    it('normalizes the result', () => {
      const result = sumAmounts(['10.1', '20.2', '30.3']);
      expect(result).toBe('60.6');
    });

    it('handles 0.1 + 0.2 precision edge case', () => {
      const result = sumAmounts(['0.1', '0.2']);
      expect(result).toBe('0.3');
    });

    it('sums with 7 decimal place precision', () => {
      const result = sumAmounts(['10.0000001', '10.0000002', '10.0000003']);
      expect(result).toBe('30.0000006');
    });
  });

  describe('stroopsToXLM', () => {
    it('converts stroops to XLM', () => {
      expect(stroopsToXLM(10_000_000)).toBe('1');
      expect(stroopsToXLM(1_000_000)).toBe('0.1');
      expect(stroopsToXLM(1)).toBe('0.0000001');
    });

    it('handles bigint stroops', () => {
      expect(stroopsToXLM(BigInt(10_000_000))).toBe('1');
      expect(stroopsToXLM(BigInt(1))).toBe('0.0000001');
    });

    it('handles string stroops', () => {
      expect(stroopsToXLM('10000000')).toBe('1');
      expect(stroopsToXLM('1')).toBe('0.0000001');
    });

    it('rounds down partial stroops', () => {
      expect(stroopsToXLM(1.5)).toBe('0.00000001');
    });
  });

  describe('xlmToStroops', () => {
    it('converts XLM to stroops', () => {
      expect(xlmToStroops('1')).toBe(BigInt(10_000_000));
      expect(xlmToStroops('0.1')).toBe(BigInt(1_000_000));
      expect(xlmToStroops('0.0000001')).toBe(BigInt(1));
    });

    it('rounds down partial stroops', () => {
      expect(xlmToStroops('0.00000001')).toBe(BigInt(1));
      expect(xlmToStroops('1.0000001')).toBe(BigInt(10_000_001));
    });

    it('handles edge case: 0.1 + 0.2', () => {
      const sum = sumAmounts(['0.1', '0.2']);
      const stroops = xlmToStroops(sum);
      expect(stroops).toBe(BigInt(3_000_000));
    });

    it('throws on invalid input', () => {
      expect(() => xlmToStroops('abc')).toThrow();
    });
  });

  describe('amountsEqual', () => {
    it('returns true for equal amounts', () => {
      expect(amountsEqual('10', '10')).toBe(true);
      expect(amountsEqual('10.0', '10')).toBe(true);
      expect(amountsEqual('10.5000', '10.5')).toBe(true);
    });

    it('returns false for unequal amounts', () => {
      expect(amountsEqual('10', '10.1')).toBe(false);
      expect(amountsEqual('10', '20')).toBe(false);
    });
  });

  describe('amountLessThan', () => {
    it('returns true when a < b', () => {
      expect(amountLessThan('10', '20')).toBe(true);
      expect(amountLessThan('10.1', '10.2')).toBe(true);
    });

    it('returns false when a >= b', () => {
      expect(amountLessThan('10', '10')).toBe(false);
      expect(amountLessThan('20', '10')).toBe(false);
    });
  });

  describe('amountLessThanOrEqual', () => {
    it('returns true when a <= b', () => {
      expect(amountLessThanOrEqual('10', '20')).toBe(true);
      expect(amountLessThanOrEqual('10', '10')).toBe(true);
      expect(amountLessThanOrEqual('10.0', '10')).toBe(true);
    });

    it('returns false when a > b', () => {
      expect(amountLessThanOrEqual('20', '10')).toBe(false);
    });
  });

  describe('amountGreaterThan', () => {
    it('returns true when a > b', () => {
      expect(amountGreaterThan('20', '10')).toBe(true);
      expect(amountGreaterThan('10.2', '10.1')).toBe(true);
    });

    it('returns false when a <= b', () => {
      expect(amountGreaterThan('10', '10')).toBe(false);
      expect(amountGreaterThan('10', '20')).toBe(false);
    });
  });

  describe('amountGreaterThanOrEqual', () => {
    it('returns true when a >= b', () => {
      expect(amountGreaterThanOrEqual('20', '10')).toBe(true);
      expect(amountGreaterThanOrEqual('10', '10')).toBe(true);
      expect(amountGreaterThanOrEqual('10', '10.0')).toBe(true);
    });

    it('returns false when a < b', () => {
      expect(amountGreaterThanOrEqual('10', '20')).toBe(false);
    });
  });

  describe('Precision edge cases', () => {
    it('handles very large amounts', () => {
      const large = '99999999999999999.9999999';
      expect(normalizeAmount(large)).toBe(large);
    });

    it('handles very small amounts', () => {
      const small = '0.0000001';
      expect(normalizeAmount(small)).toBe(small);
    });

    it('handles zero', () => {
      expect(normalizeAmount('0')).toBe('0');
      expect(normalizeAmount('0.0')).toBe('0');
    });

    it('round-trip conversion stroops <-> XLM', () => {
      const xlm = '123.4567890';
      const stroops = xlmToStroops(xlm);
      const back = stroopsToXLM(stroops);
      expect(back).toBe('123.456789');
    });
  });
});
