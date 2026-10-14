/**
 * 网盘（PanService）前端 API 封装。
 *
 * 对应后端 `/api/v1/pan/*`（apiRequest 会自动补 `/api` 前缀）。
 */
import { apiRequest as request } from '@/utils/request';

export interface IPanCredentialRow {
  driver: string;
  name?: string;
  /** 已脱敏 */
  cookie?: string;
  token?: string;
  enabled?: boolean;
  hasCredential?: boolean;
  updatedAt?: number;
}

export interface IPanQrCreate {
  qrId: string;
  /** data:image/png;base64,... */
  image: string;
  expiresIn: number;
  driver: string;
  hint?: string;
}

export interface IPanQrPoll {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'failed' | 'unsupported';
  message?: string;
  credential?: { driver: string; cookie: string };
  saved?: boolean;
  ok?: boolean;
}

/** 已注册驱动 */
export function fetchPanDrivers() {
  return request.request({ url: '/v1/pan/drivers', method: 'get' });
}

/** 凭据列表（脱敏） */
export function fetchPanCredentials() {
  return request.request({ url: '/v1/pan/credentials', method: 'get' });
}

/** 保存凭据 */
export function savePanCredential(doc: { driver: string; cookie?: string; token?: string; enabled?: boolean }) {
  return request.request({ url: '/v1/pan/credentials', method: 'post', data: doc });
}

/** 删除凭据（参数必须走 query：请求层会把非 GET 的 params 搬进 body） */
export function removePanCredential(driver: string) {
  return request.request({ url: `/v1/pan/credentials?driver=${encodeURIComponent(driver)}`, method: 'delete' });
}

/** 凭据自检（注意是 POST） */
export function checkPanCredential(driver: string) {
  return request.request({ url: '/v1/pan/check', method: 'post', data: { driver } });
}

/** 创建扫码会话，返回二维码 */
export function createPanQr(driver: string) {
  return request.request({ url: '/v1/pan/qr/create', method: 'post', data: { driver } });
}

/** 轮询扫码状态；save=false 时只取凭据不落库 */
export function pollPanQr(qrId: string, save = true) {
  return request.request({ url: '/v1/pan/qr/poll', method: 'get', params: { qrId, save: save ? '1' : '0' } });
}

/** 取消扫码会话（同上，参数走 query） */
export function cancelPanQr(qrId: string) {
  return request.request({ url: `/v1/pan/qr?qrId=${encodeURIComponent(qrId)}`, method: 'delete' });
}
