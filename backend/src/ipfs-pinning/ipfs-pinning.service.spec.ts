import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { IpfsPinningService } from './ipfs-pinning.service';
import { computeCidV1Raw } from './cid.util';
import { IPFS_EVENTS, PinStatus, ProviderPinStatus } from './ipfs-pinning.types';
import { IpfsPinProvider, PinProviderName } from './providers/ipfs-provider.interface';

function makeProvider(name: PinProviderName): jest.Mocked<IpfsPinProvider> {
  return {
    name,
    isConfigured: false,
    pin: jest.fn().mockResolvedValue(undefined),
    unpin: jest.fn().mockResolvedValue(undefined),
    verify: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<IpfsPinProvider>;
}

describe('IpfsPinningService', () => {
  let pinata: jest.Mocked<IpfsPinProvider>;
  let web3Storage: jest.Mocked<IpfsPinProvider>;
  let infura: jest.Mocked<IpfsPinProvider>;
  let webhookService: { dispatch: jest.Mock };
  let service: IpfsPinningService;

  const CONTENT = Buffer.from('trustflow deliverable payload').toString('base64');
  const CID = computeCidV1Raw(Buffer.from('trustflow deliverable payload'));

  beforeEach(() => {
    pinata = makeProvider(PinProviderName.PINATA);
    web3Storage = makeProvider(PinProviderName.WEB3_STORAGE);
    infura = makeProvider(PinProviderName.INFURA);
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new IpfsPinningService([pinata, web3Storage, infura], webhookService as any);
  });

  it('throws on construction with no providers', () => {
    expect(() => new IpfsPinningService([], webhookService as any)).toThrow();
  });

  describe('pinContent', () => {
    it('pins to the first `replicationFactor` providers and reports HEALTHY', async () => {
      const record = await service.pinContent({ content: CONTENT });

      expect(record.cid).toBe(CID);
      expect(record.status).toBe(PinStatus.HEALTHY);
      expect(record.replicationFactor).toBe(2);
      expect(pinata.pin).toHaveBeenCalledWith(CID, Buffer.from(CONTENT, 'base64'));
      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).not.toHaveBeenCalled();
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_CREATED,
        expect.objectContaining({ cid: CID }),
      );
    });

    it('rejects when expectedCid does not match the computed content hash', async () => {
      await expect(
        service.pinContent({ content: CONTENT, expectedCid: 'bafkreiwrong' }),
      ).rejects.toThrow(BadRequestException);
      expect(pinata.pin).not.toHaveBeenCalled();
    });

    it('accepts when expectedCid matches the computed content hash', async () => {
      const record = await service.pinContent({ content: CONTENT, expectedCid: CID });
      expect(record.cid).toBe(CID);
    });

    it('fails over to the next provider when one fails to pin', async () => {
      pinata.pin.mockRejectedValue(new Error('pinata unreachable'));

      const record = await service.pinContent({ content: CONTENT });

      expect(record.status).toBe(PinStatus.HEALTHY);
      const pinataEntry = record.providers.find(p => p.provider === PinProviderName.PINATA);
      expect(pinataEntry?.status).toBe(ProviderPinStatus.FAILED);
      expect(pinataEntry?.lastError).toContain('pinata unreachable');

      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).toHaveBeenCalled();
    });

    it('fails over when a provider pins but verification does not confirm it', async () => {
      pinata.verify.mockResolvedValueOnce(false);

      const record = await service.pinContent({ content: CONTENT });

      const pinataEntry = record.providers.find(p => p.provider === PinProviderName.PINATA);
      expect(pinataEntry?.status).toBe(ProviderPinStatus.FAILED);
      expect(record.status).toBe(PinStatus.HEALTHY);
    });

    it('reports DEGRADED when fewer than replicationFactor providers succeed', async () => {
      web3Storage.pin.mockRejectedValue(new Error('web3.storage down'));
      infura.pin.mockRejectedValue(new Error('infura down'));

      const record = await service.pinContent({ content: CONTENT });

      expect(record.status).toBe(PinStatus.DEGRADED);
      expect(record.providers.filter(p => p.status === ProviderPinStatus.PINNED)).toHaveLength(1);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_DEGRADED,
        expect.objectContaining({ cid: CID, healthyProviders: 1 }),
      );
    });

    it('throws ServiceUnavailableException and dispatches PIN_FAILED when every provider fails', async () => {
      pinata.pin.mockRejectedValue(new Error('down'));
      web3Storage.pin.mockRejectedValue(new Error('down'));
      infura.pin.mockRejectedValue(new Error('down'));

      await expect(service.pinContent({ content: CONTENT })).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_FAILED,
        expect.objectContaining({ cid: CID }),
      );
    });

    it('clamps replicationFactor to the number of registered providers', async () => {
      const record = await service.pinContent({ content: CONTENT, replicationFactor: 10 });
      expect(record.replicationFactor).toBe(3);
      expect(pinata.pin).toHaveBeenCalled();
      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).toHaveBeenCalled();
    });
  });

  describe('reconcile', () => {
    it('detects a lost pin, dispatches PIN_LOST, and tops up via a spare provider', async () => {
      await service.pinContent({ content: CONTENT }); // pinned to pinata + web3Storage

      pinata.verify.mockResolvedValue(false); // pinata silently lost the pin
      const record = await service.reconcile(CID);

      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_LOST,
        expect.objectContaining({ cid: CID, provider: PinProviderName.PINATA }),
      );
      expect(infura.pin).toHaveBeenCalledWith(CID, expect.any(Buffer));
      expect(record.status).toBe(PinStatus.HEALTHY);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_RESTORED,
        expect.objectContaining({ cid: CID }),
      );
    });

    it('leaves a fully healthy pin untouched', async () => {
      await service.pinContent({ content: CONTENT });
      jest.clearAllMocks();

      const record = await service.reconcile(CID);

      expect(infura.pin).not.toHaveBeenCalled();
      expect(record.status).toBe(PinStatus.HEALTHY);
    });

    it('throws NotFoundException for an unknown CID', async () => {
      await expect(service.reconcile('bafkreiunknown')).rejects.toThrow();
    });
  });

  describe('unpin', () => {
    it('unpins from every provider currently holding the pin', async () => {
      await service.pinContent({ content: CONTENT });

      const record = await service.unpin(CID);

      expect(pinata.unpin).toHaveBeenCalledWith(CID);
      expect(web3Storage.unpin).toHaveBeenCalledWith(CID);
      expect(infura.unpin).not.toHaveBeenCalled();
      expect(record.status).toBe(PinStatus.UNPINNED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_REMOVED,
        expect.objectContaining({ cid: CID }),
      );
    });
  });

  describe('findAll / findByCid', () => {
    it('lists and retrieves pin records', async () => {
      await service.pinContent({ content: CONTENT });

      expect(await service.findAll()).toHaveLength(1);
      expect((await service.findByCid(CID)).cid).toBe(CID);
      await expect(service.findByCid('bafkreiunknown')).rejects.toThrow();
    });
  });
});
