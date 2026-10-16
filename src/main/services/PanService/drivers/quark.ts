/**
 * 夸克网盘（pan.quark.cn）驱动。
 *
 * 链路（drive-pc.quark.cn，PC 端接口）：
 *   分享链接 https://pan.quark.cn/s/{pwd_id}
 *     ① POST /1/clouddrive/share/sharepage/token      → stoken（匿名可得）
 *     ② GET  /1/clouddrive/share/sharepage/detail     → 文件列表（pdir_fid 递归）
 *     ③ POST /1/clouddrive/share/sharepage/save       → 转存到本人网盘（需登录）
 *     ④ POST /1/clouddrive/file/download              → 取直链（需登录）
 *
 * 凭据：Cookie 中的 `__puus` / `__uid`（登录后从浏览器或夸克客户端导出）。
 * 无登录态时 ①② 可读，③④ 会返回 31001（未登录）。
 */
import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';

import type { IPanContext, IPanDriver, IPanFile, IPanPlayInfo, IPanShareResult } from '../types';
import { PAN_DRIVER_ID } from '../types';

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

const API = 'https://drive-pc.quark.cn/1/clouddrive';
const REFERER = 'https://pan.quark.cn/';
/**
 * 必须使用「夸克 PC 客户端」UA。
 *
 * 夸克按 UA 判定客户端类型：浏览器 UA 请求 `/file/download` 时，对大文件会直接
 * 返回 HTTP 400 + `23018 download file size limit`（实测 209MB 即被拒，而本站资源
 * 普遍 800MB~2GB）；换成 PC 客户端 UA 后同一文件立刻返回 code=0 与直链。
 * 这也是 FongMi 等客户端能播同一账号大文件的原因（其 wex 代理同样伪装 PC 客户端）。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/110.0.5481.181 Electron/23.1.7 Safari/537.36';

/** 常见分享域名 */
const LINK_RES = [
  /https?:\/\/pan\.quark\.cn\/s\/([0-9a-z]+)/i,
  /https?:\/\/pan\.quark\.cn\/s\/([0-9a-z]+)\?pwd=([0-9a-z]+)/i,
];

interface IQuarkListItem {
  fid: string;
  file_name: string;
  dir: boolean;
  size: number;
  pdir_fid?: string;
}

class QuarkDriver implements IPanDriver {
  id = PAN_DRIVER_ID.QUARK;
  name = '夸克网盘';
  credentialFields: IPanDriver['credentialFields'] = ['cookie'];

  match(link: string): boolean {
    return LINK_RES.some((re) => re.test(link || ''));
  }

  private parse(link: string): { pwdId: string; passcode: string } {
    const m1 = link.match(/\/s\/([0-9a-z]+)\?pwd=([0-9a-z]+)/i);
    if (m1) return { pwdId: m1[1], passcode: m1[2] };
    const m2 = link.match(/\/s\/([0-9a-z]+)/i);
    if (m2) return { pwdId: m2[1], passcode: '' };
    throw new Error('无法从链接中解析夸克分享 ID');
  }

