/**
 * 网盘「浏览器登录」服务。
 *
 * 打开一个独立的 Electron 浏览器窗口加载网盘登录页，用户在窗口内用任意方式
 * 登录（扫码 / 账号密码 / 短信），本服务在后台监听该窗口会话的 Cookie，
 * 一旦拿到关键凭据（夸克 `__pus`/`__puus`、百度 `BDUSS`）即自动保存并关闭窗口。
 *
 * 为什么用这种方式：
 *   - 各平台的扫码协议并不公开（夸克的 CAS 流程上游尚未实现），而「让用户
 *     在真实页面里登录、我们只读取 Cookie」对任意网盘都通用；
 *   - 窗口使用独立 partition，不会污染应用主会话，用户也可随时手动关闭。
 */
import { randomUUID } from 'node:crypto';

import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';
import { BrowserWindow, session as electronSession } from 'electron';

import { panStore } from './store';
import type { IPanDriverId } from './types';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

/** 各网盘的登录入口 */
const LOGIN_URL: Record<string, string> = {
  quark: 'https://pan.quark.cn/',
  baidu: 'https://pan.baidu.com/',
};

/** 判定「已登录」的关键 Cookie（全部命中才算成功） */
const REQUIRED_COOKIES: Record<string, string[]> = {
  quark: ['__pus', '__puus'],
  baidu: ['BDUSS'],
};

/** 保存凭据时只收集该域名下的 Cookie，避免混入无关站点 */
const COOKIE_DOMAIN_KEYWORD: Record<string, string> = {
  quark: 'quark',
  baidu: 'baidu',
};

/** 会话有效期：5 分钟未完成登录即视为超时 */
const SESSION_TTL_MS = 5 * 60 * 1000;
/** Cookie 轮询间隔 */
const POLL_INTERVAL_MS = 1500;

export type PanLoginStatus = 'waiting' | 'success' | 'expired' | 'failed' | 'unsupported';

export interface IPanLoginPollResult {
  status: PanLoginStatus;
  message?: string;
}

interface ILoginSession {
  id: string;
  driver: string;
  createdAt: number;
  status: PanLoginStatus;
  message?: string;
  window: BrowserWindow | null;
  timer: ReturnType<typeof setInterval> | null;
}

class PanLoginWindowService {
  private sessions = new Map<string, ILoginSession>();

  /** 该网盘是否支持浏览器登录 */
  supports(driver: string): boolean {
    return !!LOGIN_URL[driver];
  }

  /** 打开登录窗口，返回会话 id（异步，需轮询） */
  start(driver: string, parent?: BrowserWindow | null): string {
    if (!this.supports(driver)) {
      throw new Error(`${driver} 暂不支持浏览器登录`);
    }

    // 同一网盘只保留一个登录会话，避免窗口叠加
    for (const s of this.sessions.values()) {
      if (s.driver === driver && s.status === 'waiting') this.cancel(s.id);
    }

    const ses = electronSession.fromPartition(`persist:panlogin-${driver}`);
    const win = new BrowserWindow({
      width: 1080,
      height: 780,
      title: '登录网盘（完成后窗口会自动关闭）',
      autoHideMenuBar: true,
      show: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const id = randomUUID();
    const loginSession: ILoginSession = {
      id,
      driver,
      createdAt: Date.now(),
      status: 'waiting',
      window: win,
      timer: null,
    };
    this.sessions.set(id, loginSession);

    win.loadURL(LOGIN_URL[driver]).catch((error) => {
      logger.error(`网盘登录页加载失败：${(error as Error)?.message}`);
      loginSession.status = 'failed';
      loginSession.message = `登录页加载失败：${(error as Error)?.message}`;
    });

    win.on('closed', () => {
      this.stopTimer(loginSession);
      loginSession.window = null;
      if (loginSession.status === 'waiting') {
        loginSession.status = 'failed';
        loginSession.message = '登录窗口已关闭，未获取到凭据';
      }
    });

    loginSession.timer = setInterval(() => {
      this.check(loginSession).catch((error) => {
        logger.warn(`网盘登录 Cookie 检查失败：${(error as Error)?.message}`);
      });
    }, POLL_INTERVAL_MS);

    return id;
  }

  /** 轮询登录状态 */
  poll(id: string): IPanLoginPollResult {
    const s = this.sessions.get(id);
    if (!s) return { status: 'failed', message: '登录会话不存在或已结束' };
    return { status: s.status, message: s.message };
  }

  /** 取消会话（关闭窗口） */
  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.stopTimer(s);
    if (s.window && !s.window.isDestroyed()) s.window.close();
    s.window = null;
    this.sessions.delete(id);
  }

  private stopTimer(s: ILoginSession): void {
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  /** 检查 Cookie，命中关键凭据则保存并关闭窗口 */
  private async check(s: ILoginSession): Promise<void> {
    if (s.status !== 'waiting') return;

    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      s.status = 'expired';
      s.message = '登录超时（5 分钟），请重试';
      this.cancel(s.id);
      return;
    }

    if (!s.window || s.window.isDestroyed()) return;

    const all = await s.window.webContents.session.cookies.get({});
    const keyword = COOKIE_DOMAIN_KEYWORD[s.driver] ?? '';
    const mine = all.filter((c) => String(c.domain ?? '').includes(keyword));
    const map = new Map(mine.map((c) => [c.name, c.value]));

    const required = REQUIRED_COOKIES[s.driver] ?? [];
    const ok = required.length > 0 && required.every((name) => map.get(name));
    if (!ok) return;

    const cookie = mine.map((c) => `${c.name}=${c.value}`).join('; ');
    await panStore.set(s.driver as IPanDriverId, {
      driver: s.driver as IPanDriverId,
      cookie,
      enabled: true,
    });

    s.status = 'success';
    s.message = '登录成功，凭据已保存';
    logger.info(`网盘浏览器登录成功：${s.driver}`);
    this.cancel(s.id);
  }
}

export const panLoginWindowService = new PanLoginWindowService();
