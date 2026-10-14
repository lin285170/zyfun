/**
 * 网盘扫码登录服务。
 *
 * 目前实现 **百度网盘**（协议已实测：`getqrcode` 可取 sign 与二维码 PNG，
 * `channel/unicast` 长轮询在无人扫码时会 hold 住连接 —— 均为预期行为）。
 *
 * 夸克扫码接口尚未定位（`/api/qrlogin/create` 返回 SPA HTML，其余路径 404），
 * 故先返回「暂不支持」，待协议摸清后按同一接口补驱动即可。
 *
 * 设计要点：
 * - 每个登录会话独立维护 **cookie jar**：平台可能在任何一步下发 BDUSS，
 *   必须全程累积并回传，否则拿不到最终凭据。
 * - 状态机：waiting → scanned → confirmed | expired | failed
 * - 会话 5 分钟自动过期（平台 sign 有效期约 3~5 分钟）。
 */
import { randomUUID } from 'node:crypto';

import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';

import type { IPanContext, IPanDriverId } from './types';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SESSION_TTL_MS = 5 * 60 * 1000;
/** unicast 长轮询：平台约 hold 30s，这里设 35s 留余量 */
const UNICAST_TIMEOUT_MS = 35_000;

export type QrStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed' | 'unsupported';

export interface IQrCreateResult {
  qrId: string;
  /** data:image/png;base64,... 可直接塞进 <img src> */
  image: string;
  expiresIn: number;
  driver: IPanDriverId;
  hint?: string;
}

export interface IQrPollResult {
  status: QrStatus;
  message?: string;
  /** 确认登录后返回，调用方负责落库 */
  credential?: { driver: IPanDriverId; cookie: string };
}

interface IQrSession {
  id: string;
  driver: IPanDriverId;
  createdAt: number;
  status: QrStatus;
  /** 平台侧标识（百度为 sign） */
  sign: string;
  /** 累积的 cookie jar：name=value 串 */
  cookies: Record<string, string>;
  /** 已确认但尚未被取走的凭据 */
  credential?: { driver: IPanDriverId; cookie: string };
  lastError?: string;
}

/** 从 Set-Cookie 响应头解析出 kv 并合并进 jar */
function absorbSetCookie(jar: Record<string, string>, setCookie?: string | string[]): void {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    // 一行里可能有多个 Set-Cookie（用换行/逗号分隔的情况），逐个处理第一个 kv
    for (const line of String(raw).split(/\n|(?=,\s*[A-Za-z0-9_-]+=)/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)=([^;]*)/);
      if (!m) continue;
      const [, name, value] = m;
      if (value === '' || /^deleted$/i.test(value)) delete jar[name];
      else jar[name] = value;
    }
  }
}

