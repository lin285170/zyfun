/**
 * 网盘链接 → 可播放代理直链。
 *
 * 对应 FongMi 由 `libwexproxy.so`（客户端内置 SO 库）完成的
 * 「网盘链接识别 → 解析 → 本地代理」链路：本模块把同等能力暴露给
 * drpy / py 等「网页解析型」源 —— 只要源返回的播放地址命中网盘分享链接，
 * 主进程就会用 PanService 解析出直链，再经 `/v1/pan/proxy` 令牌代理输出。
 *
 * 播放 id 约定（供 drpy 源二级列表使用）：
 *   pan://<base64url(shareUrl)>|<fileId>
 * 当无法拿到具体文件（只需播放整包第一个媒体文件）时也可直接传原始分享链接。
 */
import { Buffer } from 'node:buffer';

import { panService } from '@main/services/PanService';
import { toProxyUrl } from '@main/services/PanService/proxy';
import type { IPanFile, IPanPlayInfo } from '@main/services/PanService/types';
import { PREFIX_API } from '@shared/config/env';

/** 可被 PanService 处理的网盘分享链接（与 types.ts 的 PAN_LINK_RE 保持一致） */
export const PAN_SHARE_RE =
  /https?:\/\/(?:pan\.quark\.cn|pan\.baidu\.com|www\.123pan\.com|www\.alipan\.com|aliyundrive\.com|www\.aliyundrive\.com|115\.com|anxia\.com)\/[^\s"'<>|]*/i;

const VIDEO_EXT_RE = /\.(?:mp4|mkv|avi|flv|mov|ts|m2ts|m4v|wmv|rmvb|webm|mp3|m4a|flac|wav|ass|srt)$/i;

export function extractPanShareUrl(text: string): string {
  const m = String(text ?? '').match(PAN_SHARE_RE);
  return m ? m[0] : '';
}

export function isPanShareUrl(url: string): boolean {
  return /^https?:\/\//i.test(String(url ?? '')) && PAN_SHARE_RE.test(url);
}

export function isPanPlayId(id: string): boolean {
  return String(id ?? '').startsWith('pan://');
}

/** 编码播放 id */
export function encodePanPlayId(shareUrl: string, fileId: string): string {
  const b64 = Buffer.from(shareUrl, 'utf8').toString('base64url');
  return `pan://${b64}|${fileId}`;
}

/** 解码播放 id */
export function decodePanPlayId(id: string): { shareUrl: string; fileId: string } {
  const raw = String(id).slice('pan://'.length);
  const idx = raw.lastIndexOf('|');
  const b64 = idx >= 0 ? raw.slice(0, idx) : raw;
  const fileId = idx >= 0 ? raw.slice(idx + 1) : '';
  const shareUrl = Buffer.from(b64, 'base64url').toString('utf8');
  return { shareUrl, fileId };
}

/** 展平文件树 */
export function flattenPanFiles(files: IPanFile[], out: IPanFile[] = []): IPanFile[] {
  for (const f of files ?? []) {
    if (f.isDir) flattenPanFiles(f.children ?? [], out);
    else out.push(f);
  }
  return out;
}

/** 是否为可播放的媒体文件 */
export function isPanMediaFile(name: string): boolean {
  return VIDEO_EXT_RE.test(String(name ?? ''));
}

export interface IPanMediaList {
  title: string;
  driver: string;
  /** 媒体文件（保持网盘内原始顺序） */
  files: IPanFile[];
}

/** 解析分享链接，返回其中的媒体文件列表 */
export async function listPanMedia(shareUrl: string): Promise<IPanMediaList> {
  const share = await panService.resolve(shareUrl);
  const all = flattenPanFiles(share.files);
  const media = all.filter((f) => isPanMediaFile(f.name));
  return {
    title: share.title || '',
    driver: share.driver,
    files: media.length ? media : all,
  };
}

/** 把网盘文件解析为经令牌代理的可播放直链 */
export async function panFileToProxyUrl(shareUrl: string, fileId?: string): Promise<string> {
  const share = await panService.resolve(shareUrl);
  const all = flattenPanFiles(share.files);
  if (!all.length) throw new Error('网盘分享内没有文件');

  const media = all.filter((f) => isPanMediaFile(f.name));
  const pool = media.length ? media : all;
  const target = (fileId && pool.find((f) => f.fileId === fileId)) || pool[0];
  if (!target) throw new Error('网盘分享内未找到媒体文件');

  const driver = panService.getDriver(share.driver);
  if (!driver) throw new Error(`未找到网盘驱动：${share.driver}`);

  const ctx = await panService.context(driver.id);
  const info: IPanPlayInfo = await driver.play(target.fileId, ctx, {
    shareUrl,
    title: share.title,
    token: target.token ?? '',
  });

  return toProxyUrl(PREFIX_API || 'http://127.0.0.1:9978/api', info);
}

/**
 * 统一入口：把播放参数解析成可播放直链。
 *
 * 支持三种入参：
 *   1. pan://<b64>|<fileId>   —— 源二级列表生成的标准格式
 *   2. 网盘分享链接本身         —— 直接播放分享内第一个媒体文件
 *   3. 其它                    —— 返回空串，交由调用方走原逻辑
 */
export async function resolvePanPlay(play: string): Promise<string> {
  if (isPanPlayId(play)) {
    const { shareUrl, fileId } = decodePanPlayId(play);
    return panFileToProxyUrl(shareUrl, fileId);
  }
  if (isPanShareUrl(play)) {
    return panFileToProxyUrl(extractPanShareUrl(play));
  }
  return '';
}
