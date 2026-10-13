/**
 * 网盘直链代理。
 *
 * 为什么需要：网盘直链（夸克/百度）必须携带 `Referer` / `User-Agent` /
 * 有时还有 `Cookie`，播放器直连会 403。zyfun 现有 `/proxy` 只支持 `?url=`，
 * 不做请求头透传，因此单独实现。
 *
 * 安全设计：**不把凭据放进 URL**（否则会出现在日志/历史里）。
 * 改为「令牌 → {url, headers}」服务端映射：
 *   play() 生成随机 token 并登记，返回 `{base}/v1/pan/proxy?token=xxx`；
 *   代理路由按 token 取回真实直链与请求头，再流式转发给播放器。
 */
import { randomUUID } from 'node:crypto';

import type { IPanPlayInfo } from './types';

interface IProxyEntry extends IPanPlayInfo {
  createdAt: number;
}

/** 令牌有效期（毫秒）。网盘直链本身也有 TTL，这里略短以避免用到失效链接。 */
const TTL = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

class PanProxy {
  private map = new Map<string, IProxyEntry>();

  /** 登记一条直链，返回可用于播放的令牌 */
  register(info: IPanPlayInfo): string {
    this.sweep();
    const token = randomUUID().replace(/-/g, '');
    this.map.set(token, { ...info, createdAt: Date.now() });
    return token;
  }

  /** 取回直链信息 */
  get(token: string): IPanPlayInfo | undefined {
    const e = this.map.get(token);
    if (!e) return undefined;
    if (Date.now() - e.createdAt > TTL) {
      this.map.delete(token);
      return undefined;
    }
    return e;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.createdAt > TTL) this.map.delete(k);
    }
    // 简单容量控制：超限时删最旧的
    if (this.map.size > MAX_ENTRIES) {
      const keys = [...this.map.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).map(([k]) => k);
      for (const k of keys.slice(0, this.map.size - MAX_ENTRIES)) this.map.delete(k);
    }
  }
}

export const panProxy = new PanProxy();

/**
 * 把 play() 的结果包装成「可交给播放器的代理地址」。
 * @param base 形如 `http://127.0.0.1:12345`（zyfun 内置服务地址）
 */
export function toProxyUrl(base: string, info: IPanPlayInfo): string {
  const token = panProxy.register(info);
  return `${base.replace(/\/$/, '')}/v1/pan/proxy?token=${token}`;
}
