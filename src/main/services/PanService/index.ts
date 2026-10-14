/**
 * PanService —— 网盘解析服务入口。
 *
 * 职责：
 *   1. 注册各网盘驱动（夸克 / 百度 / …）
 *   2. 按链接自动分派到对应驱动
 *   3. 统一提供 request 上下文（超时、UA、日志）
 *   4. 凭据读写（委托给 panStore）
 *
 * 与 zyfun 爬虫体系的关系：由 `t3Pan` 适配器调用本服务，
 * 使「网盘资源站」的详情页链接可以直接解析成可播放直链。
 */
import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';

import quark from './drivers/quark';
import baidu from './drivers/baidu';
import { panStore } from './store';
import type { IPanContext, IPanDriver, IPanDriverId } from './types';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

/** 驱动注册表 */
const DRIVERS: IPanDriver[] = [quark, baidu];

const DRIVER_MAP = new Map<IPanDriverId, IPanDriver>(DRIVERS.map((d) => [d.id, d]));

export class PanService {
  /** 列出所有驱动 */
  listDrivers(): Array<{ id: IPanDriverId; name: string; fields: string[] }> {
    return DRIVERS.map((d) => ({ id: d.id, name: d.name, fields: d.credentialFields }));
  }

  /** 按 id 取驱动 */
  getDriver(id: IPanDriverId | string): IPanDriver | undefined {
    return DRIVER_MAP.get(id as IPanDriverId);
  }

  /** 按链接自动挑选驱动 */
  matchDriver(link: string): IPanDriver | undefined {
    return DRIVERS.find((d) => {
      try {
        return d.match(link);
      } catch {
        return false;
      }
    });
  }

  /** 构造驱动运行上下文 */
  async context(driverId: IPanDriverId): Promise<IPanContext> {
    const credential = await panStore.get(driverId);
    return {
      credential,
      request: async (options) => {
        const { request } = await import('@main/utils/request');
        const res = await request.request({
          url: options.url,
          method: (options.method as any) ?? 'GET',
          headers: options.headers,
          data: options.data,
          responseType: options.responseType ?? 'json',
          timeout: options.timeout ?? 15000,
        });
        return { status: res.status, headers: res.headers as any, data: res.data };
      },
      logger: {
        info: (m: string) => logger.info(m),
        warn: (m: string) => logger.warn(m),
        error: (m: string) => logger.error(m),
      },
    };
  }

  /** 解析分享链接（自动分派） */
  async resolve(link: string) {
    const driver = this.matchDriver(link);
    if (!driver) throw new Error(`暂不支持该网盘链接：${link}`);
    const ctx = await this.context(driver.id);
    return driver.resolve(link, ctx);
  }

  /** 取播放直链（自动分派） */
  async play(link: string, fileId: string, token?: string) {
    const driver = this.matchDriver(link);
    if (!driver) throw new Error(`暂不支持该网盘链接：${link}`);
    const ctx = await this.context(driver.id);
    // 同一驱动实例需先 resolve 建立会话（百度/夸克均依赖）
    const share = await driver.resolve(link, ctx);
    return driver.play(fileId, ctx, { shareUrl: link, title: share.title, token });
  }

  /** 凭据自检 */
  async check(driverId: IPanDriverId): Promise<boolean> {
    const driver = this.getDriver(driverId);
    if (!driver?.check) return false;
    const ctx = await this.context(driverId);
    return driver.check(ctx);
  }
}

export const panService = new PanService();
export { panStore };
export { qrLoginService } from './qrlogin';
export { panProxy, toProxyUrl } from './proxy';
export * from './types';
