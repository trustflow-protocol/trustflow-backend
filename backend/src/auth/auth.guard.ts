import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    const token = auth.slice(7);
    const [payload, sig] = token.split('.');
    if (!payload || !sig) throw new UnauthorizedException('Invalid token format');
    const expected = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'dev')
      .update(payload)
      .digest('base64');
    if (sig !== expected) throw new UnauthorizedException('Invalid signature');
    try {
      req.user = JSON.parse(Buffer.from(payload, 'base64').toString());
    } catch {
      throw new UnauthorizedException('Malformed token');
    }
    return true;
  }
}
