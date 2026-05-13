import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { PrismaService } from '../prisma.service'; 

@Controller()
export class TrackingController {
  constructor(private prisma: PrismaService) {}

  // 📡 Handles the Idle logs from the C# Agent
  @Post('idle')
  async handleIdleData(@Body() body: { username: string; idleDuration: number; reason?: string }) {
    console.log(
      `🎯 [API RECEIVED] User: ${body.username} | Idle: ${body.idleDuration} seconds. ${body.reason ? `Reason: ${body.reason}` : ''}`,
    );

    try {
      let employee = await this.prisma.employee.findUnique({
        where: { tsUsername: body.username },
      });

      if (!employee) {
        employee = await this.prisma.employee.create({
          data: { tsUsername: body.username, fullName: body.username },
        });
      }

      let session = await this.prisma.session.findFirst({
        where: { employeeId: employee.id, logoutTime: null },
      });

      if (!session) {
        session = await this.prisma.session.create({
          data: { employeeId: employee.id },
        });
      }

      await this.prisma.idleLog.create({
        data: { sessionId: session.id, idleDurationSecs: body.idleDuration },
      });

      if (body.reason) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { logoutTime: new Date() },
        });
      }

      return { status: 'Success', message: 'Data securely logged.' };
    } catch (error) {
      console.error('Database Error:', error);
      return { status: 'Error', message: 'Failed to save to database.' };
    }
  }

  @Post('web-activity')
  async saveWebLogs(@Body() body: any) {
    // 1. Let's print exactly what C# sent us so we can see it in the terminal
    console.log(`📦 [RAW PAYLOAD]`, JSON.stringify(body, null, 2));

    // 2. Handle C# capitalizing the 'Logs' array name
    const logsArray = body.logs || body.Logs;

    if (!logsArray || logsArray.length === 0) {
      return { status: 'Ignored', message: 'No logs provided' };
    }

    try {
      // 3. Smart Mapping: Check for both lowercase AND capitalized keys
      const dataToInsert = logsArray.map(log => ({
        tsUsername: log.username || log.Username,
        url: log.url || log.Url || log.URL,
        createdAt: new Date(log.timestamp || log.Timestamp),
      }));

      // 4. Save to Postgres
      await this.prisma.webLog.createMany({
        data: dataToInsert,
      });

      console.log(`✅ [WEB-MONITOR] Successfully saved ${dataToInsert.length} links!`);
      
      return { status: 'Success', count: dataToInsert.length };
    } catch (error) {
      console.error('❌ [WEB-MONITOR] Database Error:', error);
      return { status: 'Error', message: 'Failed to save to database.' };
    }
  }

  // 🔍 GET /weblogs/:username (Used by HR Modal)
  @Get('weblogs/:username')
  async getEmployeeWebLogs(@Param('username') username: string) {
    try {
      // Get the start and end of the current day
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      // Fetch logs for this user, ordered by newest first
      const logs = await this.prisma.webLog.findMany({
        where: {
          tsUsername: username,
          createdAt: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        orderBy: {
          createdAt: 'desc', // Newest links at the top
        },
        take: 1000, // Safety limit: don't crash if there are 50,000 logs
      });

      return { status: 'Success', data: logs };
    } catch (error) {
      console.error('❌ Error fetching web logs:', error);
      return { status: 'Error', message: 'Could not fetch logs.' };
    }
  }

  // 🧹 Purge Messy Logs (Used for "Deep Clean")
  @Get('purge-logs')
  async purgeMessyLogs() {
    try {
      const result = await this.prisma.webLog.deleteMany({
        where: {
          OR: [
            { url: { contains: '%20' } },
            { url: { contains: 'Xn--' } },
          ],
        },
      });

      console.log(`🧹 [PURGE] Deleted ${result.count} messy logs.`);
      return { status: 'Success', message: `Deleted ${result.count} messy logs.` };
    } catch (error) {
      console.error('❌ [PURGE] Error:', error);
      return { status: 'Error', message: 'Failed to purge logs.' };
    }
  }
}