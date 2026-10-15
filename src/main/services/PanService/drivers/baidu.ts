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

import { loggerService } from '@main/services/LoggerService';
import { LOG_MODULE } from '@shared/config/logger';

import { baiduBrowserService } from '../baiduBrowser';
import type { IPanContext, IPanDriver, IPanFile, IPanPlayInfo, IPanShareResult } from '../types';
import { PAN_DRIVER_ID } from '../types';

/**
 * 需要「浏览器过验」的专用信号。
 *
 * 带提取码的分享在新版百度上必须经浏览器完成校验（pwd_enc + 指纹），
 * 纯 HTTP 无法复现；resolve 抛出该信号后，由上层打开分享页窗口取得 BDCLND，
 * 随后重试即可走通「API 转存 → PCS 直链」。
 */
export const BAIDU_NEED_VERIFY = 'BAIDU_NEED_VERIFY';

/** 判断文件名是否为可播放媒体（用于从转存目录中挑出第一个视频） */
const MEDIA_EXT_RE = /\.(?:mp4|mkv|avi|mov|wmv|flv|ts|m2ts|rmvb|webm|m4v|mpg|mpeg|3gp|iso|bdmv)$/i;

/** 扩展名 → 响应给播放器的 MIME（与渲染层 MIME_TO_EXTENSION 可逆对应） */
const PLAY_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
};
function isMediaName(name: string): boolean {
  return MEDIA_EXT_RE.test(String(name ?? '').trim());
}

const logger = loggerService.withContext(LOG_MODULE.FILM_CMS);

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

