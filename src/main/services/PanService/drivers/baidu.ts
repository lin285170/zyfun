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
import { createHash } from 'node:crypto';

import {
  PAN_DRIVER_ID,
  type IPanContext,
  type IPanDriver,
  type IPanFile,
  type IPanPlayInfo,
  type IPanShareResult,
} from '../types';

const HOST = 'https://pan.baidu.com';
const PCS_HOST = 'https://pcs.baidu.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** PCS locatedownload 需要网盘客户端 UA */
const PCS_UA = 'netdisk;P2SP;2.2.60.26';

/**
 * PCS 定位下载签名的固定盐值（32 字节 ASCII）。
 * 来源：BaiduPCS-Go `netdisksign/locatedownloadsign.go` 中逐字节写入的常量。
 */
const PCS_SIGN_SALT = 'ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF';

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
  /** 分享者的 uid */
  share_uk: string | number;
  /** **当前登录用户**的 uid —— PCS 签名需要这个，不是 share_uk */
  uk: string | number;
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
    /** 当前登录用户 uid（PCS 签名用），来自 /share/init 的 uk */
    uid: string;
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
      uk: locals.uk ?? '',
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
      uid: String(locals.uk),
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

  /**
   * ④ 转存到本人网盘，返回**本人网盘侧的新 fs_id 与其绝对路径**。
   *
   * 路径是 PCS 取直链的必要参数（PCS 按 path 定位文件，而非 fs_id）。
   * 实测转存响应里 `extra.list[0]` 同时给出 `to_fs_id` 与 `to`（新路径）。
   */
  private async transfer(
    fsId: string,
    ctx: IPanContext,
    toPath = '/',
  ): Promise<{ fsId: string; path: string }> {
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
    const item = d.extra?.list?.[0] ?? {};
    const newFsId = item.to_fs_id ? String(item.to_fs_id) : fsId;
    const newPath = String(item.to ?? '');
    return { fsId: newFsId, path: newPath };
  }

  /**
   * PCS 定位下载签名。
   *
   * 算法来源：BaiduPCS-Go 开源实现（`baidupcs/netdisksign/locatedownloadsign.go` + `devuid.go`），
   * 已用真实账号实测通过（2026-10-13）。
   *
   *   devuid = UPPER( hex(MD5(bduss)) + "|0" )
   *   rand   = hex( SHA1( hex(SHA1(bduss)) + uid + CONST + time + devuid ) )
   *
   * 其中 CONST 是 PCS 的固定盐值（32 字节，见 PCS_SIGN_SALT）。
   */
  private pcsSign(bduss: string, uid: string, timeSec = Math.floor(Date.now() / 1000)) {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
    const devuid = `${md5(bduss)}|0`.toUpperCase();
    const rand = sha1(sha1(bduss) + uid + PCS_SIGN_SALT + String(timeSec) + devuid);
    return { time: timeSec, rand, devuid };
  }

  /**
   * ⑤ 取直链 —— 走 **PCS locatedownload**（而非需 access_token 的 `api/filemetas`）。
   *
   * 实测结论（2026-10-13）：FongMi 抓包走的就是 `pcs.baidu.com`；
   * 请求 `method=locatedownload` + `time/rand/devuid/cuid` 四参数签名，
   * 用 BDUSS Cookie 鉴权，**完全不需要 OAuth access_token**。
   *
   * @param path 本人网盘内的**绝对路径**（转存响应里的 `to` 字段）
   */
  private async getPcsDlink(path: string, ctx: IPanContext): Promise<string> {
    const cookie = ctx.credential?.cookie ?? '';
    const bduss = cookie.match(/BDUSS=([^;]+)/)?.[1] ?? '';
    if (!bduss) throw new Error('百度 PCS 取直链需要 Cookie 中的 BDUSS');
    const uid = this.session?.uid ?? '';
    if (!uid) throw new Error('缺少 uid（请先调用 resolve 解析分享链接）');

    const s = this.pcsSign(bduss, uid);
    const qs = new URLSearchParams({
      ant: '1',
      check_blue: '1',
      es: '1',
      esl: '1',
      app_id: '250528',
      method: 'locatedownload',
      path,
      ver: '4.0',
      clienttype: '17',
      channel: '0',
      apn_id: '1_0',
      freeisp: '0',
      queryfree: '0',
      use: '0',
      time: String(s.time),
      rand: s.rand,
      devuid: s.devuid,
      cuid: s.devuid,
    });

    const res = await ctx.request({
      url: `${PCS_HOST}/rest/2.0/pcs/file?${qs.toString()}`,
      method: 'POST',
      headers: this.headers(ctx, {
        'User-Agent': PCS_UA,
        Referer: `${HOST}/`,
      }),
      responseType: 'json',
    });
    const d = res.data ?? {};
    // PCS 成功时返回 { urls: [{ url }] }；失败时返回 { error_code, error_msg }
    const raw = d.urls?.[0]?.url;
    if (!raw) {
      if (d.error_code === 31066) throw new Error('百度 PCS：文件不存在（path 不正确）');
      if (d.error_code === 31074) throw new Error('百度 PCS：目录不可下载（请传具体文件路径）');
      throw new Error(`百度 PCS 取直链失败：code=${d.error_code ?? '?'} msg=${d.error_msg ?? ''}`);
    }
    // 响应里的 & 会被转义成 \u0026，需还原
    return String(raw).replace(/\\u0026/g, '&');
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

    // ④ 转存到本人网盘 → 拿到**本人网盘内的绝对路径**（PCS 按 path 定位）
    const { path } = await this.transfer(fileId, ctx);
    if (!path) throw new Error('百度转存未返回文件路径，无法走 PCS 取直链');
    // ⑤ 走 PCS locatedownload 取直链（无需 access_token）
    const dlink = await this.getPcsDlink(path, ctx);
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
