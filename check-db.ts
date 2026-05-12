import { PrismaService } from './src/prisma.service';

const prisma = new PrismaService();

async function check() {
  const employees = await prisma.employee.findMany({ select: { tsUsername: true } });
  console.log("Employees tsUsernames:", employees.map(e => e.tsUsername));

  const webLogs = await prisma.webLog.groupBy({
    by: ['tsUsername'],
    _count: true
  });
  console.log("WebLog tsUsernames and counts:", webLogs);
}

check().catch(console.error).finally(() => prisma.$disconnect());
