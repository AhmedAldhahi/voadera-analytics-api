import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { EmployeesModule } from './employees/employees.module';
import { TrackingModule } from './tracking/tracking.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [AuthModule, EmployeesModule, TrackingModule],
  controllers: [AppController],
})
export class AppModule {}
