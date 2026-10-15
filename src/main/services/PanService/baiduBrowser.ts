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

/** 过验结果缓存：shareUrl → { randsk, cookie } */
const RANDSK_CACHE = new Map<string, { randsk: string; cookie: string }>();

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
  /** 页面是否已加载完成（避免抓到瞬态 Cookie） */
  loaded: boolean;
  window: BrowserWindow | null;
  timer: ReturnType<typeof setInterval> | null;
}

class BaiduBrowserService {
  private sessions = new Map<string, IVerifySession>();

  /** 是否已有该分享的 randsk 缓存 */
  getCachedRandsk(shareUrl: string): string {
    return RANDSK_CACHE.get(shareUrl)?.randsk ?? '';
  }

  /**
   * 取与该 randsk **配套**的完整 Cookie。
   *
   * 实测结论：BDCLND 与「取得它的那套 Cookie」强绑定 —— 把它拿到另一套 Cookie 下使用，
   * 服务端一律返回 errno=-9（即便同为一个账号）。因此 driver 必须改用这里的实时 Cookie，
   * 而不是 pan-credentials.json 里登录时保存的快照。
   */
  getCachedCookie(shareUrl: string): string {
    return RANDSK_CACHE.get(shareUrl)?.cookie ?? '';
  }

  hasCached(shareUrl: string): boolean {
    return RANDSK_CACHE.has(shareUrl);
  }

  /** 清除某个分享的缓存（用于丢弃无效 randsk，强制重新过验） */
  clearCache(shareUrl: string): void {
    RANDSK_CACHE.delete(shareUrl);
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
      loaded: false,
      window: win,
      timer: null,
    };
    this.sessions.set(id, vs);

    // 页面加载完成前不下结论：百度在跳转过程中也可能写入占位 Cookie
    win.webContents.on('did-finish-load', () => {
      vs.loaded = true;
    });

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
    // 等待页面真正加载完成，避免把跳转过程中的占位 Cookie 当成有效凭据
    if (!s.loaded) return;

    // 以「页面自身视角」取凭据：实测发现页面里的 BDCLND 往往是 host-only
    // （挂在 pan.baidu.com），用 session.cookies.get({domain:'.baidu.com'}) 取不到同一个值，
    // 会拿到空值或失效值，表现为后续 share/list 报 errno=-9。
    const probe = await s.window.webContents
      .executeJavaScript(
        `(function(){try{
          var m = document.cookie.match(/(?:^|;\\s*)BDCLND=([^;]*)/);
          return JSON.stringify({
            url: location.href.slice(0,150),
            bdclnd: m ? m[1] : '',
            shown: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,140)
          });
        }catch(e){return '';}})()`,
      )
      .catch(() => '');

    if (!probe) return;

    let page: { url?: string; bdclnd?: string; shown?: string };
    try {
      page = JSON.parse(probe);
    } catch {
      return;
    }

    const pageUrl = String(page.url ?? '');
    // 被重定向到登录页 → 登录态失效，明确告知用户
    if (pageUrl.includes('/login')) {
      s.status = 'failed';
      s.message = '百度登录态已失效，请先在「网盘账号」中重新登录百度';
      this.cancel(s.id);
      return;
    }

    const raw = String(page.bdclnd ?? '').trim();
    if (!raw) return;

    // 注意：driver 侧是「原样拼回 Cookie」（withRandsk 直接 `BDCLND=${randsk}`），
    // 故这里必须使用 document.cookie 的原始形式，不能再做 decodeURIComponent。
    // 同时把该分区的**完整实时 Cookie** 一并取回：BDCLND 与这套 Cookie 是配套的，
    // 只带走 BDCLND 而用别处的快照 Cookie 会一律被判 errno=-9。
    let cookieStr = '';
    try {
      const all = await s.window.webContents.session.cookies.get({});
      cookieStr = all
        .filter((c) => c.name && c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    } catch {
      /* 取不到则退回 driver 自带 Cookie */
    }

    logger.info(
      `[baidu-window] 已从页面取得 BDCLND（长度 ${raw.length}，前 24 字符=${raw.slice(0, 24)}，含%编码=${/%[0-9A-F]{2}/i.test(raw)}），同步 Cookie ${cookieStr.split(';').length} 项`,
    );
    RANDSK_CACHE.set(s.shareUrl, { randsk: raw, cookie: cookieStr });
    s.randsk = raw;
    s.status = 'success';
    s.message = '校验成功，已获取提取码凭据';
    this.cancel(s.id);
  }
}

export const baiduBrowserService = new BaiduBrowserService();
