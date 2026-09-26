import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { NonceStoreService } from './nonce-store.service';
import { config, JWT_ALGORITHM } from '../config/env.config';

@Module({
  imports: [
    PassportModule,
    // registerAsync's useFactory is evaluated when Nest instantiates this module's
    // providers (during app bootstrap), not when this file is imported — unlike
    // register(), which would read config.JWT_SECRET as soon as the class is
    // declared, before validateEnv() has necessarily run (see #428).
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: JWT_ALGORITHM, expiresIn: '24h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, NonceStoreService],
  exports: [AuthService],
})
export class AuthModule {}
