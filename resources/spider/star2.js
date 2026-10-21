/**
 * 剧透社 1.star2.cn —— zyfun drpy2 源
 *
 * 站点结构：
 *   列表  /{cat}/        第 1 页
 *         /{cat}_{n}/    第 n 页（每页 15 条，剧集约 142 页）
 *   详情  /{cat}/{id}.html —— 内含百度网盘 / 夸克网盘分享链接
 *
 * 播放：详情里只返回「网盘分享链接」，由 zyfun 的 t3Drpy.expandPanPlayUrl
 * 调 PanService 展开成「一个媒体文件 = 一集」，播放时走 /v1/pan/proxy 令牌代理。
 * 所以本源不处理任何直链、Cookie 或签名逻辑。
 */
var rule = {
  title: '剧透社',
  host: 'https://1.star2.cn',
  homeUrl: '/',
  url: '/fyclass/fypage/',
  searchUrl: '/search/?wd=**',
  searchable: 1,
  quickSearch: 0,
  filterable: 0,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  play_parse: true,
  limit: 6,
  double: false,
};

var CATS = [
  ['ju', '剧集'],
  ['mv', '电影'],
  ['dm', '动漫'],
  ['zy', '综艺'],
  ['dj', '短剧'],
  ['xg', '喜剧'],
  ['rh', '日韩'],
  ['ym', '英美'],
  ['wj', '网剧'],
  ['qt', '其他'],
];

/** 列表页 → 视频条目 */
function star2List(html) {
  var out = [];
  var re = /<a[^>]+href="(\/[a-z]{2}\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(html))) {
    var id = m[1];
    var name = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.length < 2) continue;
    if (
      out.some(function (x) {
        return x.vod_id === id;
      })
    )
      continue;
    out.push({ vod_id: id, vod_name: name, vod_pic: '', vod_remarks: '' });
  }
  return out;
}

async function home() {
  var list = [];
  try {
    list = star2List(await request(rule.host + '/')).slice(0, 12);
  } catch (e) {
    log('star2 home 失败: ' + e.message);
  }
  return {
    class: CATS.map(function (c) {
      return { type_id: c[0], type_name: c[1] };
    }),
    list: list,
  };
}

async function category(tid, pg) {
  pg = parseInt(pg) || 1;
  var url = rule.host + '/' + tid + (pg > 1 ? '_' + pg : '') + '/';
  var list = star2List(await request(url));
  return {
    page: pg,
    pagecount: list.length ? pg + 1 : pg,
    limit: 6,
    total: 9999,
    list: list,
  };
}

async function detail(id) {
  var url = id.indexOf('http') === 0 ? id : rule.host + id;
  var html = await request(url);

  var name = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  name =
    name
      .replace(/\s*-\s*剧透社[\s\S]*$/, '')
      .replace(/<[^>]+>/g, '')
      .trim() || id;

  var baidu = (html.match(/https:\/\/pan\.baidu\.com\/s\/[^"'\s<>]+/) || [])[0] || '';
  var quark = (html.match(/https:\/\/pan\.quark\.cn\/s\/[^"'\s<>]+/) || [])[0] || '';

  var froms = [];
  var urls = [];
  if (baidu) {
    froms.push('百度网盘');
    urls.push('全集$' + baidu);
  }
  if (quark) {
    froms.push('夸克网盘');
    urls.push('全集$' + quark);
  }

  return {
    vod_id: id,
    vod_name: name,
    vod_pic: '',
    vod_content: '',
    vod_play_from: froms.join('$$$'),
    vod_play_url: urls.join('$$$'),
  };
}

async function search(wd, quick, pg) {
  var list = [];
  try {
    var html = await request(rule.host + '/search/?wd=' + encodeURIComponent(wd));
    list = star2List(html);
  } catch (e) {
    log('star2 search 失败: ' + e.message);
  }
  return { page: 1, pagecount: 1, limit: 6, total: list.length, list: list };
}
