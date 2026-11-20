import { StrKey } from '@stellar/stellar-sdk';
import { normalizeContractId } from './contract-id.util';

describe('normalizeContractId', () => {
  const canonical = StrKey.encodeContract(Buffer.alloc(32, 7));

  it('leaves an already-canonical contract ID unchanged', () => {
    expect(normalizeContractId(canonical)).toBe(canonical);
  });

  it('upper-cases a lowercase-typed contract ID to the canonical form', () => {
    expect(normalizeContractId(canonical.toLowerCase())).toBe(canonical);
  });

  it('normalizes a mixed-case contract ID to the canonical form', () => {
    const mixed = canonical
      .split('')
      .map((char, i) => (i % 2 === 0 ? char.toLowerCase() : char))
      .join('');
    expect(normalizeContractId(mixed)).toBe(canonical);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContractId(`  ${canonical}  `)).toBe(canonical);
  });

  it('returns the trimmed input unchanged when it is not a decodable contract ID', () => {
    expect(normalizeContractId('not-a-contract-id')).toBe('not-a-contract-id');
    expect(normalizeContractId('')).toBe('');
  });
});
