import { Injectable, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { config } from '../config/env.config';
import { getStellarConfig } from '../stellar/stellar.config';
import { buildSorobanServer } from '../stellar/soroban.helper';

export interface ProtocolCompatibilityStatus {
  /** Whether the RPC's protocol version was successfully read at least once. */
  checked: boolean;
  compatible: boolean;
  protocolVersion: number | null;
  minSupported: number;
  maxSupported: number;
  error?: string;
}

/**
 * Checks the configured Soroban RPC node's reported protocol version against the range this
 * backend was built/tested against, at startup (#980).
 *
 * The RPC/Horizon client is otherwise configured with just a base URL: nothing stops a
 * provider-side upgrade to a new protocol version from silently changing response shapes the
 * backend doesn't expect. Querying `getNetwork()` once at boot and comparing against
 * `SOROBAN_PROTOCOL_MIN_VERSION`/`SOROBAN_PROTOCOL_MAX_VERSION` turns that into a loud warning
 * (and a failing health check) instead of a mis-parsed response discovered much later.
 *
 * An unreachable RPC or unconfigured endpoint is treated as compatible (true) here — that
 * failure mode is already surfaced by `HealthService#checkStellar`; this check only ever reports
 * incompatibility for a version it actually read and found out of range.
 */
@Injectable()
export class StellarProtocolCompatibilityService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(StellarProtocolCompatibilityService.name);
  private lastStatus: ProtocolCompatibilityStatus = {
    checked: false,
    compatible: true,
    protocolVersion: null,
    minSupported: config.SOROBAN_PROTOCOL_MIN_VERSION,
    maxSupported: config.SOROBAN_PROTOCOL_MAX_VERSION,
  };

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  getStatus(): ProtocolCompatibilityStatus {
    return this.lastStatus;
  }

  async refresh(): Promise<ProtocolCompatibilityStatus> {
    const minSupported = config.SOROBAN_PROTOCOL_MIN_VERSION;
    const maxSupported = config.SOROBAN_PROTOCOL_MAX_VERSION;

    const rpcUrl = getStellarConfig().sorobanRpcUrl;
    if (!rpcUrl) {
      this.lastStatus = {
        checked: false,
        compatible: true,
        protocolVersion: null,
        minSupported,
        maxSupported,
      };
      return this.lastStatus;
    }

    try {
      const server = buildSorobanServer(rpcUrl);
      const { protocolVersion: rawVersion } = await server.getNetwork();
      const protocolVersion = Number.parseInt(rawVersion, 10);
      const compatible =
        Number.isFinite(protocolVersion) &&
        protocolVersion >= minSupported &&
        protocolVersion <= maxSupported;

      this.lastStatus = { checked: true, compatible, protocolVersion, minSupported, maxSupported };

      if (!compatible) {
        this.logger.warn(
          `Soroban RPC reports protocol version "${rawVersion}", outside the tested range ` +
            `[${minSupported}, ${maxSupported}]. Response shapes may have changed since this ` +
            'backend was built against that range — verify compatibility before relying on it.',
        );
      }
    } catch (error) {
      this.lastStatus = {
        checked: false,
        compatible: true,
        protocolVersion: null,
        minSupported,
        maxSupported,
        error: error instanceof Error ? error.message : String(error),
      };
      this.logger.warn(
        `Could not determine Soroban RPC protocol version: ${this.lastStatus.error}`,
      );
    }

    return this.lastStatus;
  }
}
