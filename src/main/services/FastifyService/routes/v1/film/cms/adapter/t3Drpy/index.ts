// (node) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [ChildProcess]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit
import { join } from 'node:path';

import { loggerService } from '@logger';
import { SITE_LOGGER_MAP, SITE_TYPE } from '@shared/config/film';
import { isJson } from '@shared/modules/validate';
import type { ICmsMethodName, ICmsParams, ICmsResultPromise, IConstructorOptions } from '@shared/types/cms';
import type { Pool } from 'workerpool';
import workerpool from 'workerpool';

import {
  encodePanPlayId,
  extractPanShareUrl,
  isPanPlayId,
  isPanShareUrl,
  listPanMedia,
  resolvePanPlay,
} from '../panPlay';

type ICmsResultCustom = Omit<Awaited<ICmsResultPromise>, 'play'> & {
  play: Awaited<ICmsResultPromise['play']> & {
    parse_extra?: string;
    js?: string;
    header?: Record<string, any>;
  };
};

const logger = loggerService.withContext(SITE_LOGGER_MAP[SITE_TYPE.T3_DRPY]);

class T3DrpyAdapter {
  private ext: string = '';
  private categories: string[] = [];

  private pool: Pool | null = null;

  constructor(source: IConstructorOptions) {
    this.ext = source.ext!;
    this.categories = source.categories;
  }

  public async destroy(): Promise<void> {
    if (this.pool) {
      await this.pool.terminate();
      this.pool = null;
    }
  }

  private async execCtx<T extends ICmsMethodName>(type: T, options?: ICmsParams[T]): Promise<ICmsResultCustom[T]> {
    if (!this.pool) {
      this.pool = workerpool.pool(join(import.meta.dirname, 'film_cms_adapter_t3_drpy_worker.js'), {
        workerType: 'process',
        maxWorkers: 1,
        forkOpts: { silent: true },
      });
    }

    const resp = await this.pool.exec('main', [type, options], {
      on(payload) {
        const { type, level, msg } = payload;

        if (type === 'log') {
          // const msgType = msg.type;
          const msgList = msg?.msg ?? [];

          const log = msgList.map((t: any) => (isJson(t) ? JSON.stringify(t) : t)).join(' ');
          if (/\(node:\d+\)/.test(log)) return;

          logger[level](log);
        }
      },
    });

    return resp;
  }

  public async init(): ICmsResultPromise['init'] {
    await this.execCtx('init', this.ext);
  }

  public async home(): ICmsResultPromise['home'] {
    const resp = await this.execCtx('home');

    const rawClassList = Array.isArray(resp?.class) ? resp?.class : [];
    const classes = rawClassList
      .map((item) => ({
        type_id: String(item.type_id ?? '').trim(),
        type_name: item.type_name?.toString().trim() ?? '',
      }))
      .filter(
        (item, index, self) =>
          item.type_id &&
          item.type_name &&
          !this.categories?.includes(item.type_name) &&
          self.findIndex((other) => other.type_id === item.type_id) === index,
      );
    const classIds = classes.map((item) => item.type_id);

    const rawFiltersObj = resp?.filters && Object.keys(resp?.filters).length ? resp.filters : {};
    const filters = Object.keys(rawFiltersObj).reduce((acc, key) => {
      if (String(key) && classIds.includes(String(key))) {
        acc[String(key)] = rawFiltersObj[key];
      }
      return acc;
    }, {});

    return { class: classes, filters };
  }

  public async homeVod(): ICmsResultPromise['homeVod'] {
    const resp = await this.execCtx('homeVod');

    const rawList = Array.isArray(resp?.list) ? resp.list : [];
    const videos = rawList
      .map((v) => ({
        vod_id: String(v.vod_id ?? ''),
        vod_name: v.vod_name ?? '',
        vod_pic: v.vod_pic ?? '',
        vod_remarks: v.vod_remarks ?? '',
        vod_blurb: (v.vod_blurb ?? '')?.trim(),
        vod_tag: ['action', 'file', 'folder'].includes(v.vod_tag || 'file') ? v.vod_tag : 'file',
      }))
      .filter((v) => v.vod_id);

    const pagecurrent = Number(resp?.page) || 1;
    const pagecount = Number(resp?.pagecount) || (videos.length ? 1 : 0);
    const total = Number(resp?.total) || videos.length;

    return { page: pagecurrent, pagecount, total, list: videos };
  }

