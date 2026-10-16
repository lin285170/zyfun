/**
 * 网盘相关 API 路由（自动挂载为 `/api/v1/pan`）。
 *
 * GET  /api/v1/pan/proxy?token=xxx   直链代理（流式转发，注入网盘所需请求头）
 * GET  /api/v1/pan/drivers           列出已注册的网盘驱动
 * GET  /api/v1/pan/credentials       列出凭据（脱敏）
 * POST /api/v1/pan/credentials       保存凭据
 * DEL  /api/v1/pan/credentials       删除凭据
 * POST /api/v1/pan/check             凭据自检
 * POST /api/v1/pan/qr/create         创建扫码登录会话（返回二维码）
 * GET  /api/v1/pan/qr/poll?qrId=     轮询扫码状态（确认后回传凭据）
 * DEL  /api/v1/pan/qr?qrId=          取消扫码会话
 */
import { Buffer } from 'node:buffer';

import { panLoginWindowService, panProxy, panService, panStore, qrLoginService } from '@main/services/PanService';
import type { IPanDriverId, IPanPlayInfo } from '@main/services/PanService/types';
import { request } from '@main/utils/request';
import type { FastifyPluginAsync } from 'fastify';

const API_PREFIX = 'pan';

/**
 * 段缓存 + 多连接预取引擎（对齐 FongMi 的 wex）。
 *
 * 背景（2026-10-16 抓包实测）：百度**分享下载通道**（appall*.baidupcs.com）
 * 单连接只有 ~200~270KB/s，但 FongMi 用 8~17 条并发连接把聚合拉到 ~1.5MB/s
 * （127s 内 137 条连接、195MB）。播放器自身只会顺序拉少量 Range，
 * 提速必须由代理侧完成：文件切成 1MB 段，收到请求时**立即并行预取后续若干段**并缓存。
 */
const SEG_SIZE = 1048575;
const MAX_SEGS = 32; // 每 token 最多缓存 32 段（32MB）
const IDLE_MS = 60 * 1000; // 空闲超过此时长即停止预取并清理
const DEFAULT_MAX_UPSTREAM = 6;

interface ISegEntry {
  data?: Buffer;
  promise?: Promise<Buffer | null>;
}
interface IProxyState {
  segs: Map<number, ISegEntry>;
  total: number;
  lastIdx: number;
  lastReq: number;
  inflight: number;
  waiters: Array<() => void>;
}
const proxyStates = new Map<string, IProxyState>();

function getState(key: string): IProxyState {
  const now = Date.now();
  for (const [k, v] of proxyStates) {
    if (now - v.lastReq > IDLE_MS && v.inflight === 0) proxyStates.delete(k);
  }
  let st = proxyStates.get(key);
  if (!st) {
    st = { segs: new Map(), total: 0, lastIdx: -1, lastReq: now, inflight: 0, waiters: [] };
    proxyStates.set(key, st);
  }
  return st;
}

function acquireToken(st: IProxyState, limit: number): Promise<void> {
  if (st.inflight < limit) {
    st.inflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => st.waiters.push(resolve));
}
function releaseToken(st: IProxyState): void {
  const next = st.waiters.shift();
  if (next)
    next(); // 槽位直接移交，计数不变
  else st.inflight--;
}

/** 取一段：命中缓存直接返回；在途则等待；否则发起回源 */
function fetchSegment(entry: IPanPlayInfo, st: IProxyState, idx: number): Promise<Buffer | null> {
  const hit = st.segs.get(idx);
  if (hit?.data) return Promise.resolve(hit.data);
  if (hit?.promise) return hit.promise;

  const promise = (async (): Promise<Buffer | null> => {
    const limit = entry.maxUpstream ?? DEFAULT_MAX_UPSTREAM;
    await acquireToken(st, limit);
    try {
      const start = idx * SEG_SIZE;
      const res = await request.request({
        url: entry.url,
        method: 'GET',
        headers: { ...(entry.headers ?? {}), Range: `bytes=${start}-${start + SEG_SIZE}` },
        responseType: 'arraybuffer',
        timeout: 60000,
      });
      const buf = Buffer.from((res.data as ArrayBuffer) ?? new ArrayBuffer(0));
      const cr = String((res.headers as Record<string, unknown>)?.['content-range'] ?? '');
      const mm = cr.match(/\/(\d+)\s*$/);
      if (mm) st.total = Number(mm[1]);
      if (buf.length) {
        st.segs.set(idx, { data: buf });
        return buf;
      }
      st.segs.delete(idx);
      return null;
    } catch {
      st.segs.delete(idx);
      return null;
    } finally {
      releaseToken(st);
    }
  })();

  st.segs.set(idx, { promise });
  return promise;
}

