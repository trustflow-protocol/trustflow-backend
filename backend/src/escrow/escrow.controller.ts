import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { WebhookEvent } from '../webhook/webhook.dto';

interface CreateEscrowDto { depositor: string; beneficiary: string; amountXLM: string; }
interface RaiseDisputeDto { reason?: string; }

@Controller('escrows')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly webhookService: WebhookService,
    private readonly discordService: DiscordService,
  ) {}

  @Post()
  create(@Body() dto: CreateEscrowDto) {
    return this.escrowService.create(dto.depositor, dto.beneficiary, dto.amountXLM);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.escrowService.findById(id);
  }

  @Get('depositor/:address')
  findByDepositor(@Param('address') address: string) {
    return this.escrowService.findByDepositor(address);
  }

  @Post(':id/release')
  release(@Param('id') id: string) {
    return this.escrowService.release(id);
  }

  @Post(':id/dispute')
  async raiseDispute(@Param('id') id: string, @Body() dto: RaiseDisputeDto) {
    const escrow = await this.escrowService.raiseDispute(id, dto.reason);

    // Dispatch webhook event
    await this.webhookService.dispatch(WebhookEvent.DisputeRaised, {
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
      disputedAt: escrow.disputedAt,
    });

    // Send Discord notification
    await this.discordService.notifyDisputeNeedsJurors({
      escrowId: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      amountXLM: escrow.amountXLM,
      reason: escrow.disputeReason,
    });

    return escrow;
  }
}
