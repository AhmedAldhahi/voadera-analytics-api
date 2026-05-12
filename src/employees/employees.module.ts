import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [EmployeesController],
  providers: [PrismaService],
})
export class EmployeesModule {}
