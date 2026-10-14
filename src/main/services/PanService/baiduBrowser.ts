/**
 * 百度分享「浏览器过验」服务。
 *
 * 背景：新版百度分享页的提取码校验引入了 `pwd_enc` 混淆 + 时间戳签名 +
 * 客户端指纹（`X-Requested-With` 等），纯 HTTP 复现成本高且随改版失效
 * （实测 `/share/verify` 恒返 `errno=9019 params error`）。
 *
 * 本服务改用真实浏览器环境：复用**已登录的** `panlogin-baidu` 分区打开分享页
 * （URL 自带 `?pwd=` 时百度会自行完成校验），页面校验成功后会在会话中下发
 * `BDCLND` Cookie —— 这正是 `share/list` 与 `share/transfer` 所需的 randsk。
 * 取到后即缓存到内存，供 driver 直接使用，从而走通
 * 「API 转存 → PCS locatedownload 直链」这条已实现好的链路。
 */
import { randomUUID } from 'node:crypto';

import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';
import { BrowserWindow, session as electronSession } from 'electron';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

const HOST = 'https://pan.baidu.com';
/** 与浏览器登录共用的分区，确保带登录态 */
const PARTITION = 'persist:panlogin-baidu';

/** 过验结果缓存：shareUrl → randsk(BDCLND) */
const RANDSK_CACHE = new Map<string, string>();

const SESSION_TTL_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 1200;

export type IBaiduVerifyStatus = 'waiting' | 'success' | 'expired' | 'failed';

export interface IBaiduVerifyPollResult {
  status: IBaiduVerifyStatus;
  message?: string;
  randsk?: string;
}

interface IVerifySession {
  id: string;
  shareUrl: string;
  createdAt: number;
  status: IBaiduVerifyStatus;
  message?: string;
  randsk?: string;
  window: BrowserWindow | null;
  timer: ReturnType<typeof setInterval> | null;
}

class BaiduBrowserService {
  private sessions = new Map<string, IVerifySession>();

  /** 是否已有该分享的 randsk 缓存 */
  getCachedRandsk(shareUrl: string): string {
    return RANDSK_CACHE.get(shareUrl) ?? '';
  }

  hasCached(shareUrl: string): boolean {
    return RANDSK_CACHE.has(shareUrl);
  }

  /** 打开分享页并等待校验完成，返回会话 id（异步，需轮询） */
  start(shareUrl: string, pwd: string, parent?: BrowserWindow | null): string {
    // 已有缓存则不必再开窗
    if (RANDSK_CACHE.has(shareUrl)) return '';

    // 同一分享只保留一个会话
    for (const s of this.sessions.values()) {
      if (s.shareUrl === shareUrl && s.status === 'waiting') return s.id;
    }

    const m = shareUrl.match(/\/s\/([\w-]+)/);
    const surlFull = m?.[1] ?? '';
    const url = `${HOST}/s/${surlFull}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ''}`;

    const ses = electronSession.fromPartition(PARTITION);
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: '百度网盘 - 校验分享（完成后窗口会自动关闭）',
      autoHideMenuBar: true,
      show: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
    });

    const id = randomUUID();
    const vs: IVerifySession = {
      id,
      shareUrl,
      createdAt: Date.now(),
      status: 'waiting',
      window: win,
      timer: null,
    };
    this.sessions.set(id, vs);

    win.loadURL(url).catch((error) => {
      vs.status = 'failed';
      vs.message = `分享页加载失败：${(error as Error)?.message}`;
      logger.error(`百度分享页加载失败：${(error as Error)?.message}`);
    });

    win.on('closed', () => {
      this.stopTimer(vs);
      vs.window = null;
      if (vs.status === 'waiting') {
        vs.status = 'failed';
        vs.message = '窗口已关闭，未取到分享校验信息';
      }
    });

    vs.timer = setInterval(() => {
      this.check(vs).catch(() => {
        /* 单次失败忽略 */
      });
    }, POLL_INTERVAL_MS);

    return id;
  }

  poll(id: string): IBaiduVerifyPollResult {
    const s = this.sessions.get(id);
    if (!s) return { status: 'failed', message: '校验会话不存在或已结束' };
    return { status: s.status, message: s.message, randsk: s.randsk };
  }

  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.stopTimer(s);
    if (s.window && !s.window.isDestroyed()) s.window.close();
    s.window = null;
    this.sessions.delete(id);
  }

  private stopTimer(s: IVerifySession): void {
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  /** 轮询会话 Cookie，命中 BDCLND 即视为校验成功 */
  private async check(s: IVerifySession): Promise<void> {
    if (s.status !== 'waiting') return;

    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      s.status = 'expired';
      s.message = '校验超时（3 分钟），请重试';
      this.cancel(s.id);
      return;
    }
    if (!s.window || s.window.isDestroyed()) return;

    const all = await s.window.webContents.session.cookies.get({ domain: '.baidu.com' });
    const bdclnd = all.find((c) => c.name === 'BDCLND');
    if (!bdclnd?.value) return;

    const randsk = decodeURIComponent(bdclnd.value).trim();
    if (!randsk) return;

    RANDSK_CACHE.set(s.shareUrl, randsk);
    s.randsk = randsk;
    s.status = 'success';
    s.message = '校验成功，已获取提取码凭据';
    logger.info(`百度分享过验成功：${s.shareUrl}`);
    this.cancel(s.id);
  }
}

export const baiduBrowserService = new BaiduBrowserService();
