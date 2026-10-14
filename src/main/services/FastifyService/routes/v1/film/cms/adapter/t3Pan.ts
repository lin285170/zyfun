/**
 * T3_PAN 适配器 —— 网盘直连源。
 *
 * 把一个网盘分享链接直接变成一个可用的「源」：列表就是网盘内的文件/剧集，
 * 播放则通过 PanService 解析出直链（再经令牌代理转发给播放器）。
 *
 * ext 取值（JSON 字符串，或指向 JSON 的 http 地址）：
 *   {
 *     "name":      "我的夸克资源",          // 可选，源名称
 *     "shareUrl":  "https://pan.quark.cn/s/xxxxxx",
 *     "passcode":  "abcd",                  // 可选：链接未自带提取码时填
 *     "driver":    "quark"                  // 可选：不填则按链接自动识别
 *   }
 *
 * 与 FongMi 的对应关系：FongMi 由 libwexproxy.so 在本地做网盘解析与代理；
 * 本适配器把同等能力放进 zyfun 主进程，并通过 /api/v1/pan/proxy 输出。
 */
import { panService } from '@main/services/PanService';
import { toProxyUrl } from '@main/services/PanService/proxy';
import type { IPanFile, IPanShareResult } from '@main/services/PanService/types';
import { PREFIX_API } from '@shared/config/env';
import type { ICmsParams, ICmsResultPromise, IConstructorOptions } from '@shared/types/cms';
import JSON5 from 'json5';

interface IPanSource {
  name?: string;
  shareUrl: string;
  passcode?: string;
  driver?: string;
}

class T3PanAdapter {
  private ext: string = '';
  private source: IPanSource = { shareUrl: '' };
  private share: IPanShareResult | null = null;
  private tokenMap: Map<string, string> | null = null;

  constructor(source: IConstructorOptions) {
    this.ext = source.ext!;
  }

  async init(): ICmsResultPromise['init'] {
    let ext = this.ext;
    if (ext.startsWith('http')) {
      const { request } = await import('@main/utils/request');
      const { data } = await request.request({ url: ext, method: 'GET', responseType: 'text' });
      ext = data as string;
    }
    if (ext && (ext.trim().startsWith('{') || ext.trim().startsWith('['))) {
      this.source = JSON5.parse(ext) as IPanSource;
    } else {
      // 允许直接把分享链接当作 ext
      this.source = { shareUrl: ext.trim() };
    }
    if (this.source.passcode && !this.source.shareUrl.includes('pwd=')) {
      this.source.shareUrl += `${this.source.shareUrl.includes('?') ? '&' : '?'}pwd=${this.source.passcode}`;
    }
    if (!this.source.shareUrl) {
      throw new Error('T3_PAN 需要 ext 提供 shareUrl');
    }
    return undefined;
  }

  /** 拉取（并缓存）分享内容 */
  private async ensureShare(): Promise<IPanShareResult> {
    if (this.share) return this.share;
    this.share = await panService.resolve(this.source.shareUrl);
    return this.share;
  }

  /** 展平文件树为「以文件为单位」的列表 */
  private flatten(files: IPanFile[], out: IPanFile[] = []): IPanFile[] {
    for (const f of files) {
      if (f.isDir) this.flatten(f.children ?? [], out);
      else out.push(f);
    }
    return out;
  }

  /**
   * 取分享上下文（含 fileId → token 映射）。
   *
   * 转存需要分享侧的 token（夸克 `share_fid_token`），而 zyfun 的播放 id
   * 只能传一个字符串，因此这里在 resolve 阶段把映射缓存起来。
   */
  private async shareCtx(): Promise<{ share: IPanShareResult; tokenOf: (fid: string) => string }> {
    const share = await this.ensureShare();
    if (!this.tokenMap) {
      this.tokenMap = new Map();
      const walk = (list: IPanFile[]) => {
        for (const f of list) {
          if (f.token) this.tokenMap!.set(f.fileId, f.token);
          if (f.children?.length) walk(f.children);
        }
      };
      walk(share.files);
    }
    return { share, tokenOf: (fid: string) => this.tokenMap!.get(fid) ?? '' };
  }

  async home(): ICmsResultPromise['home'] {
    const share = await this.ensureShare();
    return {
      class: [{ type_id: 'root', type_name: this.source.name || share.title || '网盘' }],
      filters: {},
    };
  }

  /** 首页内容：把网盘文件作为列表 */
  async homeVod(): ICmsResultPromise['homeVod'] {
    const share = await this.ensureShare();
    const items = this.flatten(share.files).map((f) => ({
      vod_id: f.fileId,
      vod_name: f.name,
      vod_pic: '',
      vod_remarks: this.sizeText(f.size),
      vod_blurb: '',
      vod_tag: 'file',
    }));
    return { page: 1, pagecount: 1, total: items.length, list: items };
  }

  async category(_doc: ICmsParams['category']): ICmsResultPromise['category'] {
    const r = await this.homeVod();
    return { page: 1, pagecount: 1, total: (r as any).total, list: (r as any).list };
  }

  async detail(doc: ICmsParams['detail']): ICmsResultPromise['detail'] {
    const id = String((doc as any).ids ?? '').split(',')[0];
    const share = await this.ensureShare();
    const files = this.flatten(share.files);
    const target = files.find((f) => f.fileId === id) ?? files[0];
    if (!target) throw new Error('网盘内未找到可播放文件');

    // 生成播放列表：一个文件一集
    const episodes = files.map((f) => `${f.name}$${f.fileId}`).join('#');
    return {
      page: 1,
      pagecount: 1,
      total: 1,
      list: [
        {
          vod_id: target.fileId,
          vod_name: share.title || target.name,
          vod_pic: '',
          vod_remarks: `${files.length} 个文件`,
          vod_blurb: `来源：${share.driver}`,
          vod_content: `来源：${share.driver} 文件数：${files.length}`,
          vod_play_from: this.source.name || share.driver,
          vod_play_url: episodes,
        },
      ],
    };
  }

  async search(_doc: ICmsParams['search']): ICmsResultPromise['search'] {
    // 网盘直连源不支持在线搜索，返回空列表（避免报错）
    return { page: 1, pagecount: 1, total: 0, list: [] };
  }

  async play(doc: ICmsParams['play']): ICmsResultPromise['play'] {
    const fileId = String((doc as any).play ?? '');
    if (!fileId) throw new Error('缺少播放 id');

    const { share, tokenOf } = await this.shareCtx();
    const driver = panService.getDriver(this.source.driver || share.driver);
    if (!driver) throw new Error(`未找到网盘驱动：${share.driver}`);
    const ctx = await panService.context(driver.id);
    const info = await driver.play(fileId, ctx, {
      shareUrl: this.source.shareUrl,
      title: share.title,
      token: tokenOf(fileId), // 转存必需：分享侧文件令牌
    });

    // 经令牌代理输出，避免把网盘 Cookie 暴露到播放地址
    const url = toProxyUrl(PREFIX_API || 'http://127.0.0.1:9978/api', info);
    return { url, parse: 0 };
  }

  async action(_doc: ICmsParams['action']): ICmsResultPromise['action'] {
    throw new Error('T3_PAN 不支持 action');
  }

  async proxy(_doc: ICmsParams['proxy']): ICmsResultPromise['proxy'] {
    throw new Error('T3_PAN 不支持 proxy');
  }

  async runMain(_doc: ICmsParams['runMain']): ICmsResultPromise['runMain'] {
    return undefined;
  }

  private sizeText(size: number): string {
    if (!size) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = size;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(1)}${u[i]}`;
  }
}

export default T3PanAdapter;