  public async category(doc: ICmsParams['category']): ICmsResultPromise['category'] {
    const { tid, page = 1, extend = {} } = doc || {};
    const resp = await this.execCtx('category', { tid, page, extend });

    const rawList = Array.isArray(resp?.list) ? resp.list : [];
    const videos = rawList
      .map((v) => ({
        vod_id: String(v.vod_id ?? ''),
        vod_name: v.vod_name ?? '',
        vod_pic: v.vod_pic ?? '',
        vod_remarks: v.vod_remarks ?? '',
        vod_blurb: (v.vod_blurb ?? '')?.trim(),
        vod_tag: ['action', 'file', 'folder'].includes(v.vod_tag || 'file') ? v.vod_tag : 'file',
      }))
      .filter((v) => v.vod_id);

    const pagecurrent = Number(resp?.page) || page;
    const pagecount = Number(resp?.pagecount) || (videos.length ? 1 : 0);
    const total = Number(resp?.total) || videos.length;

    return { page: pagecurrent, pagecount, total, list: videos };
  }

  public async detail(doc: ICmsParams['detail']): ICmsResultPromise['detail'] {
    const { ids } = doc || {};
    const resp = await this.execCtx('detail', { ids });

    const idsArray = [ids];
    const rawList = Array.isArray(resp?.list) ? resp.list : [];
    const videos: any[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const v = rawList[i];
      const item = {
        vod_id: String((v.vod_id || idsArray[i]) ?? ''),
        vod_name: v.vod_name ?? '',
        vod_pic: v.vod_pic ?? '',
        vod_remarks: v.vod_remarks ?? '',
        vod_year: String(v.vod_year ?? ''),
        vod_lang: v.vod_lang ?? '',
        vod_area: v.vod_area ?? '',
        vod_score: String(v.vod_score ?? '0.0'),
        vod_state: v.vod_state ?? '', // '正片' | '预告' | '花絮'
        vod_class: v.vod_class ?? '', // '电影' | '电视剧' | '综艺' | '动漫' | '纪录片' | '其他'
        vod_actor: v.vod_actor ?? '',
        vod_director: v.vod_director ?? '',
        vod_content: (v.vod_content ?? '')?.trim(),
        vod_blurb: (v.vod_blurb ?? '')?.trim(),
        vod_play_from: v.vod_play_from ?? '',
        vod_play_url: v.vod_play_url ?? '',
        type_name: v.type_name ?? '',
      };
      if (!item.vod_id) continue;

      // 网盘型源：把分享链接展开成「一个媒体文件 = 一集」，播放交给主进程解析
      if (item.vod_play_url && item.vod_play_url.includes('$')) {
        const expanded = await this.expandPanPlayUrl(item.vod_play_from, item.vod_play_url);
        item.vod_play_url = expanded.url;
        item.vod_play_from = expanded.from;
      }

      videos.push(item);
    }

    const pagecurrent = Number(resp?.page) || 1;
    const pagecount = Number(resp?.pagecount) || (videos.length ? 1 : 0);
    const total = Number(resp?.total) || videos.length;

    return { page: pagecurrent, pagecount, total, list: videos };
  }

  /**
   * 网盘型源支持：把二级列表里的网盘分享链接展开为「一个媒体文件 = 一集」。
   *
   * 展开后的集链接使用 `pan://<base64url(shareUrl)>|<fileId>` 形式，播放时由
   * play() 交给 PanService 解析成可播放直链。展开失败时保留原始链接，
   * 避免整条播放列表不可用。
   */
  private async expandPanPlayUrl(vodPlayFrom: string, vodPlayUrl: string): Promise<{ from: string; url: string }> {
    const LINE_SEP = '$$$';
    const lines = String(vodPlayUrl).split(LINE_SEP);
    const newLines: string[] = [];

    for (const line of lines) {
      const episodes = line.split('#').filter(Boolean);
      const newEpisodes: string[] = [];

      for (const ep of episodes) {
        const parts = ep.split('$');
        const name = parts[0];
        const link = parts.slice(1).join('$');
        const shareUrl = link ? extractPanShareUrl(link) : '';

        if (!shareUrl) {
          newEpisodes.push(ep);
          continue;
        }

        try {
          const media = await listPanMedia(shareUrl);
          if (!media.files.length) {
            newEpisodes.push(ep);
            continue;
          }
          const single = media.files.length === 1;
          for (const f of media.files) {
            const title = single ? name : f.name.replace(/\.[^.]+$/, '') || name;
            newEpisodes.push(`${title}$${encodePanPlayId(shareUrl, f.fileId)}`);
          }
        } catch (error) {
          logger.warn(`网盘展开失败：${shareUrl} - ${(error as Error)?.message}`);
          newEpisodes.push(ep);
        }
      }

      newLines.push(newEpisodes.join('#'));
    }

    return { from: vodPlayFrom, url: newLines.join(LINE_SEP) };
  }

