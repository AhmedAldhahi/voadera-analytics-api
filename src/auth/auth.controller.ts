import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Controller('auth')
export class AuthController {
  constructor(private jwt: JwtService) {}

  @Post('login')
  async login(@Body() body: { password: string }) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'VoaderaHR2026';

    if (!body.password || body.password !== adminPassword) {
      throw new UnauthorizedException('Invalid password');
    }

    const token = await this.jwt.signAsync(
      { role: 'admin', iat: Date.now() },
      { expiresIn: '24h' },
    );

    return { token };
  }
}
