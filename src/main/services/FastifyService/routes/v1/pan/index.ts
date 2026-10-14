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

import { panProxy, panService, panStore, qrLoginService } from '@main/services/PanService';
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

    try {
      const headers: Record<string, string> = { ...(entry.headers ?? {}) };
      // 透传 Range，保证拖动可用
      const range = req.headers.range;
      if (range) headers.Range = String(range);

      const res = await request.request({
        url: entry.url,
        method: 'GET',
        headers,
        responseType: 'arraybuffer',
        timeout: 60000,
      });

      // 回传关键响应头
      const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      for (const k of pass) {
        const v = (res.headers as any)?.[k];
        if (v != null) reply.header(k, String(v));
      }
      if (!reply.getHeader('accept-ranges')) reply.header('Accept-Ranges', 'bytes');

      const status = range ? 206 : (res.status ?? 200);
      return reply.code(status).send(Buffer.from(res.data as ArrayBuffer));
    } catch (error) {
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
};

export default api;