  public async search(doc: ICmsParams['search']): ICmsResultPromise['search'] {
    const { wd, page = 1 } = doc || {};
    const resp = await this.execCtx('search', { wd, page });

    const rawList = Array.isArray(resp?.list) ? resp.list : [];
    const videos = rawList
      .map((v) => ({
        vod_id: String(v.vod_id ?? ''),
        vod_name: v.vod_name ?? '',
        vod_pic: v.vod_pic ?? '',
        vod_remarks: v.vod_remarks ?? '',
        vod_blurb: (v.vod_blurb ?? '')?.trim(),
        vod_tag: ['action', 'file', 'folder'].includes(v.vod_tag || 'file') ? v.vod_tag : 'file',
      }))
      .filter((v) => v.vod_id);

    const pagecurrent = Number(resp?.page) || page;
    const pagecount = Number(resp?.pagecount) || (videos.length ? 1 : 0);
    const total = Number(resp?.total) || videos.length;

    return { page: pagecurrent, pagecount, total, list: videos };
  }

  public async play(doc: ICmsParams['play']): ICmsResultPromise['play'] {
    const { flag, play } = doc || {};

    // 网盘播放：`pan://` 标识或原始分享链接 → 交给 PanService 解析为代理直链
    // （对应 FongMi 里由 libwexproxy.so 处理网盘的那一步）
    if (play && (isPanPlayId(play) || isPanShareUrl(play))) {
      try {
        const url = await resolvePanPlay(play);
        if (url) {
          return { url, quality: [], parse: 0, jx: 0, headers: {}, script: {} };
        }
      } catch (error) {
        logger.error(`网盘解析失败：${(error as Error)?.message}`);
        throw new Error(`网盘解析失败：${(error as Error)?.message}`);
      }
    }

    const resp = await this.execCtx('play', { flag, play });

    const qs = resp?.parse_extra;
    const scriptObj = qs ? Object.fromEntries(new URLSearchParams(qs)) : {};

    const res = {
      url: (Array.isArray(resp?.url) && resp.url.length > 0 ? resp.url?.[1] : resp?.url) || '',
      quality:
        Array.isArray(resp?.url) && resp.url.length > 0
          ? resp.url.flatMap((name, i, arr) => (i % 2 === 0 && arr[i + 1] ? [{ name, url: arr[i + 1] }] : []))
          : [],
      parse: resp.parse || 0,
      jx: resp.jx || 0,
      headers: resp?.header || resp?.headers || {},
      script: Object.keys(scriptObj).length
        ? {
            ...(resp.js ? { runScript: resp.js } : {}),
            ...(scriptObj.init_script ? { initScript: scriptObj.init_script } : {}),
            ...(scriptObj.custom_regex ? { customRegex: scriptObj.custom_regex } : {}),
            ...(scriptObj.sniffer_exclude ? { snifferExclude: scriptObj.sniffer_exclude } : {}),
          }
        : {},
    };

    return res;
  }

  async action(doc: ICmsParams['action']): ICmsResultPromise['action'] {
    const { action, value, timeout } = doc || {};
    const resp = await this.execCtx('action', { action, value, timeout });
    return resp;
  }

  async proxy(doc: ICmsParams['proxy']): ICmsResultPromise['proxy'] {
    const resp = await this.execCtx('proxy', doc);
    return resp;
  }

  public async runMain(doc: ICmsParams['runMain']): ICmsResultPromise['runMain'] {
    const resp = await this.execCtx('runMain', doc);
    return resp;
  }
}

export default T3DrpyAdapter;
