import { Controller, Get, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('employees')
export class EmployeesController {
  constructor(private prisma: PrismaService) {}

  // ⚙️ GET /employees/settings (Used by the C# agent for the heartbeat)
  @Get('settings')
  async getAgentSettings(@Query('user') username: string) {
    try {
      let employee = await this.prisma.employee.findUnique({
        where: { tsUsername: username },
      });
      if (!employee) {
        employee = await this.prisma.employee.create({
          data: { tsUsername: username, fullName: username },
        });
      }

      // --- FIX Bug #1: Auto-close stale sessions (>24h old) ---
      const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const staleSessions = await this.prisma.session.findMany({
        where: {
          employeeId: employee.id,
          logoutTime: null,
          loginTime: { lt: staleThreshold },
        },
      });

      if (staleSessions.length > 0) {
        console.log(`🧹 [STALE] Closing ${staleSessions.length} stale session(s) for ${username}`);
        await Promise.all(staleSessions.map(stale => 
          this.prisma.session.update({
            where: { id: stale.id },
            data: { logoutTime: stale.lastSeen }, // FIX: Close at lastSeen to prevent fake hours
          })
        ));
      }

      // Find an open session
      let session = await this.prisma.session.findFirst({
        where: { employeeId: employee.id, logoutTime: null },
      });

      // --- FIX: Prevent resurrecting ghost sessions from yesterday ---
      if (session) {
        const heartbeatThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes missed
        if (session.lastSeen < heartbeatThreshold) {
          console.log(`🧹 [RESURRECTED] Closing dead session for ${username} at ${session.lastSeen}`);
          await this.prisma.session.update({
            where: { id: session.id },
            data: { logoutTime: session.lastSeen }, // Close exactly when it died
          });
          session = null; // Force creation of a new session
        }
      }

      if (!session) {
        await this.prisma.session.create({ data: { employeeId: employee.id } });
      } else {
        // --- HEARTBEAT TRACKING: Update lastSeen ---
        await this.prisma.session.update({
          where: { id: session.id },
          data: { lastSeen: new Date() },
        });
      }

      return {
        idleLimit: employee.idleLimit,
        forceLogoff: employee.forceLogoff,
        serverTime: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Settings Error:', error);
      return { idleLimit: 900, forceLogoff: false, serverTime: new Date().toISOString() };
    }
  }

  // 📊 GET /employees (Used by the React Dashboard)
  @UseGuards(JwtAuthGuard)
  @Get()
  async getDashboardData(@Query('start') startStr?: string, @Query('end') endStr?: string) {
    try {
      // --- AUTO-CLOSE GHOST SESSIONS (Heartbeat timeout = 3 mins) ---
      const heartbeatThreshold = new Date(Date.now() - 3 * 60 * 1000);
      const ghostSessions = await this.prisma.session.findMany({
        where: {
          logoutTime: null,
          lastSeen: { lt: heartbeatThreshold },
        },
      });

      if (ghostSessions.length > 0) {
        console.log(`🧹 [GHOST] Auto-closing ${ghostSessions.length} ghost sessions (missed heartbeats)`);
        await Promise.all(ghostSessions.map(ghost => 
          this.prisma.session.update({
            where: { id: ghost.id },
            data: { logoutTime: ghost.lastSeen }, // Close exactly at last known heartbeat
          })
        ));
      }

      const start = startStr ? new Date(startStr) : new Date(new Date().setHours(0, 0, 0, 0));
      const end = endStr ? new Date(endStr) : new Date(new Date().setHours(23, 59, 59, 999));

      // --- FIX Bug #3: Include sessions that OVERLAP with the date range ---
      // A session overlaps if: loginTime <= end AND (logoutTime >= start OR logoutTime IS NULL)
      const employees = await this.prisma.employee.findMany({
        include: {
          sessions: {
            where: {
              loginTime: { lte: end },
              OR: [
                { logoutTime: { gte: start } },
                { logoutTime: null },
              ],
            },
            include: { idleLogs: true },
          },
        },
      });

      const formatTime = (totalSeconds: number) => {
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        const secs = Math.floor(totalSeconds % 60);
        return `${hrs}h ${mins}m ${secs}s`;
      };

      const startMs = start.getTime();
      const endMs = end.getTime();

      return employees.map((emp) => {
        let totalSessionSeconds = 0;
        let totalIdleSeconds = 0;
        let longestIdleSeconds = 0;

        emp.sessions.forEach((session) => {
          // --- FIX Bug #2: Clamp session time to the requested date range ---
          const rawStart = session.loginTime.getTime();
          const rawEnd = session.logoutTime ? session.logoutTime.getTime() : Date.now();

          // Clamp: only count the portion of the session that falls within [start, end]
          const clampedStart = Math.max(rawStart, startMs);
          const clampedEnd = Math.min(rawEnd, endMs);

          if (clampedEnd > clampedStart) {
            totalSessionSeconds += (clampedEnd - clampedStart) / 1000;
          }

          session.idleLogs.forEach((log) => {
            // Only count idle logs that fall within the date range
            const logTime = log.recordedAt.getTime();
            if (logTime >= startMs && logTime <= endMs) {
              totalIdleSeconds += log.idleDurationSecs;
              if (log.idleDurationSecs > longestIdleSeconds) {
                longestIdleSeconds = log.idleDurationSecs;
              }
            }
          });
        });

        const activeSeconds = Math.max(0, totalSessionSeconds - totalIdleSeconds);

        return {
          id: emp.id,
          windowsId: emp.tsUsername,
          name: emp.fullName,
          department: emp.department || 'Unassigned',
          totalTime: formatTime(totalSessionSeconds),
          activeTime: formatTime(activeSeconds),
          idleTime: formatTime(totalIdleSeconds),
          longestIdle: formatTime(longestIdleSeconds),
        };
      });
    } catch (error) {
      console.error('Dashboard Data Error:', error);
      // Return an empty array instead of crashing with 500
      return [];
    }
  }

  // ✏️ PATCH /employees/:id (Used by HR to edit a user)
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateEmployee(
    @Param('id') id: string,
    @Body() body: { name?: string; department?: string; idleLimit?: number; forceLogoff?: boolean },
  ) {
    try {
      const updated = await this.prisma.employee.update({
        where: { id },
        data: {
          ...(body.name && { fullName: body.name }),
          ...(body.department && { department: body.department }),
          ...(body.idleLimit !== undefined && { idleLimit: body.idleLimit }),
          ...(body.forceLogoff !== undefined && { forceLogoff: body.forceLogoff }),
        },
      });
      return { status: 'Success', data: updated };
    } catch (error) {
      console.error('Update Error:', error);
      return { status: 'Error', message: 'Employee not found.' };
    }
  }

  // 🕒 GET /employees/:id/sessions (Used by HR to view login/logout history)
  @UseGuards(JwtAuthGuard)
  @Get(':id/sessions')
  async getEmployeeSessions(
    @Param('id') id: string,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string
  ) {
    try {
      const start = startStr ? new Date(startStr) : new Date(new Date().setHours(0, 0, 0, 0));
      const end = endStr ? new Date(endStr) : new Date(new Date().setHours(23, 59, 59, 999));

      const sessions = await this.prisma.session.findMany({
        where: {
          employeeId: id,
          loginTime: { lte: end },
          OR: [
            { logoutTime: { gte: start } },
            { logoutTime: null },
          ],
        },
        orderBy: {
          loginTime: 'asc', // Chronological order
        },
      });

      return { status: 'Success', data: sessions };
    } catch (error) {
      console.error('Sessions Error:', error);
      return { status: 'Error', message: 'Could not fetch sessions.' };
    }
  }
}