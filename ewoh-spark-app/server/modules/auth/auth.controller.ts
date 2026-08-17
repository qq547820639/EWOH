import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { REFRESH_TOKEN_COOKIE, AuthService } from './auth.service';
import { Public } from '../shared/public.decorator';
import { Roles, ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';

/** CLI-501/701：refresh token 不再进入响应体/localStorage，改为 httpOnly cookie。 */
interface CookieCapableResponse {
  setHeader?: (name: string, value: string) => void;
}

interface CookieCapableRequest {
  headers?: { authorization?: string; cookie?: string };
}

/** 从请求 Cookie 头解析 refresh token（无 cookie-parser 依赖的最小实现）。 */
function readRefreshCookie(request?: CookieCapableRequest): string | undefined {
  const header = request?.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === REFRESH_TOKEN_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * CLI-501/701：refresh token 通过 httpOnly + SameSite=Strict + Path=/api/auth
   * 的 cookie 下发，JS 不可读（XSS 无法窃取长期凭证）；production 加 Secure。
   */
  private setRefreshCookie(res: CookieCapableResponse, token: string): void {
    const maxAge = this.authService.refreshTokenCookieMaxAge();
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader?.(
      'Set-Cookie',
      `${REFRESH_TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=${maxAge}${secure}`,
    );
  }

  /** 登出/刷新失败时清除 refresh cookie。 */
  private clearRefreshCookie(res: CookieCapableResponse): void {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader?.(
      'Set-Cookie',
      `${REFRESH_TOKEN_COOKIE}=; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=0${secure}`,
    );
  }

  @Post('login')
  @Public()
  async login(
    @Body() body: { username?: string; password?: string },
    @Res({ passthrough: true }) res?: CookieCapableResponse,
  ) {
    if (!body.username || !body.password) {
      throw new UnauthorizedException('username and password are required');
    }
    const tokens = await this.authService.login(body.username, body.password);
    if (res) this.setRefreshCookie(res, tokens.refreshToken);
    // CLI-501：refresh token 不再随响应体下发（否则 httpOnly 形同虚设）。
    return { accessToken: tokens.accessToken, user: tokens.user };
  }

  @Post('refresh')
  @Public()
  async refresh(
    @Body() body: { refreshToken?: string },
    @Req() request?: CookieCapableRequest,
    @Res({ passthrough: true }) res?: CookieCapableResponse,
  ) {
    // CLI-701：cookie 优先（终态契约），body 兼容旧客户端过渡。
    const refreshToken = readRefreshCookie(request) ?? body.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('refreshToken is required');
    }
    const tokens = await this.authService.refresh(refreshToken);
    if (res) this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, user: tokens.user };
  }

  @Post('logout')
  @Public()
  async logout(
    @Body() body: { refreshToken?: string },
    @Req() request?: CookieCapableRequest,
    @Res({ passthrough: true }) res?: CookieCapableResponse,
  ) {
    const refreshToken = readRefreshCookie(request) ?? body.refreshToken;
    if (!refreshToken) {
      throw new UnauthorizedException('refreshToken is required');
    }
    // NEST-418：尽力吊销请求携带的 access token（jti 黑名单）。
    const accessToken =
      /^Bearer\s+(.+)$/i.exec(request?.headers?.authorization ?? '')?.[1];
    await this.authService.logout(refreshToken, accessToken);
    if (res) this.clearRefreshCookie(res);
    return { success: true };
  }

  @Roles(...ANY_AUTHENTICATED_ROLES)
  @Get('me')
  me(@Req() request: { userContext?: { userId?: string; roles?: string[]; primaryOrgId?: string } }) {
    if (!request.userContext?.userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    return request.userContext;
  }
}