const LINK_RE = /https?:\/\/pan\.baidu\.com\/s\/[\w-]+/i;

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
    /**
     * 浏览器过验时带回的**实时 Cookie**。
     * BDCLND 与这套 Cookie 强绑定，必须成对使用（用快照 Cookie 会 errno=-9）。
     */
    cookieOverride?: string;
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
    const m = link.match(/\/s\/([\w-]+)/i);
    if (!m) throw new Error('无法从链接中解析百度网盘 surl');
    const surlFull = m[1];
    // 实测：/share/init 等接口使用去掉前导 1 的形式（百度自身 302 也这么跳）
    const surlShort = surlFull.startsWith('1') ? surlFull.slice(1) : surlFull;
    const p = link.match(/[?&]pwd=([0-9a-z]{4})/i);
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
    // 过验带回的实时 Cookie 优先于登录快照（两者必须与 BDCLND 配套）
    const cookie = this.session?.cookieOverride || ctx.credential?.cookie;
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /** 把 randsk 合并进 Cookie（BDCLND） */
  private withRandsk(
    ctx: IPanContext,
    randsk: string,
    referer?: string,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const base = this.session?.cookieOverride || ctx.credential?.cookie || '';
    let cookie = base;
    if (randsk) {
      cookie = /BDCLND=/.test(base) ? base.replace(/BDCLND=[^;]*/g, `BDCLND=${randsk}`) : `${base}; BDCLND=${randsk}`;
    }
    return this.headers(ctx, { Cookie: cookie, ...(referer ? { Referer: referer } : {}), ...(extra ?? {}) });
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

    // 兼容 ①：老版页面内联 window.locals
    const mLocals = html.match(/window\.locals\s*=\s*(\{[\s\S]*?\});/);
    if (mLocals) {
      try {
        const locals = JSON.parse(mLocals[1]);
        if (locals.bdstoken) {
          return {
            bdstoken: String(locals.bdstoken),
            csrf: String(locals.csrf ?? ''),
            shareid: locals.shareid ?? '',
            share_uk: locals.share_uk ?? '',
            uk: locals.uk ?? '',
            loginstate: Number(locals.loginstate ?? 0),
          };
        }
      } catch {
        /* 落到兼容 ② */
      }
    }

    // 兼容 ②（2026-10 实测）：新版不再内联 window.locals，但 HTML 中仍带裸字段
    const bdstoken = html.match(/["']?bdstoken["']?\s*[:=]\s*["']([0-9a-f]{16,})["']/i)?.[1] ?? '';
    if (!bdstoken) {
      throw new Error('百度 /share/init 未取到 bdstoken（Cookie 可能已失效，需含 BDUSS）');
    }
    const pickNum = (key: string): string => {
      const m = html.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']?([0-9]+)["']?`));
      return m?.[1] ?? '';
    };
    return {
      bdstoken,
      csrf: '',
      shareid: pickNum('shareid'),
      share_uk: pickNum('share_uk'),
      uk: pickNum('uk'),
      loginstate: 1,
    };
  }

  /** 取当前登录用户的 uid（PCS 定位下载签名需要，非分享者 uk） */
  private async myUid(ctx: IPanContext): Promise<string> {
    try {
      const res = await ctx.request({
        url: `${HOST}/rest/2.0/xpan/nas?method=uinfo&channel=chunlei&web=1&app_id=250528&clienttype=0`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      return String((res.data ?? {}).uk ?? '');
    } catch {
      return '';
    }
  }

  /**
   * 取**当前登录用户**的 bdstoken。
   *
   * ⚠️ `/share/init` 页面里的 bdstoken 是「分享页上下文」的，匿名也能拿到；
   * 用它调 `share/transfer` 会被判 `errno=2 参数错误`。
   * 转存必须用登录用户自己的 bdstoken（`/api/gettemplatevariable`）。
   */
  private async userBdstoken(ctx: IPanContext): Promise<string> {
    try {
      const res = await ctx.request({
        url: `${HOST}/api/gettemplatevariable?fields=${encodeURIComponent('["bdstoken"]')}&channel=chunlei&web=1&app_id=250528&clienttype=0`,
        method: 'GET',
        headers: this.headers(ctx),
        responseType: 'json',
      });
      const r = (res.data ?? {}).result;
      const token = Array.isArray(r) ? '' : String((r as any)?.bdstoken ?? '');
      if (token) logger.info('[baidu] 已取到登录用户的 bdstoken');
      return token;
    } catch {
      return '';
    }
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
        `百度提取码校验失败：errno=${d.errno}${d.errno === 105 ? '（通常因缺少 bdstoken，或提取码错误）' : ''}`,
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
      // 取文本自行解析：百度的 fs_id 是 19 位雪花 ID，交给 JSON.parse 会被
      // 转成 Number 从而静默丢精度（末尾几位变 0），后续转存必然 errno=2。
      responseType: 'text',
    });
    const rawText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
    // 把长数字（≥15 位）先转成字符串再解析，保证 fs_id 原样保留
    const safeText = rawText.replace(/"fs_id"\s*:\s*(\d{15,})/g, '"fs_id":"$1"');
    let d: any;
    try {
      d = JSON.parse(safeText);
    } catch {
      throw new Error('百度文件列表解析失败（响应非 JSON）');
    }
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

    // ① bdstoken（/share/init，兼容老/新两种页面结构）
    //    ⚠️ 非致命：/share/init 是被百度风控限流的重灾区（高频访问后返回无字段页面），
    //    而排除法实测转存对 bdstoken **零依赖**（shareid/uk 走免 Cookie 的 shorturlinfo，
    //    uid 走 uinfo）；提取码走浏览器过验也不依赖它。取不到就降级继续。
    let locals: IInitLocals;
    try {
      locals = await this.initShare(surlShort, pwd, ctx);
    } catch (error) {
      logger.warn(`[baidu] /share/init 失败（降级继续，不依赖 bdstoken）：${(error as Error)?.message ?? error}`);
      locals = { bdstoken: '', csrf: '', shareid: '', share_uk: '', uk: '', loginstate: 0 };
    }

    // ② shareid / uk：shorturlinfo 实测更稳定，失败再退回页面字段
    let shareid = '';
    let shareUk = '';
    try {
      const info = await this.shortUrlInfo(surlFull, ctx);
      shareid = info.shareid;
      shareUk = info.uk;
    } catch {
      /* 落到页面字段 */
    }
    if (!shareid) {
      shareid = String(locals.shareid);
      shareUk = String(locals.share_uk || locals.shareid);
    }

    // ③ 当前登录用户 uid（PCS 定位下载签名需要它，不是分享者 uk）
    const uid = (await this.myUid(ctx)) || String(locals.uk);

    this.session = {
      surlFull,
      surlShort,
      shareid,
      uk: shareUk,
      uid,
      randsk: '',
      bdstoken: locals.bdstoken,
      // 若此前已用浏览器过验过该分享，则连它那套实时 Cookie 一起用上
      cookieOverride: baiduBrowserService.getCachedCookie(link) || undefined,
    };

    // 转存用的是**登录用户的** bdstoken，而非 /share/init 的分享页 token
    const userToken = await this.userBdstoken(ctx);
    if (userToken) this.session.bdstoken = userToken;

    // ④ 提取码凭据 randsk
    //    优先用「浏览器过验」缓存下来的 BDCLND：新版 verify 需要 pwd_enc 混淆 +
    //    时间戳签名 + 客户端指纹（实测纯 HTTP 恒返 9019），浏览器页可自然完成校验。
    let randsk = baiduBrowserService.getCachedRandsk(link);
    if (!randsk && !pwd) {
      try {
        const info = await this.shortUrlInfo(surlFull, ctx);
        randsk = String(info.randsk ?? '').trim();
      } catch {
        /* 无提取码分享也可能拿不到，忽略 */
      }
    }
    if (!randsk && pwd) {
      // 仍尝试一次 API 校验（部分老分享仍可用）
      try {
        randsk = await this.verify(surlShort, pwd, locals.bdstoken, ctx);
      } catch (error) {
        logger.warn(
          `[baidu] verify 失败（将走浏览器过验）：pwd=${pwd} bdstoken=${locals.bdstoken ? '有' : '无'} err=${(error as Error)?.message}`,
        );
      }
    }
    logger.warn(
      `[baidu] resolve 汇总 pwd="${pwd}" cachedRandsk=${baiduBrowserService.getCachedRandsk(link) ? '有' : '无'} randsk=${randsk ? '有' : '无'} bdstoken=${locals.bdstoken ? '有' : '无'} shareid=${shareid || '空'}`,
    );
    if (!randsk && pwd) {
      throw new Error(BAIDU_NEED_VERIFY);
    }
    this.session.randsk = randsk;

    let files: IPanFile[];
    try {
      files = await this.listDir('/', ctx, 0);
    } catch (error) {
      const msg = String((error as Error)?.message ?? '');
      if (msg.includes('errno=-9') && pwd) {
        // randsk 可能是「已解码」形式，而服务端要的是 URL 编码形式（或反之）。
        // 参照 FongMi 的 .baiducookie：其中存的是 `%2F/%2B/%3D` 这类编码值。
        // 这里对另一种形式做一次回退尝试。
        const alt = /%[0-9A-F]{2}/i.test(randsk) ? decodeURIComponent(randsk) : encodeURIComponent(randsk);
        logger.warn(`[baidu] randsk 首次失败，回退尝试另一种编码形式（altLen=${alt.length}）`);
        this.session.randsk = alt;
        try {
          files = await this.listDir('/', ctx, 0);
          logger.info('[baidu] 回退编码形式后成功取到文件列表');
          return {
            title: files[0]?.name ?? '百度网盘分享',
            files,
            shareUrl: link,
            driver: this.id,
          };
        } catch {
          // 两种形式都失败 → 缓存无效，丢弃并转为浏览器过验
          baiduBrowserService.clearCache(link);
          logger.warn(`[baidu] 两种编码形式均失败，已清除缓存，转为浏览器过验：${link}`);
          throw new Error(BAIDU_NEED_VERIFY);
        }
      }
      throw error;
    }
    const title = files[0]?.name ?? '百度网盘分享';
    return { title, files, shareUrl: link, driver: this.id };
  }

  /**
   * ④ 转存到本人网盘，返回**本人网盘侧的新 fs_id 与其绝对路径**。
   *
   * 路径是 PCS 取直链的必要参数（PCS 按 path 定位文件，而非 fs_id）。
   * 实测转存响应里 `extra.list[0]` 同时给出 `to_fs_id` 与 `to`（新路径）。
   */
  private async transfer(fsId: string, ctx: IPanContext, toPath = '/'): Promise<{ fsId: string; path: string }> {
    if (!this.session) throw new Error('缺少分享会话（请先 resolve）');
    const { surlShort, shareid, uk, randsk, bdstoken } = this.session;

    // ⚠️ 百度的 fs_id 是 19 位雪花 ID，超出 JS Number 的 53 位安全精度。
    // 直接 `Number(fsId)` 会被静默改写（末尾几位变成 0），服务端收到无效 ID
    // 即返回 `errno=2 参数错误`。必须用 BigInt 精确还原为数字字面量。
    const fsIdLiteral = /^\d+$/.test(fsId) ? BigInt(fsId).toString() : JSON.stringify(fsId);
    const body = `fsidlist=${encodeURIComponent(`[${fsIdLiteral}]`)}&path=${encodeURIComponent(toPath)}`;
    logger.warn(`[baidu] transfer fsId=${fsId} → fsidlist=[${fsIdLiteral}] path=${toPath}`);

    const base = `${HOST}/share/transfer?shareid=${shareid}&from=${uk}&bdstoken=${encodeURIComponent(bdstoken)}&channel=chunlei&web=1&app_id=250528&clienttype=0&t=${Date.now()}`;
    // 变体依次尝试：带 surl(去前导1) → 不带 surl → 带完整 surl。
    // `surl` 在不同账号/时期是否必需并不一致，逐个回退比反复试错更省时间。
    const variants = [
      { label: 'surl-short', url: `${base}&surl=${surlShort}` },
      { label: 'no-surl', url: base },
      { label: 'surl-full', url: `${base}&surl=${this.session.surlFull}` },
    ];

    let d: any = {};
    for (const v of variants) {
      const res = await ctx.request({
        url: v.url,
        method: 'POST',
        headers: this.withRandsk(ctx, randsk, `${HOST}/s/${surlShort}`, {
          // ⚠️ 关键：transfer 是 POST + 表单体，缺此头服务端无法解析 body，
          // 会直接返回 errno=2「参数错误」（实测：补上后立即变为 errno=4 已转存）。
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        data: body,
        responseType: 'json',
      });
      d = res.data ?? {};
      // errno=4 表示「文件已转存」，同样是成功态：目标路径在 duplicated.list 里。
      if (d.errno === 0 || d.errno === 4) {
        logger.info(`[baidu] transfer 成功（变体 ${v.label}，errno=${d.errno}）`);
        break;
      }
      logger.warn(`[baidu] transfer 变体 ${v.label} 失败：errno=${d.errno} msg=${d.show_msg ?? ''}`);
    }
    if (d.errno !== 0 && d.errno !== 4) {
      if (d.errno === 200025) throw new Error('百度转存失败：提取码未生效（BDCLND 缺失或失效）');
      throw new Error(`百度转存失败：errno=${d.errno} msg=${d.show_msg ?? ''}`);
    }
    // errno=0 → extra.list；errno=4（已转存）→ duplicated.list。两者字段结构一致。
    const item = d.extra?.list?.[0] ?? d.duplicated?.list?.[0] ?? {};
    const newFsId = item.to_fs_id ? String(item.to_fs_id) : String(item.fs_id ?? fsId);
    const newPath = String(item.to ?? item.path ?? '');
    logger.info(`[baidu] 转存目标 fsId=${newFsId} path=${newPath}`);
    return { fsId: newFsId, path: newPath };
  }

  /**
   * 在分享内按「转存后的目录名」下钻，取第一个可播放文件的**转存后路径**。
   *
   * 转存过来的常常是整季目录（如 `/李熊猫2026`），而 PCS locatedownload 只接受
   * 具体文件路径。这里借 `share/list`（已实测可用）遍历分享目录结构，
   * 按名称匹配到已转存的那个目录，再把分享内的相对路径拼成本人网盘的绝对路径。
   */
  private async drillShareToFile(ctx: IPanContext, localRoot: string): Promise<string> {
    // 分享内层级（如 /动漫/周三/李熊猫2026）与转存后层级（/李熊猫2026）不同，
    // 因此按「目录名」在分享内定位同名目录，再下钻，最后用**本地根**拼回绝对路径。
    const rootName = localRoot.split('/').filter(Boolean).pop() ?? '';
    if (!rootName) return '';
    const top = await this.listRaw('/', ctx);
    // 优先按「目录+同名」匹配；退化到仅同名（若接口目录字段缺失，能否列内容由 walk 验证）
    const target = top.find((f) => f.isDir && f.name === rootName) ?? top.find((f) => f.name === rootName);
    logger.warn(`[baidu] 下钻定位 rootName="${rootName}" 分享顶层=${top.length} 匹配=${target ? target.path : '无'}`);
    if (!target) return '';

    const walk = async (dir: string, rel: string, depth: number): Promise<string> => {
      if (depth > 4) return '';
      const files = await this.listRaw(dir, ctx);
      const vid = files.find((f) => !f.isDir && isMediaName(f.name));
      if (vid) return `${localRoot}/${rel}${vid.name}`.replace(/\/+/g, '/');
      for (const sub of files.filter((f) => f.isDir)) {
        const r = await walk(sub.path, `${rel}${sub.name}/`, depth + 1);
        if (r) return r;
      }
      return '';
    };
    const found = await walk(target.path, '', 0);
    if (found) logger.info(`[baidu] 转存目录已下钻到文件：${found}`);
    return found;
  }

  /** 列分享内某目录（原始结构，供路径拼装用） */
  private async listRaw(dir: string, ctx: IPanContext): Promise<{ name: string; isDir: boolean; path: string }[]> {
    if (!this.session) return [];
    const { surlShort, shareid, uk, randsk } = this.session;
    const qs = new URLSearchParams({
      shareid,
      uk,
      dir,
      page: '1',
      num: '200',
      order: 'time',
      desc: '1',
      showempty: '0',
      root: dir === '/' ? '1' : '0',
      web: '1',
      channel: 'chunlei',
      app_id: '250528',
      clienttype: '0',
    });
    const res = await ctx.request({
      url: `${HOST}/share/list?${qs.toString()}`,
      method: 'GET',
      headers: this.withRandsk(ctx, randsk, `${HOST}/s/${surlShort}`),
      responseType: 'text',
    });
    const rawText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
    const safe = rawText.replace(/"fs_id"\s*:\s*(\d{15,})/g, '"fs_id":"$1"');
    try {
      const d = JSON.parse(safe);
      const list = ((d.list ?? []) as any[]).map((it) => {
        const name = String(it.server_filename ?? '');
        // ⚠️ share/list 的 category 是 xpan 语义：0=目录, 1=视频, 2=音频, 3=图片…
        // （实测 2026-10-15：顶层目录 category=0、站内 .mkv/.mp4 全部 category=1，
        // 按「1=目录」判定会把文件当目录、把目录当文件，两头全错。）
        // 判定：显式 isdir=1，或 category=0 且名字不带媒体扩展名（扩展名是最强信号）。
        const isDir = it.isdir === 1 || (it.category === 0 && !isMediaName(name));
        return { name, isDir, path: String(it.path ?? '') };
      });
      logger.warn(
        `[baidu] listRaw dir="${dir}" → errno=${d.errno} 条目=${list.length} [${list
          .slice(0, 4)
          .map((x) => `${x.isDir ? '[D]' : '[F]'}${x.name}`)
          .join(', ')}]`,
      );
      return list;
    } catch {
      logger.warn(`[baidu] listRaw dir="${dir}" 解析失败，原始响应前 160 字：${rawText.slice(0, 160)}`);
      return [];
    }
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

    // ⑤ 若转存结果是**目录**（整包分享很常见），下钻到第一个媒体文件。
    //    PCS locatedownload 只接受具体文件，传目录会报 31074。
    let playPath = path;
    if (!isMediaName(path.split('/').pop() ?? '')) {
      const deep = await this.drillShareToFile(ctx, path);
      if (deep) {
        playPath = deep;
      } else {
        throw new Error('百度转存目录内未找到可播放的媒体文件');
      }
    }

    // ⑥ 走 PCS locatedownload 取直链（无需 access_token）
    const dlink = await this.getPcsDlink(playPath, ctx);
    // ⚠️ PCS 直链拉流按「网盘客户端 UA」鉴权：实测浏览器 UA → 403，
    // netdisk UA + Range → 206，且**不需要 Cookie/Referer**（Python 端到端验证形态）。
    // contentType：PCS 回源恒是 application/octet-stream，会让渲染层类型探测判 unknown
    // 而误走 sniffer；按转存文件扩展名登记真实 MIME 交给代理覆盖回传。
    const ext = (playPath.split('.').pop() ?? '').toLowerCase();
    const mime = PLAY_MIME[ext] ?? 'video/mp4';
    return {
      url: dlink,
      headers: { 'User-Agent': PCS_UA },
      contentType: mime,
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
