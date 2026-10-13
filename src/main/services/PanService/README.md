# PanService —— 网盘解析能力

为 zyfun（fork：`lin285170/zyfun`）新增的网盘解析模块，目标是对齐 FongMi 影视
（含 wex 加固源）的「配置网盘账号 → 播放网盘资源」体验。

## 为什么需要自建

zyfun 上游（3.4.8-rc2）**不具备**网盘账号与网盘播放能力：

| 核查项 | 结果 |
| --- | --- |
| `DbService/schemas/drive.ts` | 已移除（README 标注 `<3.4.1 弃用`） |
| 网盘账号登录 UI | 无 |
| `setting.ts` 中的 `QUARK` | 是 `REC_HOT_TYPE`（热门榜单数据源），与网盘无关 |
| 唯一的网盘相关适配器 `T3_ALIST` | 连接的是**外部 AList 服务**（账号是 AList 的），不是网盘 |

而 FongMi 体系由 `libwexproxy.so`（10.9 MB Go 库，`pan.priority=baidu,quark,uc,pan115,pan123`）
在本地完成网盘解析与代理。本模块把同等能力放进 zyfun 主进程。

## 目录结构

```
src/main/services/PanService/
  types.ts              驱动接口（IPanDriver）与公共类型
  drivers/
    quark.ts            夸克网盘驱动
    baidu.ts            百度网盘驱动
  store.ts              凭据存储（JSON，位于 userData/pan-credentials.json）
  proxy.ts              直链代理令牌管理
  index.ts              PanService 入口（驱动注册与分派）

src/main/services/FastifyService/routes/v1/pan/index.ts   网盘 API 路由
src/main/services/FastifyService/routes/v1/film/cms/adapter/t3Pan.ts   爬虫适配器
```

## 已接入的能力

### 1. 夸克网盘（`quark`）

链路：分享链接 → `sharepage/token` 取 stoken → `sharepage/detail` 列文件
→ `sharepage/save` 转存 → `file/download` 取直链。

- 匿名可读分享的 stoken 与文件列表
- 播放需登录 Cookie（`__puus` / `__uid`），否则转存会返回未登录错误

### 2. 百度网盘（`baidu`）

链路：`shorturlinfo` 取 shareid/uk/randsk → 有提取码时 `share/verify`
→ `share/list` 列文件 → `share/transfer` 转存 → `api/filemetas?dlink=1` 取直链。

- 需要 Cookie（含 `BDUSS`）
- `bdstoken` 运行时按需获取，不缓存
- 提取码会以 `BDCLND` 注入 Cookie

### 3. 直链代理（令牌化，避免凭据泄露）

网盘直链必须带 `Referer` / `User-Agent` / 有时还有 `Cookie`，播放器直连会 403。
zyfun 现有 `/proxy` 只支持 `?url=`、不做请求头透传，因此单独实现：

```
play() → panProxy.register({url, headers}) → 返回 /api/v1/pan/proxy?token=xxx
播放器 ← 代理路由按 token 取回直链与请求头，流式转发（透传 Range）
```

**凭据不进入 URL**，避免出现在日志与播放历史里。令牌 TTL 30 分钟。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/pan/proxy?token=` | 直链代理（透传 Range） |
| GET | `/api/v1/pan/drivers` | 驱动列表 |
| GET | `/api/v1/pan/credentials` | 凭据列表（脱敏） |
| POST | `/api/v1/pan/credentials` | 保存凭据 |
| DELETE | `/api/v1/pan/credentials?driver=` | 删除凭据 |
| POST | `/api/v1/pan/check` | 凭据自检 |

## 新适配器 T3_PAN（type = 18）

把一个网盘分享链接直接变成一个可用源：

```json
{
  "name": "我的夸克资源",
  "shareUrl": "https://pan.quark.cn/s/xxxxxxxx",
  "passcode": "abcd",
  "driver": "quark"
}
```

- `home()` / `detail()`：列出网盘内的文件（目录自动展开）
- `play()`：解析直链并输出代理地址
- `search()`：网盘直连源无在线搜索，返回空列表

## 待办与已知限制

1. **驱动需真实账号验证**：夸克/百度的接口参数随版本演进（签名、风控头），
   首次使用请通过 `/api/v1/pan/check` 与日志定位需要补齐的字段。
2. **转存路径**：百度当前转存到 `/我的资源`，如需可配置化。
3. **凭据为明文 JSON**：如需更强保护可接入系统钥匙串（接口已按 kv 设计，替换成本低）。
4. **UI 尚未接入**：当前可通过上述 API 直接配置凭据；设置页的图形界面待补。
5. **许可**：zyfun 为 AGPL-3.0，本 fork 及其衍生作品需同样以 AGPL-3.0 开源。
