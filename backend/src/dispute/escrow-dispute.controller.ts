import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { EscrowService } from '../escrow/escrow.service';
import { RaiseDisputeDto, RaiseDisputeSchema } from '../escrow/escrow.dto';
import { DisputeSagaService } from './dispute-saga.service';
import { EscalateDisputeDto } from './dispute.dto';

interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

/**
 * `POST /escrows/:id/dispute` — kept at its original path and response shape,
 * but now an alias for `DisputeSagaService.escalate()` (#633): the saga is the
 * single off-chain entry point, so this route no longer freezes the escrow or
 * sends notifications itself (#636).
 *
 * It lives in DisputeModule rather than EscrowController because DisputeModule
 * already depends on EscrowModule; the reverse import would be a module cycle.
 */
@ApiTags('Escrow')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('escrows')
export class EscrowDisputeController {
  constructor(
    private readonly sagaService: DisputeSagaService,
    private readonly escrowService: EscrowService,
  ) {}

  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Raise a dispute',
    description:
      'Raises a dispute for an active escrow by opening a dispute saga (same as ' +
      '`POST /dispute/escrow/:escrowId/escalate`). The authenticated wallet must be the ' +
      "escrow's depositor or beneficiary; it is recorded as the initiator. Sends one " +
      '`dispute.raised` webhook, one Discord message and one in-app notification.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiBody({
    description: 'Dispute details',
    schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Reason for the dispute',
          example: 'Work not delivered as specified',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Dispute raised; the escrow is now disputed and a saga has been opened.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', example: 'disputed' },
        disputeReason: { type: 'string' },
        disputedAt: { type: 'string', format: 'date-time' },
        sagaId: { type: 'string', example: 'saga-1234567890-abc' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Escrow is not active' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Caller is not the depositor or beneficiary' })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  @ApiResponse({ status: 409, description: 'Escrow already has an active dispute' })
  async raiseDispute(
    @Param('id') id: string,
    @Body() dto: RaiseDisputeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const { reason } = RaiseDisputeSchema.parse(dto ?? {});
    const escalateDto: EscalateDisputeDto = {
      initiator: req.user.address,
      reason: reason ?? 'No reason provided',
    };
    const saga = await this.sagaService.escalate(id, escalateDto);
    const escrow = await this.escrowService.findById(id);
    return { ...escrow, sagaId: saga.sagaId };
  }
}