function jarToString(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

class QrLoginService {
  private sessions = new Map<string, IQrSession>();

  /** 支持的驱动（其余返回 unsupported） */
  supports(driver: IPanDriverId): boolean {
    return driver === 'baidu';
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  /** ① 创建扫码会话，返回二维码 */
  async create(driver: IPanDriverId, ctx: IPanContext): Promise<IQrCreateResult> {
    this.sweep();
    if (!this.supports(driver)) {
      return {
        qrId: '',
        image: '',
        expiresIn: 0,
        driver,
        hint: `${driver} 暂不支持扫码登录，请手动填写 Cookie`,
      };
    }
    const session: IQrSession = {
      id: randomUUID(),
      driver,
      createdAt: Date.now(),
      status: 'waiting',
      sign: '',
      cookies: {},
    };
    this.sessions.set(session.id, session);

    // 百度：GET /v2/api/getqrcode
    const res = await ctx.request({
      url: `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&apiver=v3&tt=${Date.now()}`,
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: 'https://pan.baidu.com/' },
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0 || !d.sign) {
      session.status = 'failed';
      session.lastError = `getqrcode errno=${d.errno}`;
      throw new Error(`获取二维码失败：errno=${d.errno ?? '?'} ${d.errmsg ?? ''}`);
    }
    session.sign = String(d.sign);
    absorbSetCookie(session.cookies, res.headers?.['set-cookie']);

    // imgurl 可能不带协议头
    const rawImgUrl: string = String(d.imgurl ?? '');
    const imgUrl = /^https?:\/\//i.test(rawImgUrl)
      ? rawImgUrl
      : `https://${rawImgUrl.replace(/^\/\//, '')}`;
    const png = await ctx.request({
      url: imgUrl,
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: 'https://passport.baidu.com/' },
      responseType: 'arraybuffer',
    });
    const buf: Buffer = Buffer.isBuffer(png.data) ? png.data : Buffer.from(png.data ?? '');
    if (!buf.length) throw new Error('二维码图片为空');
    const image = `data:image/png;base64,${buf.toString('base64')}`;

    logger.info(`扫码会话已创建：${driver} qrId=${session.id}`);
    return {
      qrId: session.id,
      image,
      expiresIn: Math.floor(SESSION_TTL_MS / 1000),
      driver,
      hint: '请用手机 App 扫码（百度网盘 App / 百度 App）',
    };
  }

  /** ② 轮询会话状态 */
  async poll(qrId: string, ctx: IPanContext): Promise<IQrPollResult> {
    const s = this.sessions.get(qrId);
    if (!s) return { status: 'expired', message: '会话不存在或已过期' };
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      s.status = 'expired';
      this.sessions.delete(qrId);
      return { status: 'expired', message: '二维码已过期，请重新获取' };
    }
    if (s.status === 'failed') return { status: 'failed', message: s.lastError };
    // 已确认：把凭据交付一次后清理
    if (s.credential) {
      const c = s.credential;
      this.sessions.delete(qrId);
      return { status: 'confirmed', credential: c };
    }
    if (s.driver !== 'baidu') return { status: 'unsupported' };

    // 百度：长轮询 unicast（扫到才会立即返回，否则连接被 hold 到超时）
    try {
      const res = await ctx.request({
        url: `https://passport.baidu.com/channel/unicast?channel_id=${encodeURIComponent(s.sign)}&tpl=netdisk&apiver=v3&tt=${Date.now()}&callback=`,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: 'https://passport.baidu.com/',
          ...(Object.keys(s.cookies).length ? { Cookie: jarToString(s.cookies) } : {}),
        },
        responseType: 'text',
        timeout: UNICAST_TIMEOUT_MS,
      });
      absorbSetCookie(s.cookies, res.headers?.['set-cookie']);
      const text = typeof res.data === 'string' ? res.data : String(res.data ?? '');
      const channelV = this.extractChannelV(text);
      if (!channelV) {
        // 仍在等待扫码
        return { status: 'waiting' };
      }
      s.status = 'scanned';

      // ③ unicall：确认登录
      const call = await ctx.request({
        url: `https://passport.baidu.com/channel/unicall?channel_id=${encodeURIComponent(s.sign)}&channel_v=${encodeURIComponent(channelV)}&tpl=netdisk&apiver=v3&tt=${Date.now()}&callback=`,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: 'https://passport.baidu.com/',
          ...(Object.keys(s.cookies).length ? { Cookie: jarToString(s.cookies) } : {}),
        },
        responseType: 'text',
        timeout: 20_000,
      });
      absorbSetCookie(s.cookies, call.headers?.['set-cookie']);
      // 关键：BDUSS 常随 Set-Cookie 下发；若没拿到，再请求一次网盘首页兜底
      if (!s.cookies.BDUSS) {
        const home = await ctx.request({
          url: 'https://pan.baidu.com/disk/home',
          method: 'GET',
          headers: {
            'User-Agent': UA,
            Cookie: jarToString(s.cookies),
            Referer: 'https://passport.baidu.com/',
          },
          responseType: 'text',
          timeout: 20_000,
        });
        absorbSetCookie(s.cookies, home.headers?.['set-cookie']);
      }

      const bduss = s.cookies.BDUSS;
      if (!bduss) {
        s.status = 'scanned';
        return {
          status: 'scanned',
          message: '已扫码，但未取得 BDUSS（请稍候重试，或手动填写 Cookie）',
        };
      }
      // 组装凭据（带上常用字段，便于驱动直接用）
      const cookie = jarToString(
        Object.fromEntries(
          Object.entries(s.cookies).filter(([k]) =>
            ['BDUSS', 'STOKEN', 'PTOKEN', 'BAIDUID', 'PANPSC', 'BDUSS_BFESS', 'STOKEN_BFESS', 'PTOKEN_BFESS'].includes(k),
          ),
        ),
      );
      s.credential = { driver: 'baidu', cookie };
      s.status = 'confirmed';
      logger.info(`扫码登录成功：baidu`);
      return { status: 'confirmed', credential: s.credential };
    } catch (e) {
      // 长轮询超时是"未扫码"的正常表现
      const msg = String(e);
      if (/timeout|abort/i.test(msg)) return { status: s.status === 'scanned' ? 'scanned' : 'waiting' };
      s.lastError = msg;
      logger.warn(`扫码轮询异常：${msg}`);
      return { status: 'failed', message: msg };
    }
  }

  /** 取消会话 */
  cancel(qrId: string): void {
    this.sessions.delete(qrId);
  }

  /** 从 unicast 的响应文本里提取 channel_v（兼容 JSON 与 callback(...) 两种形态） */
  private extractChannelV(text: string): string {
    if (!text) return '';
    const t = text.trim().replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
    try {
      const d = JSON.parse(t || '{}');
      if (d.errno === 0 && d.channel_v) return String(d.channel_v);
      // 部分实现直接把 v 放在顶层
      if (d.v) return String(d.v);
    } catch {
      /* 非 JSON，继续用正则兜底 */
    }
    const m = text.match(/"channel_v"\s*:\s*"((?:\\.|[^"\\])*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : '';
  }
}

export const qrLoginService = new QrLoginService();
