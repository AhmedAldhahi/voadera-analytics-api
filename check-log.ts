import { PrismaService } from './src/prisma.service';

const prisma = new PrismaService();

async function check() {
  const log = await prisma.webLog.findFirst({ where: { tsUsername: 'ahmed' } });
  console.log("Sample log:", log);
}

check().catch(console.error).finally(() => prisma.$disconnect());
