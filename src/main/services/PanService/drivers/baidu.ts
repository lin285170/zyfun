/**
 * 百度网盘（pan.baidu.com）驱动。
 *
 * 链路（2026-10-13 真实账号 + 真实花卷源链接 **实测打通 4/5 步**）：
 *   分享链接 https://pan.baidu.com/s/{surl}[?pwd=xxxx]
 *     ① GET  /share/init?surl={去前导1}&pwd={pwd}
 *            → HTML 内 window.locals 含 bdstoken / shareid / share_uk   ★关键
 *     ② POST /share/verify?surl={去前导1}&bdstoken={bdstoken}            ← 缺 bdstoken 会 errno=105
 *            → {"errno":0, "randsk":"..."}
 *     ③ GET  /share/list?shareid=&uk=&dir=/&root=1
 *            Cookie: BDCLND={randsk}（**randsk 必须去除首尾空白**）
 *            → {"errno":0, "show_msg":"success", "list":[...]}
 *     ④ POST /share/transfer?shareid=&from={uk}&bdstoken={bdstoken}&surl=
 *            Cookie: BDCLND={randsk}  body: fsidlist=[...]&path=/
 *            → {"errno":0, "extra":{"list":[{"to_fs_id":新fid}]}}
 *     ⑤ GET  /api/filemetas?target=[{新fid}]&dlink=1&bdstoken=
 *            → ⚠️ 实测 errno=31021：**该接口要求 access_token，纯 Cookie 不足**
 *
 * 实测要点汇总（均为踩坑记录）：
 * - `api/shorturlinfo`（取 shareid/uk）需要**完整** surl（含前导 1），且**无需 Cookie**；
 *   而 `share/init|verify|list|transfer` 需要**去掉前导 1** 的 surl。两者相反，务必区分。
 * - `verify` 必须带 `bdstoken`（从 `/share/init` 页面提取），否则 errno=105。
 * - `verify` 返回的 `randsk` 需 `trim()` 后写入 `BDCLND` Cookie，否则列表/转存报「提取码错误」。
 * - `list` / `transfer` 都要带 `BDCLND`；转存漏掉会得到 errno=200025。
 * - 分享页 `https://pan.baidu.com/s/xxx` 现已 302 强制登录，但上述 API 不受影响。
 *
 * 凭据：Cookie 需含 `BDUSS`（web 端登录态）。
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

/** /share/init 页面 window.locals 中我们关心的字段 */
interface IInitLocals {
  bdstoken: string;
  csrf: string;
  shareid: string | number;
  share_uk: string | number;
  loginstate: number;
}

class BaiduDriver implements IPanDriver {
  id = PAN_DRIVER_ID.BAIDU;
  name = '百度网盘';
  credentialFields: IPanDriver['credentialFields'] = ['cookie'];

  /** 每次解析的会话上下文 */
  private session: {
    surlFull: string;
    surlShort: string;
    shareid: string;
    uk: string;
    randsk: string;
    bdstoken: string;
  } | null = null;

  match(link: string): boolean {
    return LINK_RE.test(link || '');
  }

