/**
 * 网盘凭据存储。
 *
 * 刻意不复用 DbService（避免动 SQLite schema 与迁移），改用独立 JSON 文件，
 * 位置与 zyfun 主数据目录一致：
 *   Windows  %USERPROFILE%\AppData\Roaming\zyfun\pan-credentials.json
 *   macOS    ~/Library/Application Support/zyfun/pan-credentials.json
 *   Linux    ~/.config/zyfun/pan-credentials.json
 *
 * 安全性说明：Cookie/token 为明文存储，仅落在本机用户目录。
 * 若需更强保护，可后续接入系统钥匙串（keytar）——接口已按 kv 设计，替换成本低。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';

import { panDriverIds, type IPanCredential, type IPanDriverId } from './types';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);
const FILE_NAME = 'pan-credentials.json';

type StoreShape = Record<string, IPanCredential>;

class PanStore {
  private cache: StoreShape | null = null;

  private file(): string {
    return path.join(app.getPath('userData'), FILE_NAME);
  }

  private load(): StoreShape {
    if (this.cache) return this.cache;
    try {
      const p = this.file();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        this.cache = typeof data === 'object' && data ? (data as StoreShape) : {};
      } else {
        this.cache = {};
      }
    } catch (e) {
      logger.warn('读取网盘凭据失败，使用空配置', { err: String(e) });
      this.cache = {};
    }
    return this.cache!;
  }

  private persist(): void {
    try {
      const p = this.file();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(this.cache ?? {}, null, 2), 'utf-8');
    } catch (e) {
      logger.error('写入网盘凭据失败', { err: String(e) });
    }
  }

  /** 取某网盘凭据 */
  async get(driver: IPanDriverId): Promise<IPanCredential> {
    const all = this.load();
    return (
      all[driver] ?? {
        driver,
        enabled: false,
      }
    );
  }

  /** 列出全部凭据（脱敏：不回传完整 cookie/token） */
  async list(): Promise<Array<IPanCredential & { hasCredential: boolean }>> {
    const all = this.load();
    return panDriverIds.map((id) => {
      const c = all[id];
      const has = Boolean(c?.cookie || c?.token);
      return {
        ...(c ?? { driver: id }),
        driver: id,
        cookie: has && c?.cookie ? this.mask(c.cookie) : undefined,
        token: has && c?.token ? this.mask(c.token) : undefined,
        hasCredential: has,
      };
    });
  }

  /** 保存凭据 */
  async set(driver: IPanDriverId, credential: Partial<IPanCredential>): Promise<void> {
    const all = this.load();
    const prev = all[driver] ?? { driver };
    all[driver] = {
      ...prev,
      ...credential,
      driver,
      updatedAt: Date.now(),
    };
    this.persist();
    logger.info(`网盘凭据已更新：${driver}`);
  }

  /** 删除凭据 */
  async remove(driver: IPanDriverId): Promise<void> {
    const all = this.load();
    delete all[driver];
    this.persist();
  }

  /** 脱敏显示 */
  private mask(v: string): string {
    if (v.length <= 12) return '****';
    return `${v.slice(0, 6)}…${v.slice(-4)}`;
  }
}

export const panStore = new PanStore();
