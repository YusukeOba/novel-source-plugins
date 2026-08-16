/**
 * 小説家になろう（全年齢）。
 *
 * メタ情報・ランキングは公式APIから、目次と本文はページから読む。
 */
const manifest = {
  id: "narou",
  name: "小説家になろう",
  version: "1.0.0",
  // syosetu.com の CSS 変数 --color-site
  accent: "#18b7cd",
  hosts: ["syosetu.com", "api.syosetu.com", "ncode.syosetu.com"],
  // **大文字小文字の両方に当てる。** 作品IDは大文字で持つ（N1234AB）のに、
  // サイトのURLは小文字で書かれる。片方だけにすると、
  // **自分のアプリから共有したURLを自分で開けない**
  urlPatterns: [
    "ncode\\.syosetu\\.com/novelview/infotop/ncode/([nN]\\d{4}[a-zA-Z]{1,2})",
    "ncode\\.syosetu\\.com/([nN]\\d{4}[a-zA-Z]{1,2})(?:[/?#]|$)",
  ],
  novelPageUrl: "https://ncode.syosetu.com/{id}/",
  rankingPeriods: [
    { key: "daily", label: "日間" },
    { key: "weekly", label: "週間" },
    { key: "monthly", label: "月間" },
    { key: "quarterly", label: "四半期" },
  ],
  // 条件だけの検索をAPIが受け付ける
  emptyQuery: true,
  tagFilterKey: "tag",
  filters: [
    { type: "text", key: "tag", label: "タグ", placeholder: "異世界転生 など" },
    { type: "text", key: "notword", label: "除外キーワード" },
    {
      type: "choice", key: "order", label: "並び順",
      options: [
        { value: "", label: "既定（新着更新順）" },
        { value: "hyoka", label: "総合評価が高い順" },
        { value: "dailypoint", label: "日間ポイント順" },
        { value: "weeklypoint", label: "週間ポイント順" },
        { value: "favnovelcnt", label: "ブックマークが多い順" },
        { value: "new", label: "新着投稿順" },
      ],
    },
    {
      type: "choice", key: "biggenre", label: "ジャンル",
      options: [
        { value: "", label: "指定なし" },
        { value: "1", label: "恋愛" },
        { value: "2", label: "ファンタジー" },
        { value: "3", label: "文芸" },
        { value: "4", label: "SF" },
        { value: "99", label: "その他" },
        { value: "98", label: "ノンジャンル" },
      ],
    },
    {
      type: "choice", key: "type", label: "連載状態",
      options: [
        { value: "", label: "指定なし" },
        { value: "t", label: "短編" },
        { value: "r", label: "連載中" },
        { value: "er", label: "完結済み" },
      ],
    },
    {
      type: "choice", key: "length", label: "長さ",
      options: [
        { value: "", label: "指定なし" },
        { value: "-20000", label: "2万字未満" },
        { value: "20000-100000", label: "2〜10万字" },
        { value: "100000-300000", label: "10〜30万字" },
        { value: "300000-", label: "30万字以上" },
      ],
    },
    { type: "toggle", key: "notr15", label: "R15を除く" },
    { type: "toggle", key: "notzankoku", label: "残酷な描写ありを除く" },
    { type: "toggle", key: "stop", label: "長期連載停止中を除く" },
    { type: "range", key: "fav", label: "ブックマーク", unit: "件" },
  ],
};

const API = "https://api.syosetu.com/novelapi/api/";
const RANK_API = "https://api.syosetu.com/rank/rankget/";
const PAGE_SIZE = 20;

/** 既定では返らない項目があるので、要るものを明示して取る */
const FIELDS = "t-n-w-s-ga-gl-nu-l-gp-a-f-e-nt-ir-izk-k";

async function getJson(url) {
  const res = await host.fetch(url);
  if (res.status !== 200) throw new Error("取得できませんでした（" + res.status + "）");
  return JSON.parse(res.body);
}

function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

