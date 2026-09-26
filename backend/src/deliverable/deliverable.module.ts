import { Module } from '@nestjs/common';
import { DeliverableController } from './deliverable.controller';
import { DeliverableService } from './deliverable.service';
import { IpfsPinningModule } from '../ipfs-pinning/ipfs-pinning.module';
import { GigModule } from '../gig/gig.module';

@Module({
  imports: [IpfsPinningModule, GigModule],
  controllers: [DeliverableController],
  providers: [DeliverableService],
  exports: [DeliverableService],
})
export class DeliverableModule {}