  private headers(ctx: IPanContext): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: REFERER.replace(/\/$/, ''),
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    };
    if (ctx.credential?.cookie) h.Cookie = ctx.credential.cookie;
    return h;
  }

  /** ① 取 stoken */
  private async getStoken(pwdId: string, passcode: string, ctx: IPanContext): Promise<string> {
    const res = await ctx.request({
      url: `${API}/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=`,
      method: 'POST',
      headers: this.headers(ctx),
      data: { pwd_id: pwdId, passcode },
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.code !== 0 || !d.data?.stoken) {
      throw new Error(`夸克 stoken 获取失败：code=${d.code} msg=${d.message ?? ''}（分享可能已失效或需要提取码）`);
    }
    return d.data.stoken as string;
  }

  /** ② 列出目录（递归） */
  private async listDir(
    pwdId: string,
    stoken: string,
    pdirFid: string,
    ctx: IPanContext,
    depth: number,
  ): Promise<IPanFile[]> {
    if (depth > 4) return [];
    const out: IPanFile[] = [];
    let page = 1;
    // 单页 100，最多取 5 页，避免异常分享导致失控
    while (page <= 5) {
      const qs = new URLSearchParams({
        pr: 'ucpro',
        fr: 'pc',
        pwd_id: pwdId,
        stoken,
        pdir_fid: pdirFid,
        force: '0',
        _page: String(page),
        _size: '100',
        _fetch_banner: '0',
        _fetch_share: '0',
        _fetch_total: '1',
        _sort: 'file_type:asc,updated_at:desc',
      });
      const res = await ctx.request({
        url: `${API}/share/sharepage/detail?${qs.toString()}`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      const d = res.data ?? {};
      if (d.code !== 0) {
        throw new Error(`夸克文件列表获取失败：code=${d.code} msg=${d.message ?? ''}`);
      }
      const list: IQuarkListItem[] = d.data?.list ?? [];
      for (const it of list) {
        const node: IPanFile = {
          fileId: it.fid,
          name: it.file_name,
          size: it.size ?? 0,
          isDir: !!it.dir,
          token: (it as any).share_fid_token ?? '',
        };
        if (node.isDir) {
          node.children = await this.listDir(pwdId, stoken, it.fid, ctx, depth + 1);
        }
        out.push(node);
      }
      const total = Number(d.metadata?._total ?? 0);
      if (out.length >= total || list.length === 0) break;
      page += 1;
    }
    return out;
  }

  async resolve(link: string, ctx: IPanContext): Promise<IPanShareResult> {
    const { pwdId, passcode } = this.parse(link);
    const stoken = await this.getStoken(pwdId, passcode, ctx);
    const files = await this.listDir(pwdId, stoken, '0', ctx, 0);
    const title = files[0]?.name ?? '夸克分享';
    // 把 stoken 与分享文件表挂在结果上，供 play() 复用（避免重复请求）
    (this as any)._lastStoken = { pwdId, stoken };
    (this as any)._lastFiles = files;
    return { title, files, shareUrl: link, driver: this.id };
  }

  /**
   * ③ 转存分享项到本人网盘，返回**本人网盘侧**的新 fid。
   *
   * 实测要点（2026-10-13，真实账号）：
   * - `fid_token_list` 必须与 `fid_list` 等长，token 取自 detail 的 `share_fid_token`；
   * - 转存**同名项已存在**时 `save_as_top_fids` 会返回空，此时必须回查并 diff
   *   本人网盘根目录；否则会继续用分享侧 fid，导致直链 21001 file not found。
   */
  private async saveToMyDrive(
    pwdId: string,
    stoken: string,
    fid: string,
    fidToken: string,
    ctx: IPanContext,
    name = '',
  ): Promise<string> {
    const before = await this.myRootFids(ctx);

    // 已存在同名项 → **先校验可用性**再复用：列表里可能残留已失效条目
    // （实测 2026-10-16：同名项能列出但 file/download 报 file not found，
    //   复用它会让播放器拿到无效直链 → 403），不可用则照常转存。
    if (name) {
      for (const [f, n] of before) {
        if (n === name) {
          if (await this.probeDownloadable(f, ctx)) {
            logger.info(`[quark] 网盘已存在同名项「${name}」，校验可用，跳转存直接复用 fid=${f}`);
            return f;
          }
          logger.warn(`[quark] 同名项「${name}」已失效（取直链失败），改为正常转存`);
          break;
        }
      }
    }

    let res: any;
    try {
      res = await ctx.request({
        url: `${API}/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=`,
        method: 'POST',
        headers: this.headers(ctx),
        data: {
          fid_list: [fid],
          fid_token_list: [fidToken],
          to_pdir_fid: '0',
          pwd_id: pwdId,
          stoken,
          pdir_fid: '0',
          scene: 'link',
        },
        responseType: 'json',
      });
    } catch (error: any) {
      const body = error?.response?.data;
      const code = Number(body?.code ?? 0);
      const status = error?.response?.status;
      if (code === 41020) {
        throw new Error(
          '夸克转存失败：分享文件 token 校验异常（通常为文件在分享内已变更或链接过期），请重新进入该影片。',
        );
      }
      throw new Error(
        `夸克转存失败：HTTP ${status ?? '?'} code=${code || '?'} msg=${body?.message ?? error?.message ?? ''}`,
      );
    }
    const d = res.data ?? {};
    if (d.code !== 0) {
      throw new Error(`夸克转存失败：code=${d.code} msg=${d.message ?? ''}（需登录 Cookie，或该分享禁止转存）`);
    }
    if (d.data?.task_id) await this.waitTask(d.data.task_id, ctx);

    // 正常路径：接口直接返回新 fid
    const direct: string[] = d.data?.save_as?.save_as_top_fids ?? [];
    if (direct.length) return direct[0];

    // 同名已存在：diff 根目录找新增项
    const after = await this.myRootFids(ctx);
    const added = [...after.keys()].filter((f) => !before.has(f));
    if (added.length) return added[0];

    // 仍无新增（转存被同名项覆盖，不会产生新 fid）→ 按名称回查复用（同样先校验）
    if (name) {
      for (const [f, n] of after) {
        if (n === name && (await this.probeDownloadable(f, ctx))) {
          logger.info(`[quark] 转存未产生新 fid，按名称复用已有「${name}」fid=${f}`);
          return f;
        }
      }
    }

    throw new Error(
      `夸克转存后无法定位文件${name ? `「${name}」` : ''}（网盘中疑似存在同名但内容不同的项，可先在夸克网盘清理后重试）`,
    );
  }

  /** 列出本人网盘根目录：Map<fid, name> */
  private async myRootFids(ctx: IPanContext): Promise<Map<string, string>> {
    const list = await this.myListDir('0', ctx);
    return new Map(list.map((it: any) => [it.fid as string, it.file_name as string]));
  }

  /** 列出本人网盘某目录 */
  private async myListDir(pdir: string, ctx: IPanContext): Promise<any[]> {
    const qs = new URLSearchParams({
      pr: 'ucpro',
      fr: 'pc',
      pdir_fid: pdir,
      force: '0',
      _page: '1',
      _size: '200',
      _fetch_total: '1',
      _sort: 'file_type:asc,updated_at:desc',
    });
    const res = await ctx.request({
      url: `${API}/file/sort?${qs.toString()}`,
      method: 'GET',
      headers: this.headers(ctx),
      responseType: 'json',
    });
    return res.data?.data?.list ?? [];
  }

  /**
   * 若转存进来的是目录，则下钻找到第一个可播放文件（实测分享常以剧集目录形式提供）。
   */
  /** 在分享文件树中按 fid 找名称（用于同名复用判断） */
  private findNameById(list: IPanFile[], fid: string): string {
    for (const f of list) {
      if (f.fileId === fid) return f.name;
      if (f.children?.length) {
        const r = this.findNameById(f.children, fid);
        if (r) return r;
      }
    }
    return '';
  }

  private async resolvePlayableFid(fid: string, ctx: IPanContext, depth = 0): Promise<string> {
    if (depth > 3) return fid;
    const children = await this.myListDir(fid, ctx);
    if (!children.length) return fid;
    const file = children.find((it: any) => !it.dir);
    if (file) return file.fid as string;
    const sub = children.find((it: any) => it.dir);
    return sub ? this.resolvePlayableFid(sub.fid, ctx, depth + 1) : fid;
  }

  /** 轮询转存任务 */
  private async waitTask(taskId: string, ctx: IPanContext): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const res = await ctx.request({
        url: `${API}/task?pr=ucpro&fr=pc&task_id=${encodeURIComponent(taskId)}&retry_index=${i}`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      const status = res.data?.data?.status;
      if (status === 2) return;
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  /** ④ 取直链 */
  private async getDownloadUrl(fids: string[], ctx: IPanContext): Promise<string> {
    let res: any;
    try {
      res = await ctx.request({
        url: `${API}/file/download?pr=ucpro&fr=pc&uc_param_str=`,
        method: 'POST',
        headers: this.headers(ctx),
        data: { fids },
        responseType: 'json',
      });
    } catch (error: any) {
      // 夸克部分业务错误直接以 HTTP 4xx 返回，真正的 code 在响应体里，
      // 必须解出 body 才能给出可读提示（否则只剩 "status code 400"）。
      const body = error?.response?.data;
      const code = Number(body?.code ?? 0);
      const status = error?.response?.status;
      if (code === 23018) {
        throw new Error(
          '夸克直链获取失败：文件超出当前账号的下载大小限制（code=23018）。' +
            '免费账号对单文件下载有上限，需开通夸克会员，或改选体积更小的资源 / 其他网盘。',
        );
      }
      throw new Error(
        `夸克取直链失败：HTTP ${status ?? '?'} code=${code || '?'} msg=${body?.message ?? error?.message ?? ''}`,
      );
    }
    const d = res.data ?? {};
    if (d.code !== 0) {
      // 实测：免费账号对大文件有下载限制，返回 23018
      if (d.code === 23018) {
        throw new Error(
          '夸克直链获取失败：文件超出当前账号的下载大小限制（code=23018）。' +
            '开源版夸克对单文件下载有上限，需开通会员或改用其他网盘。',
        );
      }
      throw new Error(`夸克直链获取失败：code=${d.code} msg=${d.message ?? ''}`);
    }
    const url = (d.data ?? [])[0]?.download_url;
    if (!url) throw new Error('夸克未返回直链（可能触发风控或文件受限）');
    return url as string;
  }

  async play(
    fileId: string,
    ctx: IPanContext,
    share?: { shareUrl?: string; title?: string; token?: string },
  ): Promise<IPanPlayInfo> {
    if (!ctx.credential?.cookie) {
      throw new Error('夸克播放需要登录 Cookie（设置 → 网盘账号 → 夸克网盘）');
    }
    const st = (this as any)._lastStoken as { pwdId: string; stoken: string } | undefined;
    if (!st) throw new Error('缺少分享上下文（请先调用 resolve 解析分享链接）');

    // 转存到本人网盘（转存后 fid 会变，必须用返回的新 fid）
    // 传入目标项名称：saveToMyDrive 据此在「同名已存在」时复用而不是报错
    const shareFiles = ((this as any)._lastFiles as IPanFile[] | undefined) ?? [];
    const targetName = this.findNameById(shareFiles, fileId) || String(share?.title ?? '');
    const myFid = await this.saveToMyDrive(st.pwdId, st.stoken, fileId, share?.token ?? '', ctx, targetName);
    // 若转存进来的是目录，下钻到第一个可播放文件
    const playFid = await this.resolvePlayableFid(myFid, ctx);
    const url = await this.getDownloadUrl([playFid], ctx);
    return {
      url,
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        // 精简 Cookie：夸克 CDN 对完整 32 项 Cookie 会回 412，
        // 而同样账号的精简会话项可正常 206（FongMi 即只带 __pus/__puus/__uid）
        Cookie: this.downloadCookie(ctx),
      },
    };
  }

  /**
   * 下载相关请求专用的**精简 Cookie**（`__pus` / `__puus` / `__uid`）。
   *
   * 实测（2026-10-16，同账号同直链同 UA 对照）：
   *   完整 32 项 Cookie → 夸克 CDN 恒返 **412 Precondition Failed**
   *   仅 3 项会话项     → **206 正常**
   * （API 层对两者都放行，只有 CDN 拉流层严格校验，故只影响下载/拉流请求。）
   */
  private downloadCookie(ctx: IPanContext): string {
    const full = String(ctx.credential?.cookie ?? '');
    if (!full) return '';
    const picked: string[] = [];
    for (const k of ['__pus', '__puus', '__uid']) {
      const m = full.match(new RegExp(`(?:^|;\\s*)${k}=([^;]*)`));
      if (m) picked.push(`${k}=${m[1]}`);
    }
    // 会话项不足则退回完整 Cookie（避免因格式差异反而更差）
    return picked.length >= 2 ? picked.join('; ') : full;
  }

  /**
   * 轻量校验：该 fid 当前是否**真的可取直链**。
   * 用于「按名复用」前排除列表里的失效残留条目 —— 实测存在
   * 「能列出但 file/download 报 file not found」的条目，
   * 复用它会让播放器拿到无效直链（CDN 回 403）。校验失败即改走正常转存。
   */
  private async probeDownloadable(fid: string, ctx: IPanContext): Promise<boolean> {
    try {
      const res = await ctx.request({
        url: `${API}/file/download?pr=ucpro&fr=pc&uc_param_str=`,
        method: 'POST',
        headers: { ...this.headers(ctx), Cookie: this.downloadCookie(ctx) },
        data: { fids: [fid] },
        responseType: 'json',
      });
      const d = (res.data ?? {}) as { code?: number; data?: Array<{ download_url?: string }> };
      return d.code === 0 && Boolean(d.data?.[0]?.download_url);
    } catch {
      return false;
    }
  }

  async check(ctx: IPanContext): Promise<boolean> {
    if (!ctx.credential?.cookie) return false;
    try {
      // ⚠️ 实测（2026-10-14）：原用 `/member` 接口会误报 false，
      // 但 Cookie 本身有效（`/config` 与 `file/sort` 均返回 code=0）。
      // 改为**列本人网盘根目录**——这才能真正验证「已登录且可读写」。
      const qs = new URLSearchParams({
        pr: 'ucpro',
        fr: 'pc',
        pdir_fid: '0',
        force: '0',
        _page: '1',
        _size: '1',
        _fetch_total: '1',
        _sort: 'file_type:asc,updated_at:desc',
      });
      const res = await ctx.request({
        url: `${API}/file/sort?${qs.toString()}`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      return (res.data ?? {}).code === 0;
    } catch {
      return false;
    }
  }
}

export default new QuarkDriver();