/** `2026-08-15 12:34:56` → ミリ秒。読めなければ null */
function toEpoch(value) {
  if (!value) return null;
  const m = String(value).trim().replace(/\//g, "-")
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function toSummary(novel) {
  return {
    id: String(novel.ncode || "").toUpperCase(),
    title: novel.title || "",
    author: novel.writer || "",
    synopsis: novel.story || "",
    episodeCount: novel.general_all_no || 0,
    lastUpdatedAt: toEpoch(novel.general_lastup),
    revisedAt: toEpoch(novel.novelupdated_at),
    length: novel.length || null,
    bookmarkCount: novel.fav_novel_cnt != null ? novel.fav_novel_cnt : null,
    allPoint: novel.all_point != null ? novel.all_point : null,
    // end=0 が連載中。短編は noveltype=2
    serializing: novel.noveltype === 2 ? false : novel.end === 0,
    isShort: novel.noveltype === 2,
    isR15: novel.isr15 === 1,
    isCruel: novel.iszankoku === 1,
    tags: String(novel.keyword || "").split(/\s+/).filter(Boolean),
  };
}

/** 先頭の要素は {"allcount": N} なので落とす */
function novelsOf(json) {
  return Array.isArray(json) ? json.slice(1) : [];
}

async function search(q, page, filter) {
  filter = filter || {};
  // タグはキーワード欄も検索対象に含まれるので、語として足す
  const word = [q, filter.tag].map(s => (s || "").trim()).filter(Boolean).join(" ");
  const json = await getJson(API + "?" + query({
    out: "json",
    word: word || undefined,
    notword: filter.notword,
    lim: PAGE_SIZE,
    st: (page - 1) * PAGE_SIZE + 1,
    of: FIELDS,
    order: filter.order,
    biggenre: filter.biggenre,
    type: filter.type,
    length: filter.length,
    notr15: filter.notr15 === "1" ? 1 : undefined,
    notzankoku: filter.notzankoku === "1" ? 1 : undefined,
    stop: filter.stop === "1" ? 1 : undefined,
  }));
  let items = novelsOf(json).map(toSummary);
  // APIに渡せない条件はここで落とす。**本体には渡さない** —
  // 条件の意味を知っているのは配信元だけである
  const min = parseInt(filter["fav.min"], 10);
  const max = parseInt(filter["fav.max"], 10);
  if (!isNaN(min)) items = items.filter(i => (i.bookmarkCount || 0) >= min);
  if (!isNaN(max)) items = items.filter(i => (i.bookmarkCount || 0) <= max);
  return items;
}

const RANK_SUFFIX = { daily: "d", weekly: "w", monthly: "m", quarterly: "q" };

function stamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return "" + y + m + d;
}

async function ranking(period) {
  const suffix = RANK_SUFFIX[period];
  if (!suffix) throw new Error("この期間には対応していません");
  // 当日ぶんは集計が終わるまで存在しない。決め打ちすると朝は必ず空になるので、
  // 取れる日付まで遡る
  let entries = [];
  const now = new Date();
  for (let back = 0; back < 8 && entries.length === 0; back++) {
    const day = new Date(now.getTime() - back * 86400000);
    // 週間は火曜、月間・四半期は1日が起点
    if (suffix === "w") { while (day.getUTCDay() !== 2) day.setUTCDate(day.getUTCDate() - 1); }
    if (suffix === "m" || suffix === "q") day.setUTCDate(1);
    const json = await getJson(RANK_API + "?" + query({ out: "json", rtype: stamp(day) + "-" + suffix }));
    if (Array.isArray(json) && json.length > 0) entries = json;
  }
  if (entries.length === 0) throw new Error("この期間のランキングはまだ公開されていません");
  const codes = entries.slice(0, 50).map(e => e.ncode);
  const detailed = await summaries(codes);
  const order = new Map(codes.map((c, i) => [String(c).toUpperCase(), i]));
  // **順位を知らない作品を 0 位にしない。** `|| 0` だと、1位より前に出てしまう。
  // 順位はこの一覧の意味そのものなので、知らないものは末尾へ回す
  return detailed.sort((a, b) => {
    const left = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const right = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

async function summaries(ids) {
  if (!ids || ids.length === 0) return [];
  const out = [];
  // lim を送らないと既定の20件で打ち切られ、21件目以降が黙って返らない
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const json = await getJson(API + "?" + query({
      out: "json", ncode: batch.join("-"), lim: batch.length, of: FIELDS,
    }));
    novelsOf(json).forEach(n => out.push(toSummary(n)));
  }
  return out;
}

async function detail(id) {
  const code = String(id).toLowerCase();
  const base = "https://ncode.syosetu.com/" + code + "/";
  const first = await host.fetch(base);
  if (first.status !== 200) throw new Error("作品ページを開けませんでした");

  const meta = (await summaries([id]))[0];
  const episodes = [];
  let complete = true;

  const lastPage = pagerLast(first.body);
  episodes.push(...episodesIn(first.body, code));
  for (let p = 2; p <= lastPage; p++) {
    const res = await host.fetch(base + "?p=" + p);
    if (res.status !== 200) { complete = false; break; }
    const found = episodesIn(res.body, code);
    // 途中のページが中身の無いHTMLを返すことがある。**そこで打ち切って
    // 「これで全部」と言わない** — 目次に無い話として既読や保存本文が消える
    if (found.length === 0) { complete = false; break; }
    episodes.push(...found);
  }

  // **話番号は本文URLの数字をそのまま使う。** 並んだ順で振り直すと、
  // 途中のページを取りこぼしたときに以降が全部ずれ、既読としおりが別の話に付く
  episodes.forEach((e, i) => {
    const fromUrl = parseInt(e.episodeKey, 10);
    e.episodeNo = isNaN(fromUrl) ? i + 1 : fromUrl;
  });
  // 番号が飛んでいるなら取りこぼしている。飛びは作者の削除でも起きるが、
  // **「取り切れた」と言い切れない**ことに変わりはない
  if (episodes.length > 0 && episodes[episodes.length - 1].episodeNo !== episodes.length) {
    complete = false;
  }

  return {
    summary: meta || { id: String(id).toUpperCase(), title: "", author: "", episodeCount: episodes.length },
    episodes: episodes,
    tocComplete: complete,
  };
}

function pagerLast(html) {
  const last = host.select(html, ".c-pager__item--last")[0];
  if (!last) return 1;
  const href = host.attr(last, "href") || "";
  const m = href.match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function episodesIn(html, code) {
  const out = [];
  let chapter = null;
  const nodes = host.select(html, ".p-eplist__chapter-title, .p-eplist__sublist");
  for (const node of nodes) {
    if (node.indexOf("p-eplist__chapter-title") >= 0) {
      chapter = host.text(node).trim() || null;
      continue;
    }
    const link = host.select(node, "a.p-eplist__subtitle")[0];
    if (!link) continue;
    const href = host.attr(link, "href") || "";
    const m = href.match(new RegExp("^/" + code + "/(\\d+)/?$"));
    if (!m) continue;
    const update = host.select(node, ".p-eplist__update")[0];
    out.push({
      episodeKey: m[1],
      title: host.text(link).trim(),
      chapter: chapter,
      sourceUpdatedAt: update ? parseUpdate(update) : null,
    });
  }
  return out;
}

/** 改稿があると `title` 属性に改稿日時が入る。無ければ表示されている掲載日時 */
function parseUpdate(html) {
  const revised = host.select(html, "span[title]")[0];
  if (revised) {
    const value = host.attr(revised, "title") || "";
    const stamped = toEpoch(value.replace(/[（(].*$/, ""));
    if (stamped) return stamped;
  }
  return toEpoch(host.text(html));
}

async function episode(novelId, episodeKey, episodeNo) {
  const code = String(novelId).toLowerCase();
  const key = episodeKey || String(episodeNo);
  const res = await host.fetch("https://ncode.syosetu.com/" + code + "/" + key + "/");
  if (res.status !== 200) throw new Error("本文を取得できませんでした（" + res.status + "）");

  const titleNode = host.select(res.body, "h1.p-novel__title")[0];
  const body = host.select(res.body, ".p-novel__body")[0] || host.select(res.body, "#novel_honbun")[0];
  if (!body) throw new Error("本文が見つかりませんでした（ページの作りが変わった可能性があります）");

  const paragraphs = [];
  // 前書き・本文・あとがきは別の区画で出る。同じ顔で続けると、
  // 毎話「今日は暑いですね」から本文が始まったように読める
  const sections = [
    [".p-novel__text--preface", "PREFACE"],
    [".p-novel__text:not(.p-novel__text--preface):not(.p-novel__text--afterword)", "BODY"],
    [".p-novel__text--afterword", "AFTERWORD"],
  ];
  let found = false;
  for (const [selector, role] of sections) {
    for (const section of host.select(body, selector)) {
      found = true;
      host.paragraphs(section).forEach(p => paragraphs.push(Object.assign({}, p, { role: role })));
    }
  }
  if (!found) host.paragraphs(body).forEach(p => paragraphs.push(p));

  return {
    episodeNo: episodeNo,
    title: titleNode ? host.text(titleNode).trim() : "",
    paragraphs: paragraphs.filter(p => (p.text && p.text.trim()) || p.imageUrl),
  };
}
