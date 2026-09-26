import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IpfsPinningService } from './ipfs-pinning.service';
import { PinContentDto, PinRecordResponseDto } from './ipfs-pinning.dto';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('IPFS Pinning')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('ipfs/pins')
export class IpfsPinningController {
  constructor(private readonly pinningService: IpfsPinningService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pin a deliverable across multiple IPFS providers',
    description:
      'Computes the CIDv1 content hash of the supplied bytes and pins them to providers in priority ' +
      'order until `replicationFactor` providers succeed, automatically failing over to the next ' +
      'provider whenever one fails to pin or fails post-pin verification.',
  })
  @ApiResponse({ status: 201, type: PinRecordResponseDto })
  @ApiResponse({ status: 400, description: 'expectedCid does not match the computed content hash' })
  @ApiResponse({ status: 503, description: 'Every registered provider failed to pin the content' })
  pin(@Body() dto: PinContentDto) {
    return this.pinningService.pinContent(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all pin records' })
  @ApiResponse({ status: 200, type: [PinRecordResponseDto] })
  findAll() {
    return this.pinningService.findAll();
  }

  @Get(':cid')
  @ApiOperation({ summary: 'Get a pin record by CID' })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  findOne(@Param('cid') cid: string) {
    return this.pinningService.findByCid(cid);
  }

  @Post(':cid/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-verify pin durability and top up replication if degraded',
    description:
      'Re-checks every provider believed to hold the pin and, if replication has dropped below the ' +
      'configured factor, attempts to restore it via any remaining providers. The re-pin worker calls ' +
      'this same logic automatically on a schedule; this endpoint triggers it on demand.',
  })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  verify(@Param('cid') cid: string) {
    return this.pinningService.reconcile(cid);
  }

  @Delete(':cid')
  @ApiOperation({ summary: 'Unpin content from every provider currently holding it' })
  @ApiParam({ name: 'cid', example: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })
  @ApiResponse({ status: 200, type: PinRecordResponseDto })
  @ApiResponse({ status: 404, description: 'Pin record not found' })
  unpin(@Param('cid') cid: string) {
    return this.pinningService.unpin(cid);
  }
}
