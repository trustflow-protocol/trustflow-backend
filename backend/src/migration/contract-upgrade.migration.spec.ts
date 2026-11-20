import { ContractUpgradeMigration } from './contract-upgrade.migration';
import { findDestructiveStatements } from './destructive-sql.util';

describe('ContractUpgradeMigration', () => {
  const migration = new ContractUpgradeMigration({
    name: 'escrow-contract-v2-upgrade',
    oldContractAddress: 'CAAAAOLD',
    newContractAddress: 'CBBBBNEW',
    targetTable: 'escrows',
    addressColumn: 'contract_address',
  });

  it('declares the DROP COLUMN its contract phase performs, so the runner can gate it (#971)', () => {
    const planned = migration.plannedContractSql();
    expect(planned).toEqual([
      'ALTER TABLE escrows DROP COLUMN IF EXISTS contract_address',
      'ALTER TABLE escrows RENAME COLUMN contract_address_new TO contract_address',
    ]);
    expect(findDestructiveStatements(planned)).toHaveLength(1);
  });
});
