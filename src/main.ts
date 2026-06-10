import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Lock down CORS so the old Hostinger domain becomes useless
  app.enableCors({
    origin: [
      'http://localhost:5173', // For local development
      process.env.FRONTEND_URL, // e.g. https://your-new-app.vercel.app
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
