/**
 * 百度网盘（pan.baidu.com）驱动。
 *
 * 链路：
 *   分享链接 https://pan.baidu.com/s/{surl}[?pwd=xxxx]
 *     ① GET  /api/shorturlinfo                 → shareid / uk（分享方 uid）/ randsk
 *     ② POST /share/verify                     → 提取码校验，返回新的 randsk
 *     ③ GET  /share/list                       → 文件列表（dir 递归）
 *     ④ POST /share/transfer                   → 转存到本人网盘（需登录 + bdstoken）
 *     ⑤ GET  /api/filemetas?dlink=1            → 取 dlink 直链（需登录）
 *
 * 凭据：Cookie（必须含 `BDUSS`；若分享需要提取码，运行时还会注入 `BDCLND=<randsk>`）。
 * `bdstoken` 从页面或 `/api/gettemplatevariable` 获取，会随会话变化，故运行时不缓存。
 */
import {
  PAN_DRIVER_ID,
  type IPanContext,
  type IPanDriver,
  type IPanFile,
  type IPanPlayInfo,
  type IPanShareResult,
} from '../types';

const HOST = 'https://pan.baidu.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LINK_RE = /https?:\/\/pan\.baidu\.com\/s\/([0-9a-zA-Z_-]+)/i;

interface IBaiduListItem {
  fs_id: number;
  server_filename: string;
  isdir: number;
  size: number;
  path: string;
}

class BaiduDriver implements IPanDriver {
  id = PAN_DRIVER_ID.BAIDU;
  name = '百度网盘';
  credentialFields: IPanDriver['credentialFields'] = ['cookie'];

  /** 每次解析的会话上下文 */
  private session: { surl: string; shareid: string; uk: string; randsk: string; bdstoken: string } | null = null;

  match(link: string): boolean {
    return LINK_RE.test(link || '');
  }

  private parse(link: string): { surl: string; pwd: string } {
    const m = link.match(/\/s\/([0-9a-zA-Z_-]+)/i);
    if (!m) throw new Error('无法从链接中解析百度网盘 surl');
    let surl = m[1];
    if (surl.startsWith('1')) surl = surl.slice(1); // 标准短链去掉前导 1
    const p = link.match(/[?&]pwd=([0-9a-zA-Z]{4})/i);
    return { surl, pwd: p ? p[1] : '' };
  }

