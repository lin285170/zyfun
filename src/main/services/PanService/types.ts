/**
 * 网盘驱动的公共类型定义。
 *
 * 设计目标：把「分享链接 → 文件列表 → 可播放直链」这条链路抽象成统一接口，
 * 各网盘（夸克 / 123pan / 阿里 / 百度 / 115 …）只实现差异部分。
 *
 * 与 FongMi 的 wex 方案对应关系：
 *   wex:  客户端内置网盘代理（libwexproxy.so，pan.priority=baidu,quark,uc,pan115,pan123）
 *   本模块: 主进程内的 TS 实现，通过 t3Pan 适配器暴露给爬虫体系
 */

/** 支持的网盘标识 */
export const PAN_DRIVER_ID = {
  QUARK: 'quark',
  PAN123: 'pan123',
  ALIPAN: 'alipan',
  BAIDU: 'baidu',
  PAN115: 'pan115',
} as const;

export type IPanDriverId = (typeof PAN_DRIVER_ID)[keyof typeof PAN_DRIVER_ID];

export const panDriverIds = Object.values(PAN_DRIVER_ID);

/** 网盘凭据：不同网盘字段不同，统一用 kv 承载 */
export interface IPanCredential {
  /** 网盘标识 */
  driver: IPanDriverId;
  /** 展示名 */
  name?: string;
  /** Cookie 串（夸克/百度等以 Cookie 为主） */
  cookie?: string;
  /** access_token（123pan/阿里等以 token 为主） */
  token?: string;
  /** 刷新令牌（可选） */
  refreshToken?: string;
  /** 扩展字段（如阿里 driveId、115 的 uid 等） */
  extra?: Record<string, string>;
  /** 是否启用 */
  enabled?: boolean;
  updatedAt?: number;
}

/** 分享链接解析出的单个文件/目录项 */
export interface IPanFile {
  /** 网盘内的文件 id（夸克为 fid，123pan 为 fileId） */
  fileId: string;
  /** 文件名（通常即“第01集”之类） */
  name: string;
  /** 文件大小（字节，未知为 0） */
  size: number;
  /** 是否目录 */
  isDir: boolean;
  /**
   * 分享侧的文件令牌。
   * 夸克的 `share_fid_token`、百度的 `fs_id` 等——**转存时必需**，
   * 且与 `fileId` 不同：`fileId` 是分享内的 id，转存后会产生新的本地 id。
   */
  token?: string;
  /** 子项（目录展开后填充） */
  children?: IPanFile[];
}

/** 解析分享链接的结果 */
export interface IPanShareResult {
  /** 分享标题 */
  title: string;
  /** 文件树（或平铺列表） */
  files: IPanFile[];
  /** 分享链接本身 */
  shareUrl: string;
  /** 驱动标识 */
  driver: IPanDriverId;
}

/** 可播放信息 */
export interface IPanPlayInfo {
  /** 直链（可能是临时签名 URL） */
  url: string;
  /** 播放所需的请求头（Referer / User-Agent 等） */
  headers?: Record<string, string>;
  /** 直链过期时间（ms 时间戳，0 表示未知） */
  expiresAt?: number;
  /**
   * 响应播放器时的 MIME 类型。网盘直链（尤其百度 PCS）回源常是
   * application/octet-stream，会让渲染层 checkPlayable 判定 unknown 而误走 sniffer；
   * 代理据此覆盖回传，并在 HEAD 探测时直接返回。
   */
  contentType?: string;
  /**
   * 该直链允许的上游并发数（缺省 6）。
   *
   * 2026-10-16 抓包修正：限速模型**取决于通道而非网盘**。
   *  - 百度 PCS `locatedownload` 通道（bd*-cm00）：实测 1/2/4/8 并发聚合
   *    216/129/86/118KB/s，并发无益；
   *  - 百度**分享下载**通道（appall*.baidupcs.com）：FongMi 用 8~17 并发
   *    把聚合拉到 ~1.5MB/s，并发线性有效 → 给 12。
   */
  maxUpstream?: number;
  /**
   * 代理侧预取深度（段数，缺省 6）。收到播放器请求时并行预取后续 N 段，
   * 段长固定 1MB，因此该值同时决定「最多提前缓冲多少 MB」。
   */
  prefetch?: number;
}

/** 驱动运行上下文 */
export interface IPanContext {
  /** 取凭据（按驱动） */
  credential: IPanCredential;
  /** 发 HTTP 请求（复用主进程 request 工具，便于统一超时/代理） */
  request: (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: any;
    responseType?: 'json' | 'text' | 'arraybuffer';
    timeout?: number;
  }) => Promise<{ status: number; headers: Record<string, any>; data: any }>;
  /** 日志 */
  logger: {
    info: (msg: string, ...args: any[]) => void;
    warn: (msg: string, ...args: any[]) => void;
    error: (msg: string, ...args: any[]) => void;
  };
}

/**
 * 网盘驱动接口。
 *
 * 实现约定：
 * - `match` 必须只做字符串判断，不发网络请求（用于快速分派）。
 * - `resolve` 只负责把分享链接变成文件列表，不关心播放。
 * - `play` 负责把 fileId 换成可播放直链；若直链需要特殊请求头，一并返回。
 */
export interface IPanDriver {
  /** 驱动标识 */
  id: IPanDriverId;
  /** 展示名 */
  name: string;
  /** 该驱动需要哪些凭据字段（用于 UI 提示与校验） */
  credentialFields: Array<'cookie' | 'token' | 'refreshToken'>;

  /** 判断是否由本驱动处理该链接 */
  match: (link: string) => boolean;

  /** 解析分享链接 → 文件列表 */
  resolve: (link: string, ctx: IPanContext) => Promise<IPanShareResult>;

  /** 取播放直链 */
  play: (
    fileId: string,
    ctx: IPanContext,
    share?: {
      shareUrl?: string;
      title?: string;
      /** 分享侧文件令牌（转存必需，取自 resolve 结果的 IPanFile.token） */
      token?: string;
    },
  ) => Promise<IPanPlayInfo>;

  /** 凭据自检（可选） */
  check?: (ctx: IPanContext) => Promise<boolean>;
}

/** 从一段文本里挑选出第一个可被某驱动处理的分享链接 */
export const PAN_LINK_RE =
  /https?:\/\/(?:pan\.quark\.cn|www\.123pan\.com|www\.alipan\.com|aliyundrive\.com|pan\.baidu\.com|115\.com|anxia\.com|www\.aliyundrive\.com)[^\s"'<>]*/gi;
