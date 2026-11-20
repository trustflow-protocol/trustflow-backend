import { validateEnv } from '../config/env.config';

// refresh() reads config.SOROBAN_PROTOCOL_MIN_VERSION/MAX_VERSION, which requires validateEnv()
// to have run first — normally done once in main.ts.
validateEnv();

import * as stellarConfig from '../stellar/stellar.config';

jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...original,
    rpc: {
      ...original.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: jest.fn(),
      })),
    },
  };
});

import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { StellarProtocolCompatibilityService } from './stellar-protocol-compatibility.service';

describe('StellarProtocolCompatibilityService (#980)', () => {
  let service: StellarProtocolCompatibilityService;
  let getNetworkMock: jest.Mock;

  beforeEach(() => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({
      sorobanRpcUrl: 'http://localhost:8000',
    } as any);

    // `refresh()` builds a fresh Soroban server on every call, so the mock constructor must
    // keep returning the *same* `getNetworkMock` reference rather than a new one each time —
    // otherwise a test configuring it before calling `refresh()` would be configuring a jest.fn
    // that the service never actually calls.
    getNetworkMock = jest.fn();
    (SorobanRpc.Server as unknown as jest.Mock).mockImplementation(() => ({
      getNetwork: getNetworkMock,
    }));

    service = new StellarProtocolCompatibilityService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports compatible before any check has run', () => {
    const status = service.getStatus();
    expect(status.checked).toBe(false);
    expect(status.compatible).toBe(true);
    expect(status.protocolVersion).toBeNull();
  });

  it('reports compatible when the RPC protocol version is within the tested range', async () => {
    getNetworkMock.mockResolvedValue({
      protocolVersion: '21',
      passphrase: 'Test SDF Network ; September 2015',
    });

    const status = await service.refresh();

    expect(status.checked).toBe(true);
    expect(status.compatible).toBe(true);
    expect(status.protocolVersion).toBe(21);
  });

  it('reports incompatible when the RPC protocol version is above the tested range', async () => {
    getNetworkMock.mockResolvedValue({
      protocolVersion: '99',
      passphrase: 'Test SDF Network ; September 2015',
    });

    const status = await service.refresh();

    expect(status.checked).toBe(true);
    expect(status.compatible).toBe(false);
    expect(status.protocolVersion).toBe(99);
  });

  it('reports incompatible when the RPC protocol version is below the tested range', async () => {
    getNetworkMock.mockResolvedValue({
      protocolVersion: '1',
      passphrase: 'Test SDF Network ; September 2015',
    });

    const status = await service.refresh();

    expect(status.compatible).toBe(false);
    expect(status.protocolVersion).toBe(1);
  });

  it('reports compatible (not checked) when the RPC is unreachable, deferring to the stellar health check', async () => {
    getNetworkMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const status = await service.refresh();

    expect(status.checked).toBe(false);
    expect(status.compatible).toBe(true);
    expect(status.error).toContain('ECONNREFUSED');
  });

  it('reports compatible (not checked) when no Soroban RPC URL is configured', async () => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({ sorobanRpcUrl: '' } as any);

    const status = await service.refresh();

    expect(status.checked).toBe(false);
    expect(status.compatible).toBe(true);
  });

  it('onModuleInit populates the cached status so getStatus() reflects it without another refresh', async () => {
    getNetworkMock.mockResolvedValue({ protocolVersion: '21' });

    await service.onModuleInit();

    expect(service.getStatus().checked).toBe(true);
    expect(service.getStatus().protocolVersion).toBe(21);
  });
});