  private headers(ctx: IPanContext, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': UA,
      Referer: `${HOST}/disk/home`,
      Origin: HOST,
      Accept: 'application/json, text/plain, */*',
      ...extra,
    };
    if (ctx.credential?.cookie) h.Cookie = ctx.credential.cookie;
    return h;
  }

  /** ① 分享基本信息 */
  private async shortUrlInfo(surl: string, ctx: IPanContext) {
    const res = await ctx.request({
      url: `${HOST}/api/shorturlinfo?shorturl=${surl}&web=1&app_id=250528&channel=chunlei&clienttype=0`,
      method: 'GET',
      headers: this.headers(ctx),
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      throw new Error(`百度分享信息获取失败：errno=${d.errno}（链接可能已失效）`);
    }
    return {
      shareid: String(d.shareid ?? ''),
      uk: String(d.uk ?? ''),
      randsk: String(d.randsk ?? ''),
    };
  }

  /** ② 提取码校验 */
  private async verify(surl: string, pwd: string, ctx: IPanContext): Promise<string> {
    const ts = Date.now();
    const res = await ctx.request({
      url: `${HOST}/share/verify?surl=${surl}&t=${ts}&channel=chunlei&web=1&app_id=250528&clienttype=0`,
      method: 'POST',
      headers: this.headers(ctx, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      data: `pwd=${encodeURIComponent(pwd)}`,
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      throw new Error(`百度提取码校验失败：errno=${d.errno}（提取码错误或链接失效）`);
    }
    return String(d.randsk ?? '');
  }

  /** 取 bdstoken（后续 transfer 需要） */
  private async getBdstoken(ctx: IPanContext): Promise<string> {
    try {
      const res = await ctx.request({
        url: `${HOST}/api/gettemplatevariable?fields=${encodeURIComponent('["bdstoken"]')}&web=1&app_id=250528&channel=chunlei&clienttype=0`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      // 实测：该接口的 result 可能是对象，也可能退化为数组（未登录/风控时 errno=-6）
      const r = res.data?.result;
      if (Array.isArray(r)) return '';
      return String(r?.bdstoken ?? '');
    } catch {
      return '';
    }
  }

  /** ③ 列目录（递归） */
  private async listDir(
    dir: string,
    ctx: IPanContext,
    depth: number,
    randsk: string,
  ): Promise<IPanFile[]> {
    if (depth > 4 || !this.session) return [];
    const { surl, bdstoken } = this.session;
    const qs = new URLSearchParams({
      shorturl: surl,
      root: depth === 0 ? '1' : '0',
      dir,
      page: '1',
      num: '100',
      order: 'time',
      desc: '1',
      showempty: '0',
      web: '1',
      channel: 'chunlei',
      app_id: '250528',
      clienttype: '0',
    });
    if (bdstoken) qs.set('bdstoken', bdstoken);

    const res = await ctx.request({
      url: `${HOST}/share/list?${qs.toString()}`,
      method: 'GET',
      headers: this.headers(ctx, { Cookie: this.mergeRandsk(ctx, randsk) }),
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      throw new Error(`百度文件列表获取失败：errno=${d.errno}（可能需要提取码或已失效）`);
    }
    const list: IBaiduListItem[] = d.list ?? [];
    const out: IPanFile[] = [];
    for (const it of list) {
      const node: IPanFile = {
        fileId: String(it.fs_id),
        name: it.server_filename,
        size: it.size ?? 0,
        isDir: it.isdir === 1,
        // 百度转存用 fs_id（与 fileId 同值），显式带上便于统一处理
        token: String(it.fs_id),
      };
      if (node.isDir) {
        node.children = await this.listDir(it.path, ctx, depth + 1, randsk);
      }
      out.push(node);
    }
    return out;
  }

  /** 把 randsk 注入 Cookie（BDCLND） */
  private mergeRandsk(ctx: IPanContext, randsk: string): string {
    const base = ctx.credential?.cookie ?? '';
    if (!randsk) return base;
    if (/BDCLND=/.test(base)) {
      return base.replace(/BDCLND=[^;]*/g, `BDCLND=${encodeURIComponent(randsk)}`);
    }
    return `${base}; BDCLND=${encodeURIComponent(randsk)}`;
  }

  async resolve(link: string, ctx: IPanContext): Promise<IPanShareResult> {
    const { surl, pwd } = this.parse(link);
    const info = await this.shortUrlInfo(surl, ctx);
    let randsk = info.randsk;
    if (pwd) {
      randsk = await this.verify(surl, pwd, ctx);
    }
    const bdstoken = await this.getBdstoken(ctx);
    this.session = { surl, shareid: info.shareid, uk: info.uk, randsk, bdstoken };

    const files = await this.listDir('/', ctx, 0, randsk);
    const title = files[0]?.name ?? '百度网盘分享';
    return { title, files, shareUrl: link, driver: this.id };
  }

  /** ④ 转存 */
  private async transfer(fsidList: string[], ctx: IPanContext, toPath = '/我的资源'): Promise<void> {
    if (!this.session) throw new Error('缺少分享会话（请先调用 resolve）');
    const { shareid, uk, bdstoken, randsk, surl } = this.session;
    const ts = Date.now();
    const res = await ctx.request({
      url: `${HOST}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&web=1&app_id=250528&clienttype=0&t=${ts}&surl=${surl}`,
      method: 'POST',
      headers: this.headers(ctx, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.mergeRandsk(ctx, randsk),
      }),
      data: `fsidlist=${encodeURIComponent(JSON.stringify(fsidList.map(Number)))}&path=${encodeURIComponent(toPath)}`,
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      throw new Error(`百度转存失败：errno=${d.errno}（需登录 Cookie，或目标目录已存在同名文件）`);
    }
  }

  /** ⑤ 取 dlink */
  private async getDlink(fsId: string, ctx: IPanContext): Promise<string> {
    const { bdstoken } = this.session ?? { bdstoken: '' };
    const qs = new URLSearchParams({
      target: JSON.stringify([Number(fsId)]),
      dlink: '1',
      web: '1',
      channel: 'chunlei',
      app_id: '250528',
      clienttype: '0',
    });
    if (bdstoken) qs.set('bdstoken', bdstoken);
    const res = await ctx.request({
      url: `${HOST}/api/filemetas?${qs.toString()}`,
      method: 'GET',
      headers: this.headers(ctx),
      responseType: 'json',
    });
    const info = (res.data?.info ?? [])[0] ?? {};
    if (!info.dlink) {
      // 实测：info.errno=31021 表示该接口要求 access_token（纯 Cookie 不足）。
      // 需要先用 BDUSS 走 OAuth 换 access_token，或改用「分享链接直下」路径。
      if (info.errno === 31021) {
        throw new Error(
          '百度直链获取失败：接口要求 access_token（errno=31021）。' +
            '需补充 OAuth 换 token 步骤，或改用分享链接直下路径。',
        );
      }
      throw new Error(`百度未返回直链 dlink（info.errno=${info.errno ?? '?'}；需登录 Cookie 且已转存）`);
    }
    return info.dlink as string;
  }

  async play(
    fileId: string,
    ctx: IPanContext,
    _share?: { shareUrl?: string; title?: string; token?: string },
  ): Promise<IPanPlayInfo> {
    if (!ctx.credential?.cookie) {
      throw new Error('百度网盘播放需要登录 Cookie（设置 → 网盘账号 → 百度网盘）');
    }
    if (!this.session) throw new Error('缺少分享会话（请先调用 resolve 解析分享链接）');

    await this.transfer([fileId], ctx);
    const dlink = await this.getDlink(fileId, ctx);
    return {
      url: dlink,
      headers: {
        'User-Agent': UA,
        Referer: `${HOST}/`,
        Cookie: this.mergeRandsk(ctx, this.session.randsk),
      },
    };
  }

  async check(ctx: IPanContext): Promise<boolean> {
    if (!ctx.credential?.cookie) return false;
    try {
      const res = await ctx.request({
        url: `${HOST}/api/gettemplatevariable?fields=${encodeURIComponent('["bdstoken","username"]')}&web=1&app_id=250528&channel=chunlei&clienttype=0`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      return Boolean(res.data?.result?.username);
    } catch {
      return false;
    }
  }
}

export default new BaiduDriver();