/** 后台并行预取后续段（不阻塞当前响应） */
function prefetchAhead(entry: IPanPlayInfo, st: IProxyState, fromIdx: number): void {
  const depth = entry.prefetch ?? 6;
  const limit = entry.maxUpstream ?? DEFAULT_MAX_UPSTREAM;
  for (let i = fromIdx + 1; i <= fromIdx + depth; i++) {
    if (Date.now() - st.lastReq > IDLE_MS) return;
    if (st.total && i * SEG_SIZE >= st.total) return;
    const e = st.segs.get(i);
    if (e?.data || e?.promise) continue;
    if (st.inflight >= limit) return;
    void fetchSegment(entry, st, i);
  }
}

/** 超出上限时优先丢弃「离当前播放位置最远」的段 */
function evict(st: IProxyState): void {
  if (st.segs.size <= MAX_SEGS) return;
  const idxs = [...st.segs.keys()].sort((a, b) => Math.abs(b - st.lastIdx) - Math.abs(a - st.lastIdx));
  for (const i of idxs) {
    if (st.segs.size <= MAX_SEGS) break;
    const e = st.segs.get(i);
    if (e && !e.promise) st.segs.delete(i);
  }
}

const api: FastifyPluginAsync = async (fastify): Promise<void> => {
  /**
   * 直链代理：按 token 取回真实直链与请求头，流式转发。
   * 支持 Range 透传（播放器拖拽进度条必需）。
   */
  fastify.get<{ Querystring: { token?: string } }>(`/${API_PREFIX}/proxy`, async (req, reply) => {
    const token = req.query?.token;
    if (!token) return reply.code(400).send();
    const entry = panProxy.get(token);
    if (!entry) return reply.code(404).send('token expired or not found');

    // ⚠️ HEAD = 渲染层 checkPlayable 的媒体类型探测第一站，必须**不回源**立即应答：
    // 网盘免费线路回源拉首段要 20~40s，HEAD 跟着等必然拖垮探测超时 →
    // 判 unknown → 误走 CDP sniffer → 整个播放挂掉（实测 2026-10-15）。
    if (req.method === 'HEAD') {
      reply.header('Accept-Ranges', 'bytes');
      if (entry.contentType) reply.header('Content-Type', entry.contentType);
      return reply.code(200).send();
    }

    const st = getState(token);
    st.lastReq = Date.now();

    // Range 归一化：客户端无论给什么形态（无 Range / 开放区间 bytes=N- /
    // 显式大区间 bytes=0-8388607），一律只回**一段 1MB** —— 这样段内能直接命中
    // 预取缓存，同时规避 PCS 对开放区间的 403（实测 2026-10-15）。
    const rawRange = String(req.headers.range ?? '').trim();
    const m = rawRange.match(/^bytes=(\d+)-(\d*)$/i);
    let start = 0;
    let end = SEG_SIZE;
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), start + SEG_SIZE) : start + SEG_SIZE;
    }
    const t0 = Date.now();

    try {
      const firstIdx = Math.floor(start / SEG_SIZE);
      const lastIdx = Math.floor(end / SEG_SIZE);
      const parts: Buffer[] = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const buf = await fetchSegment(entry, st, i);
        if (!buf) throw new Error(`段 ${i} 拉取失败（客户端Range=${rawRange || '(无)'}）`);
        parts.push(buf);
      }
      const joined = Buffer.concat(parts);
      const offset = start - firstIdx * SEG_SIZE;
      const slice = joined.subarray(offset, offset + (end - start + 1));
      st.lastIdx = lastIdx;
      evict(st);

      // 自行给出响应头（分段拼装后不再透传回源头；content-type 用登记值覆盖
      // —— 百度 PCS 恒回 application/octet-stream，播放器与类型探测都要准确 MIME）
      reply.header('Accept-Ranges', 'bytes');
      if (entry.contentType) reply.header('content-type', entry.contentType);
      if (st.total) {
        reply.header('content-range', `bytes ${start}-${start + slice.length - 1}/${st.total}`);
      }
      reply.header('content-length', String(slice.length));

      fastify.log.info(
        `[pan-proxy] ${rawRange || '(无Range)'} → 段[${firstIdx}..${lastIdx}] ${slice.length}B ${Date.now() - t0}ms` +
          ` 缓存${st.segs.size}段/在途${st.inflight}`,
      );

      // 后台并行预取后续段（不 await，立即返回当前段）
      prefetchAhead(entry, st, lastIdx);
      return reply.code(206).send(slice);
    } catch (error) {
      fastify.log.error(`[pan-proxy] 失败 客户端Range=${rawRange || '(无)'} err=${(error as Error)?.message ?? error}`);
      return reply.code(502).send('proxy fetch failed');
    }
  });

  /** 驱动列表 */
  fastify.get(`/${API_PREFIX}/drivers`, async () => {
    return { code: 0, data: panService.listDrivers() };
  });

  /** 凭据列表（脱敏） */
  fastify.get(`/${API_PREFIX}/credentials`, async () => {
    return { code: 0, data: await panStore.list() };
  });

  /** 保存凭据 */
  fastify.post<{
    Body: { driver: IPanDriverId; cookie?: string; token?: string; refreshToken?: string; enabled?: boolean };
  }>(`/${API_PREFIX}/credentials`, async (req) => {
    const { driver, ...rest } = req.body ?? ({} as any);
    if (!driver) return { code: -1, msg: 'driver is required' };
    await panStore.set(driver, rest);
    return { code: 0, data: true };
  });

  /** 删除凭据（driver 支持 query 或 body 传入） */
  fastify.delete<{ Querystring: { driver?: string }; Body: { driver?: string } }>(
    `/${API_PREFIX}/credentials`,
    async (req) => {
      const driver = req.query?.driver ?? req.body?.driver;
      if (!driver) return { code: -1, msg: 'driver is required' };
      await panStore.remove(driver as IPanDriverId);
      return { code: 0, data: true };
    },
  );

  /** 凭据自检 */
  fastify.post<{ Body: { driver: IPanDriverId } }>(`/${API_PREFIX}/check`, async (req) => {
    const driver = req.body?.driver;
    if (!driver) return { code: -1, msg: 'driver is required' };
    const ok = await panService.check(driver);
    return { code: 0, data: { driver, ok } };
  });

  /** 创建扫码登录会话：返回二维码（base64 PNG） */
  fastify.post<{ Body: { driver: IPanDriverId } }>(`/${API_PREFIX}/qr/create`, async (req) => {
    const driver = req.body?.driver;
    if (!driver) return { code: -1, msg: 'driver is required' };
    const driverObj = panService.getDriver(driver);
    if (!driverObj) return { code: -1, msg: `未找到驱动：${driver}` };
    const ctx = await panService.context(driver);
    const data = await qrLoginService.create(driver, ctx);
    return { code: 0, data };
  });

  /** 轮询扫码状态；确认登录后回传凭据（调用方落库） */
  fastify.get<{ Querystring: { qrId?: string; save?: string } }>(`/${API_PREFIX}/qr/poll`, async (req) => {
    const qrId = req.query?.qrId;
    if (!qrId) return { code: -1, msg: 'qrId is required' };
    const ctx = await panService.context('baidu');
    const res = await qrLoginService.poll(qrId, ctx);
    // 默认自动落库，便于前端一步到位；传 save=0 可只取不存
    if (res.status === 'confirmed' && res.credential && req.query?.save !== '0') {
      await panStore.set(res.credential.driver, {
        driver: res.credential.driver,
        cookie: res.credential.cookie,
        enabled: true,
      });
      const ok = await panService.check(res.credential.driver).catch(() => false);
      return { code: 0, data: { ...res, saved: true, ok } };
    }
    return { code: 0, data: res };
  });

  /** 取消扫码会话（qrId 支持 query 或 body 传入） */
  fastify.delete<{ Querystring: { qrId?: string }; Body: { qrId?: string } }>(`/${API_PREFIX}/qr`, async (req) => {
    const qrId = req.query?.qrId ?? req.body?.qrId;
    if (qrId) qrLoginService.cancel(qrId);
    return { code: 0, data: true };
  });

  /**
   * 浏览器登录：打开独立窗口让用户在真实页面登录，自动抓取并保存 Cookie。
   * 夸克 / 百度通用，不依赖各平台不公开的扫码协议。
   */
  fastify.post<{ Body: { driver?: string } }>(`/${API_PREFIX}/login/start`, async (req) => {
    const driver = req.body?.driver;
    if (!driver) return { code: -1, msg: 'driver is required' };
    if (!panLoginWindowService.supports(driver)) return { code: -1, msg: `${driver} 暂不支持浏览器登录` };
    const loginId = panLoginWindowService.start(driver);
    return { code: 0, data: { loginId } };
  });

  /** 轮询浏览器登录状态 */
  fastify.get<{ Querystring: { loginId?: string } }>(`/${API_PREFIX}/login/poll`, async (req) => {
    const loginId = req.query?.loginId;
    if (!loginId) return { code: -1, msg: 'loginId is required' };
    return { code: 0, data: panLoginWindowService.poll(loginId) };
  });

  /** 取消浏览器登录（关闭窗口） */
  fastify.delete<{ Querystring: { loginId?: string }; Body: { loginId?: string } }>(
    `/${API_PREFIX}/login`,
    async (req) => {
      const loginId = req.query?.loginId ?? req.body?.loginId;
      if (loginId) panLoginWindowService.cancel(loginId);
      return { code: 0, data: true };
    },
  );
};

export default api;
