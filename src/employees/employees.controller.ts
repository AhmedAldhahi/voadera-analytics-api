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

      // --- OFFICE CHECK-IN: Check 5:00 PM Jordan time (Asia/Amman) auto-revert ---
      let inOfficeToday = employee.inOfficeToday;
      if (inOfficeToday && employee.officeCheckInTime) {
        const checkInDate = new Date(employee.officeCheckInTime);
        const now = new Date();
        
        const jordanNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Amman' }));
        const jordanCheckIn = new Date(checkInDate.toLocaleString('en-US', { timeZone: 'Asia/Amman' }));

        // Revert if it is past 5:00 PM (17:00) in Jordan time today, OR if checked in on a previous day in Jordan time
        if (jordanNow.getDate() !== jordanCheckIn.getDate() || jordanNow.getHours() >= 17 || (now.getTime() - checkInDate.getTime()) > 24 * 3600 * 1000) {
          inOfficeToday = false;
          await this.prisma.employee.update({
            where: { id: employee.id },
            data: { inOfficeToday: false, officeCheckOutTime: now },
          });
          console.log(`🏢 [OFFICE] 5:00 PM Jordan time reached (or new day). Reverting ${username} to normal tracking.`);
        }
      }

      return {
        idleLimit: inOfficeToday ? -1 : employee.idleLimit,
        forceLogoff: employee.forceLogoff,
        inOfficeToday: inOfficeToday,
        serverTime: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Settings Error:', error);
      return { idleLimit: 900, forceLogoff: false, inOfficeToday: false, serverTime: new Date().toISOString() };
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
          securityAlerts: {
            where: {
              timestamp: {
                gte: start,
                lte: end,
              },
            },
            orderBy: { timestamp: 'desc' },
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

        // Calculate office block if checked in during this period
        let officeStartMs = 0;
        let officeEndMs = 0;
        if (emp.officeCheckInTime) {
          const checkInMs = emp.officeCheckInTime.getTime();
          if (checkInMs >= startMs && checkInMs <= endMs) {
            officeStartMs = checkInMs;
            let checkOutMs = emp.officeCheckOutTime ? emp.officeCheckOutTime.getTime() : Date.now();
            
            // Cap active office time at 5:00 PM Jordan time (17:00 Asia/Amman = 14:00 UTC) on that check-in day
            const fivePmJordanUtc = new Date(Date.UTC(
              emp.officeCheckInTime.getUTCFullYear(),
              emp.officeCheckInTime.getUTCMonth(),
              emp.officeCheckInTime.getUTCDate(),
              14, 0, 0, 0
            )).getTime();

            if (!emp.officeCheckOutTime && Date.now() > fivePmJordanUtc) {
              checkOutMs = fivePmJordanUtc;
            }
            officeEndMs = Math.min(checkOutMs, endMs);

            if (officeEndMs > officeStartMs) {
              totalSessionSeconds += (officeEndMs - officeStartMs) / 1000;
            }
          }
        }

        emp.sessions.forEach((session) => {
          // --- FIX Bug #2: Clamp session time to the requested date range ---
          const rawStart = session.loginTime.getTime();
          const rawEnd = session.logoutTime ? session.logoutTime.getTime() : Date.now();

          // Clamp: only count the portion of the session that falls within [start, end]
          const clampedStart = Math.max(rawStart, startMs);
          const clampedEnd = Math.min(rawEnd, endMs);

          if (clampedEnd > clampedStart) {
            if (officeEndMs > officeStartMs) {
              if (clampedStart < officeStartMs) {
                const beforeEnd = Math.min(clampedEnd, officeStartMs);
                if (beforeEnd > clampedStart) totalSessionSeconds += (beforeEnd - clampedStart) / 1000;
              }
              if (clampedEnd > officeEndMs) {
                const afterStart = Math.max(clampedStart, officeEndMs);
                if (clampedEnd > afterStart) totalSessionSeconds += (clampedEnd - afterStart) / 1000;
              }
            } else {
              totalSessionSeconds += (clampedEnd - clampedStart) / 1000;
            }
          }

          session.idleLogs.forEach((log) => {
            // Only count idle logs that fall within the date range
            const logTime = log.recordedAt.getTime();
            if (logTime >= startMs && logTime <= endMs) {
              if (!(officeEndMs > officeStartMs && logTime >= officeStartMs && logTime <= officeEndMs)) {
                totalIdleSeconds += log.idleDurationSecs;
                if (log.idleDurationSecs > longestIdleSeconds) {
                  longestIdleSeconds = log.idleDurationSecs;
                }
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
          inOfficeToday: emp.inOfficeToday,
          officeCheckInTime: emp.officeCheckInTime ? emp.officeCheckInTime.toISOString() : null,
          officeCheckOutTime: emp.officeCheckOutTime ? emp.officeCheckOutTime.toISOString() : null,
          idleLimit: emp.idleLimit,
          forceLogoff: emp.forceLogoff,
          securityAlerts: emp.securityAlerts,
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
    @Body() body: {
      name?: string;
      department?: string;
      idleLimit?: number;
      forceLogoff?: boolean;
      inOfficeToday?: boolean;
      officeCheckInTime?: string;
      officeCheckOutTime?: string;
    },
  ) {
    try {
      let officeData: any = {};
      if (body.inOfficeToday !== undefined) {
        officeData.inOfficeToday = body.inOfficeToday;
        if (body.inOfficeToday === true) {
          officeData.officeCheckInTime = body.officeCheckInTime ? new Date(body.officeCheckInTime) : new Date();
          officeData.officeCheckOutTime = null;
          console.log(`🏢 [OFFICE] Employee ${id} checked in at ${officeData.officeCheckInTime}`);
        } else {
          officeData.officeCheckOutTime = body.officeCheckOutTime ? new Date(body.officeCheckOutTime) : new Date();
          console.log(`🏢 [OFFICE] Employee ${id} unchecked early at ${officeData.officeCheckOutTime}`);
        }
      }

      const updated = await this.prisma.employee.update({
        where: { id },
        data: {
          ...(body.name && { fullName: body.name }),
          ...(body.department && { department: body.department }),
          ...(body.idleLimit !== undefined && { idleLimit: body.idleLimit }),
          ...(body.forceLogoff !== undefined && { forceLogoff: body.forceLogoff }),
          ...officeData,
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

  // 📉 GET /employees/:id/daily-report (Used for CSV export of daily breakdown)
  @UseGuards(JwtAuthGuard)
  @Get(':id/daily-report')
  async getEmployeeDailyReport(
    @Param('id') id: string,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string
  ) {
    try {
      const start = startStr ? new Date(startStr) : new Date(new Date().setHours(0, 0, 0, 0));
      const end = endStr ? new Date(endStr) : new Date(new Date().setHours(23, 59, 59, 999));

      const emp = await this.prisma.employee.findUnique({ where: { id } });
      const sessions = await this.prisma.session.findMany({
        where: {
          employeeId: id,
          loginTime: { lte: end },
          OR: [
            { logoutTime: { gte: start } },
            { logoutTime: null },
          ],
        },
        include: { idleLogs: true },
      });

      const dailyData: Record<string, {
        totalSessionSeconds: number;
        totalIdleSeconds: number;
        longestIdleSeconds: number;
      }> = {};

      const startMs = start.getTime();
      const endMs = end.getTime();

      // Calculate office block if checked in during this period
      let officeStartMs = 0;
      let officeEndMs = 0;
      if (emp && emp.officeCheckInTime) {
        const checkInMs = emp.officeCheckInTime.getTime();
        if (checkInMs >= startMs && checkInMs <= endMs) {
          officeStartMs = checkInMs;
          let checkOutMs = emp.officeCheckOutTime ? emp.officeCheckOutTime.getTime() : Date.now();
          const fivePmThatDay = new Date(emp.officeCheckInTime);
          fivePmThatDay.setHours(17, 0, 0, 0);
          if (!emp.officeCheckOutTime && Date.now() > fivePmThatDay.getTime()) {
            checkOutMs = fivePmThatDay.getTime();
          }
          officeEndMs = Math.min(checkOutMs, endMs);
          if (officeEndMs > officeStartMs) {
            const dateStr = new Date(officeStartMs).toISOString().split('T')[0];
            if (!dailyData[dateStr]) {
              dailyData[dateStr] = { totalSessionSeconds: 0, totalIdleSeconds: 0, longestIdleSeconds: 0 };
            }
            dailyData[dateStr].totalSessionSeconds += (officeEndMs - officeStartMs) / 1000;
          }
        }
      }

      sessions.forEach(session => {
        const rawStart = session.loginTime.getTime();
        const rawEnd = session.logoutTime ? session.logoutTime.getTime() : Date.now();

        const clampedStart = Math.max(rawStart, startMs);
        const clampedEnd = Math.min(rawEnd, endMs);

        if (clampedEnd > clampedStart) {
          const dateStr = new Date(clampedStart).toISOString().split('T')[0];
          if (!dailyData[dateStr]) {
            dailyData[dateStr] = { totalSessionSeconds: 0, totalIdleSeconds: 0, longestIdleSeconds: 0 };
          }
          if (officeEndMs > officeStartMs) {
            if (clampedStart < officeStartMs) {
              const beforeEnd = Math.min(clampedEnd, officeStartMs);
              if (beforeEnd > clampedStart) dailyData[dateStr].totalSessionSeconds += (beforeEnd - clampedStart) / 1000;
            }
            if (clampedEnd > officeEndMs) {
              const afterStart = Math.max(clampedStart, officeEndMs);
              if (clampedEnd > afterStart) dailyData[dateStr].totalSessionSeconds += (clampedEnd - afterStart) / 1000;
            }
          } else {
            dailyData[dateStr].totalSessionSeconds += (clampedEnd - clampedStart) / 1000;
          }
        }

        session.idleLogs.forEach(log => {
          const logTime = log.recordedAt.getTime();
          if (logTime >= startMs && logTime <= endMs) {
            if (!(officeEndMs > officeStartMs && logTime >= officeStartMs && logTime <= officeEndMs)) {
              const dateStr = log.recordedAt.toISOString().split('T')[0];
              if (!dailyData[dateStr]) {
                dailyData[dateStr] = { totalSessionSeconds: 0, totalIdleSeconds: 0, longestIdleSeconds: 0 };
              }
              dailyData[dateStr].totalIdleSeconds += log.idleDurationSecs;
              if (log.idleDurationSecs > dailyData[dateStr].longestIdleSeconds) {
                dailyData[dateStr].longestIdleSeconds = log.idleDurationSecs;
              }
            }
          }
        });
      });

      const formatTime = (totalSeconds: number) => {
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        const secs = Math.floor(totalSeconds % 60);
        return `${hrs}h ${mins}m ${secs}s`;
      };

      const result = Object.keys(dailyData).sort((a, b) => new Date(b).getTime() - new Date(a).getTime()).map(dateStr => {
        const data = dailyData[dateStr];
        const activeSeconds = Math.max(0, data.totalSessionSeconds - data.totalIdleSeconds);
        return {
          date: dateStr,
          totalTime: formatTime(data.totalSessionSeconds),
          activeTime: formatTime(activeSeconds),
          idleTime: formatTime(data.totalIdleSeconds),
          longestIdle: formatTime(data.longestIdleSeconds),
        };
      });

      return { status: 'Success', data: result };
    } catch (error) {
      console.error('Daily Report Error:', error);
      return { status: 'Error', message: 'Could not fetch daily report.' };
    }
  }
}