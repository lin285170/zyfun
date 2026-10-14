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
import {
  PAN_DRIVER_ID,
  type IPanContext,
  type IPanDriver,
  type IPanFile,
  type IPanPlayInfo,
  type IPanShareResult,
} from '../types';

const API = 'https://drive-pc.quark.cn/1/clouddrive';
const REFERER = 'https://pan.quark.cn/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 常见分享域名 */
const LINK_RES = [
  /https?:\/\/pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/i,
  /https?:\/\/pan\.quark\.cn\/s\/([0-9a-zA-Z]+)\?pwd=([0-9a-zA-Z]+)/i,
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
    const m1 = link.match(/\/s\/([0-9a-zA-Z]+)\?pwd=([0-9a-zA-Z]+)/i);
    if (m1) return { pwdId: m1[1], passcode: m1[2] };
    const m2 = link.match(/\/s\/([0-9a-zA-Z]+)/i);
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
    // 把 stoken 挂在结果上，供 play() 复用（避免重复请求）
    (this as any)._lastStoken = { pwdId, stoken };
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
  ): Promise<string> {
    const before = await this.myRootFids(ctx);

    const res = await ctx.request({
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

    throw new Error('夸克转存完成但无法定位新文件（网盘中已存在同名目录，可先删除后重试）');
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
    const res = await ctx.request({
      url: `${API}/file/download?pr=ucpro&fr=pc&uc_param_str=`,
      method: 'POST',
      headers: this.headers(ctx),
      data: { fids },
      responseType: 'json',
    });
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
    const myFid = await this.saveToMyDrive(st.pwdId, st.stoken, fileId, share?.token ?? '', ctx);
    // 若转存进来的是目录，下钻到第一个可播放文件
    const playFid = await this.resolvePlayableFid(myFid, ctx);
    const url = await this.getDownloadUrl([playFid], ctx);
    return {
      url,
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Cookie: ctx.credential.cookie,
      },
    };
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
