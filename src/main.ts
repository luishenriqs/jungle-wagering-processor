import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function bootstrap(port = 3000) {
  const app = await NestFactory.create(AppModule);
  try {
    app.enableShutdownHooks();
    await app.listen(port, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (import.meta.main) {
  const port = Number(process.env['PORT'] ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  await bootstrap(port);
}
