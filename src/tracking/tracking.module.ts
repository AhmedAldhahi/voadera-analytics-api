import { Module } from '@nestjs/common';
import { TrackingController } from './tracking.controller';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [TrackingController],
  providers: [PrismaService],
})
export class TrackingModule {}
