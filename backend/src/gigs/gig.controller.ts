import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  CreateGigDto,
  CreateGigSchema,
  GigFiltersSchema,
  UpdateGigDto,
  UpdateGigSchema,
} from './gig.dto';
import { GigStatus } from './gig.entity';
import { GigService } from './gig.service';

@ApiTags('Gig Listings')
@Controller('gigs')
export class GigController {
  constructor(private readonly gigService: GigService) {}

  private parseOrThrow<T>(schema: z.ZodSchema<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid gig listing payload',
        errors: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }

  @Post()
  @ApiOperation({
    summary: 'Create a gig listing',
    description: 'Creates an open gig solicitation for clients seeking freelancers.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['clientAddress', 'title', 'description', 'budgetXLM'],
      properties: {
        clientAddress: {
          type: 'string',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        title: { type: 'string', example: 'Build a Soroban escrow dashboard' },
        description: {
          type: 'string',
          example: 'Create a dashboard for tracking escrow milestones.',
        },
        budgetXLM: { type: 'string', example: '250.0000000' },
        category: { type: 'string', example: 'development' },
        skills: { type: 'array', items: { type: 'string' }, example: ['NestJS', 'Soroban'] },
        deadline: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Gig listing created' })
  @ApiResponse({ status: 400, description: 'Invalid gig listing payload' })
  async create(@Body() dto: CreateGigDto) {
    const validated = this.parseOrThrow(CreateGigSchema, dto);
    return this.gigService.create({ ...validated, skills: validated.skills ?? [] });
  }

  @Get()
  @ApiOperation({
    summary: 'List gig listings',
    description:
      'Lists open gig solicitations with optional client, status, category, and skill filters.',
  })
  @ApiQuery({ name: 'clientAddress', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: GigStatus })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'skill', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Gig listing collection' })
  async findAll(
    @Query('clientAddress') clientAddress?: string,
    @Query('status') status?: GigStatus,
    @Query('category') category?: string,
    @Query('skill') skill?: string,
  ) {
    const filters = this.parseOrThrow(GigFiltersSchema, { clientAddress, status, category, skill });
    return this.gigService.findAll(filters);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a gig listing by ID' })
  @ApiParam({ name: 'id', description: 'Gig listing ID' })
  @ApiResponse({ status: 200, description: 'Gig listing details' })
  @ApiResponse({ status: 404, description: 'Gig listing not found' })
  async findById(@Param('id') id: string) {
    return this.gigService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a gig listing',
    description: 'Updates mutable gig listing fields or transitions listing status.',
  })
  @ApiParam({ name: 'id', description: 'Gig listing ID' })
  @ApiResponse({ status: 200, description: 'Gig listing updated' })
  @ApiResponse({ status: 400, description: 'Invalid transition or payload' })
  @ApiResponse({ status: 404, description: 'Gig listing not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateGigDto) {
    const validated = this.parseOrThrow(UpdateGigSchema, dto);
    return this.gigService.update(id, validated);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close a gig listing' })
  @ApiParam({ name: 'id', description: 'Gig listing ID' })
  @ApiResponse({ status: 200, description: 'Gig listing closed' })
  @ApiResponse({ status: 404, description: 'Gig listing not found' })
  async close(@Param('id') id: string) {
    return this.gigService.close(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a gig listing' })
  @ApiParam({ name: 'id', description: 'Gig listing ID' })
  @ApiResponse({ status: 204, description: 'Gig listing deleted' })
  @ApiResponse({ status: 404, description: 'Gig listing not found' })
  async delete(@Param('id') id: string) {
    await this.gigService.delete(id);
  }
}
