import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { EmployeesModule } from './employees/employees.module';
import { TrackingModule } from './tracking/tracking.module';

@Module({
  imports: [EmployeesModule, TrackingModule],
  controllers: [AppController],
})
export class AppModule {}
