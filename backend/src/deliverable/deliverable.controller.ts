import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { Idempotent } from '../common/idempotency';
import { DeliverableService } from './deliverable.service';
import { UploadDeliverableDto, UploadDeliverableSchema } from './deliverable.dto';

@ApiTags('Deliverables')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('deliverables')
export class DeliverableController {
  constructor(private readonly deliverableService: DeliverableService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @ApiOperation({ summary: 'Upload a deliverable and pin to IPFS' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['gigId', 'freelancer', 'content', 'filename'],
      properties: {
        gigId: { type: 'string', example: 'gig-1234567890-ab12cd' },
        freelancer: { type: 'string', example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
        content: { type: 'string', description: 'Base64-encoded file content' },
        filename: { type: 'string', example: 'audit-report.pdf' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Deliverable uploaded and pinned' })
  @ApiResponse({ status: 503, description: 'IPFS pinning failed' })
  async upload(@Body() dto: UploadDeliverableDto) {
    const validated = UploadDeliverableSchema.parse(dto);
    return this.deliverableService.upload(validated);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a deliverable by ID' })
  @ApiParam({ name: 'id', example: 'del-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'Deliverable details' })
  @ApiResponse({ status: 404, description: 'Deliverable not found' })
  findOne(@Param('id') id: string) {
    return this.deliverableService.findById(id);
  }

  @Get('gig/:gigId')
  @ApiOperation({ summary: 'List deliverables for a gig' })
  @ApiParam({ name: 'gigId', example: 'gig-1234567890-ab12cd' })
  @ApiResponse({ status: 200, description: 'List of deliverables' })
  findByGig(@Param('gigId') gigId: string) {
    return this.deliverableService.findByGig(gigId);
  }
}
