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
import type { IPanDriverId } from '@main/services/PanService/types';
import { request } from '@main/utils/request';
import type { FastifyPluginAsync } from 'fastify';

const API_PREFIX = 'pan';

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

    try {
      const headers: Record<string, string> = { ...(entry.headers ?? {}) };
      // ⚠️ Range 归一化（决定播放器能否首包成功）：
      //   - 无 Range / 非标准       → 回源闭合首段 bytes=0-(SEG)；
      //   - **开放区间 bytes=N-**（Chromium video 标签首包就是这个！）
      //     → 转成闭合 bytes=N-(N+SEG)。实测 PCS 直链对开放区间一律 403，
      //       播放器会卡在黑屏转圈（2026-10-15 GUI 实测铁证）；
      //   - 显式闭合区间**夹紧到最多 SEG**（播放器会发 bytes=0-8388607 这类大区间，
      //     原样透传在免费线路必超时）。
      // 段长 1MB：免费线路实测 ~135KB/s，4MB 段单请求就要 30s+（FongMi 同为 1024KB）。
      const SEG = 1048575;
      const rawRange = String(req.headers.range ?? '').trim();
      const m = rawRange.match(/^bytes=(\d+)-(\d*)$/i);
      if (!rawRange || !m) {
        headers.Range = `bytes=0-${SEG}`;
      } else {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), start + SEG) : start + SEG;
        headers.Range = `bytes=${start}-${end}`;
      }
      const t0 = Date.now();
      fastify.log.info(`[pan-proxy] ${req.method} 客户端Range=${rawRange || '(无)'} → 回源 ${headers.Range}`);

      const res = await request.request({
        url: entry.url,
        method: 'GET',
        headers,
        responseType: 'arraybuffer',
        // 免费线路单段 1MB 约 8s；播放器并发时可能翻数倍，给足余量
        timeout: 180000,
      });
      fastify.log.info(
        `[pan-proxy] 完成 ${headers.Range} → ${res.status} ${(res.data as ArrayBuffer)?.byteLength ?? 0}B ${Date.now() - t0}ms`,
      );

      // 回传关键响应头
      const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      for (const k of pass) {
        const v = (res.headers as any)?.[k];
        if (v != null) reply.header(k, String(v));
      }
      if (!reply.getHeader('accept-ranges')) reply.header('Accept-Ranges', 'bytes');
      // 回源 content-type 缺失或是 octet-stream 时，用登记的媒体类型覆盖
      // （百度 PCS 恒回 application/octet-stream，播放器与类型探测都需要准确 MIME）
      const ct = String(reply.getHeader('content-type') ?? '');
      if (entry.contentType && (!ct || ct.includes('octet-stream'))) {
        reply.header('content-type', entry.contentType);
      }

      // 一律转发回源的 206/200（我们始终带闭合 Range 回源，正常是 206）
      const status = res.status ?? 200;
      return reply.code(status).send(Buffer.from(res.data as ArrayBuffer));
    } catch (error) {
      fastify.log.error(
        `[pan-proxy] 失败 客户端Range=${req.headers.range ?? '(无)'} err=${(error as Error)?.message ?? error}`,
      );
      fastify.log.error(error);
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