  /**
   * 解析链接。
   * - `surlFull` 用于 `api/shorturlinfo`（含前导 1）
   * - `surlShort` 用于 `share/init|verify|list|transfer`（去前导 1）
   */
  private parse(link: string): { surlFull: string; surlShort: string; pwd: string } {
    const m = link.match(/\/s\/([0-9a-zA-Z_-]+)/i);
    if (!m) throw new Error('无法从链接中解析百度网盘 surl');
    const surlFull = m[1];
    // 实测：/share/init 等接口使用去掉前导 1 的形式（百度自身 302 也这么跳）
    const surlShort = surlFull.startsWith('1') ? surlFull.slice(1) : surlFull;
    const p = link.match(/[?&]pwd=([0-9a-zA-Z]{4})/i);
    return { surlFull, surlShort, pwd: p ? p[1] : '' };
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

  /** 把 randsk 合并进 Cookie（BDCLND） */
  private withRandsk(ctx: IPanContext, randsk: string, referer?: string): Record<string, string> {
    const base = ctx.credential?.cookie ?? '';
    let cookie = base;
    if (randsk) {
      cookie = /BDCLND=/.test(base)
        ? base.replace(/BDCLND=[^;]*/g, `BDCLND=${randsk}`)
        : `${base}; BDCLND=${randsk}`;
    }
    return this.headers(ctx, { Cookie: cookie, ...(referer ? { Referer: referer } : {}) });
  }

  /**
   * ① 关键：访问 `/share/init` 页面，提取 window.locals。
   *
   * 这一步以前被忽略，导致 verify 缺 bdstoken 而返回 errno=105。
   */
  private async initShare(surlShort: string, pwd: string, ctx: IPanContext): Promise<IInitLocals> {
    const res = await ctx.request({
      url: `${HOST}/share/init?surl=${surlShort}${pwd ? `&pwd=${pwd}` : ''}`,
      method: 'GET',
      headers: this.headers(ctx, { Referer: `${HOST}/` }),
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const m = html.match(/window\.locals\s*=\s*(\{[\s\S]*?\});/);
    if (!m) {
      throw new Error('百度 /share/init 未返回 window.locals（可能链接失效或需登录）');
    }
    let locals: any;
    try {
      locals = JSON.parse(m[1]);
    } catch {
      throw new Error('百度 /share/init 的 window.locals 解析失败');
    }
    if (!locals.bdstoken) {
      throw new Error('百度 /share/init 未取到 bdstoken（Cookie 可能已失效，需含 BDUSS）');
    }
    return {
      bdstoken: String(locals.bdstoken),
      csrf: String(locals.csrf ?? ''),
      shareid: locals.shareid ?? '',
      share_uk: locals.share_uk ?? '',
      loginstate: Number(locals.loginstate ?? 0),
    };
  }

  /** 取 shareid / uk（免 Cookie，需完整 surl） */
  private async shortUrlInfo(surlFull: string, ctx: IPanContext) {
    const res = await ctx.request({
      url: `${HOST}/api/shorturlinfo?shorturl=${surlFull}&web=1&app_id=250528&channel=chunlei&clienttype=0`,
      method: 'GET',
      headers: this.headers(ctx),
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (!d.shareid) {
      throw new Error(`百度分享信息获取失败：errno=${d.errno}（链接可能已失效）`);
    }
    return { shareid: String(d.shareid), uk: String(d.uk ?? ''), randsk: String(d.randsk ?? '') };
  }

  /** ② 提取码校验（**必须带 bdstoken**，surl 用去前导 1 形式） */
  private async verify(surlShort: string, pwd: string, bdstoken: string, ctx: IPanContext): Promise<string> {
    const res = await ctx.request({
      url: `${HOST}/share/verify?surl=${surlShort}&t=${Date.now()}&channel=chunlei&web=1&app_id=250528&clienttype=0&bdstoken=${encodeURIComponent(bdstoken)}`,
      method: 'POST',
      headers: this.headers(ctx, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${HOST}/`,
      }),
      data: `pwd=${encodeURIComponent(pwd)}&vcode=&vcode_str=`,
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      throw new Error(
        `百度提取码校验失败：errno=${d.errno}` +
          (d.errno === 105 ? '（通常因缺少 bdstoken，或提取码错误）' : ''),
      );
    }
    // ⚠️ 必须 trim：接口返回的 randsk 前后可能带空白，直接写入 Cookie 会失效
    return String(d.randsk ?? '').trim();
  }

  /** ③ 列目录（shareid+uk + BDCLND） */
  private async listDir(dir: string, ctx: IPanContext, depth: number): Promise<IPanFile[]> {
    if (depth > 4 || !this.session) return [];
    const { surlShort, shareid, uk, randsk } = this.session;
    const qs = new URLSearchParams({
      shareid,
      uk,
      dir,
      page: '1',
      num: '100',
      order: 'time',
      desc: '1',
      showempty: '0',
      root: depth === 0 ? '1' : '0',
      web: '1',
      channel: 'chunlei',
      app_id: '250528',
      clienttype: '0',
    });
    const res = await ctx.request({
      url: `${HOST}/share/list?${qs.toString()}`,
      method: 'GET',
      headers: this.withRandsk(ctx, randsk, `${HOST}/s/${surlShort}`),
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      if (d.errno === -9) throw new Error('百度分享列表需要提取码（errno=-9），请确认链接含 ?pwd=');
      throw new Error(`百度文件列表获取失败：errno=${d.errno} msg=${d.show_msg ?? ''}`);
    }
    const list: IBaiduListItem[] = d.list ?? [];
    const out: IPanFile[] = [];
    for (const it of list) {
      const node: IPanFile = {
        fileId: String(it.fs_id),
        name: it.server_filename,
        size: it.size ?? 0,
        isDir: it.isdir === 1,
        token: String(it.fs_id),
      };
      if (node.isDir) node.children = await this.listDir(it.path, ctx, depth + 1);
      out.push(node);
    }
    return out;
  }

  async resolve(link: string, ctx: IPanContext): Promise<IPanShareResult> {
    const { surlFull, surlShort, pwd } = this.parse(link);

    // ① 优先用 /share/init 拿 bdstoken（同时能拿到 shareid/uk）
    const locals = await this.initShare(surlShort, pwd, ctx);
    this.session = {
      surlFull,
      surlShort,
      shareid: String(locals.shareid),
      uk: String(locals.share_uk),
      randsk: '',
      bdstoken: locals.bdstoken,
    };

    // ② 提取码校验
    let randsk = '';
    if (pwd) {
      randsk = await this.verify(surlShort, pwd, locals.bdstoken, ctx);
    } else {
      try {
        const info = await this.shortUrlInfo(surlFull, ctx);
        randsk = info.randsk.trim();
      } catch {
        /* 忽略：无提取码时 shorturlinfo 可能失败，不影响后续 */
      }
    }
    this.session.randsk = randsk;

    const files = await this.listDir('/', ctx, 0);
    const title = files[0]?.name ?? '百度网盘分享';
    return { title, files, shareUrl: link, driver: this.id };
  }

  /** ④ 转存到本人网盘，返回新 fs_id */
  private async transfer(fsId: string, ctx: IPanContext, toPath = '/'): Promise<string> {
    if (!this.session) throw new Error('缺少分享会话（请先 resolve）');
    const { surlShort, shareid, uk, randsk, bdstoken } = this.session;
    const res = await ctx.request({
      url: `${HOST}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&web=1&app_id=250528&clienttype=0&t=${Date.now()}&surl=${surlShort}`,
      method: 'POST',
      headers: this.withRandsk(ctx, randsk, `${HOST}/s/${surlShort}`),
      data: `fsidlist=${encodeURIComponent(JSON.stringify([Number(fsId)]))}&path=${encodeURIComponent(toPath)}`,
      responseType: 'json',
    });
    const d = res.data ?? {};
    if (d.errno !== 0) {
      if (d.errno === 200025) throw new Error('百度转存失败：提取码未生效（BDCLND 缺失或失效）');
      throw new Error(`百度转存失败：errno=${d.errno} msg=${d.show_msg ?? ''}`);
    }
    const toFsId = d.extra?.list?.[0]?.to_fs_id;
    return toFsId ? String(toFsId) : fsId;
  }

  /** ⑤ 取 dlink */
  private async getDlink(fsId: string, ctx: IPanContext): Promise<string> {
    const bdstoken = this.session?.bdstoken ?? '';
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
      if (info.errno === 31021) {
        throw new Error(
          '百度直链获取失败：接口要求 access_token（errno=31021）。' +
            '前 4 步（init/verify/list/transfer）均已通过，仅差 OAuth 换 token 这一步。',
        );
      }
      throw new Error(`百度未返回直链（info.errno=${info.errno ?? '?'}）`);
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

    const newFsId = await this.transfer(fileId, ctx);
    const dlink = await this.getDlink(newFsId, ctx);
    const hdrs = this.withRandsk(ctx, this.session.randsk);
    return {
      url: dlink,
      headers: { 'User-Agent': UA, Referer: `${HOST}/`, Cookie: String(hdrs.Cookie ?? '') },
    };
  }

  async check(ctx: IPanContext): Promise<boolean> {
    if (!ctx.credential?.cookie) return false;
    try {
      const res = await ctx.request({
        url: `${HOST}/api/list?order=time&desc=1&showempty=0&page=1&num=1&dir=/&channel=chunlei&web=1&app_id=250528&clienttype=0`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      return (res.data ?? {}).errno === 0;
    } catch {
      return false;
    }
  }
}

export default new BaiduDriver();
