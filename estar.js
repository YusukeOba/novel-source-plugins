/**
 * エブリスタ。
 *
 * ページは Nuxt で組み立てられていて、本文も目次も `__NUXT_DATA__` の中にある。
 * この payload は「値をひとつの配列に並べ、参照は添字で表す」形なので、
 * 素直に読むには添字をたどる必要がある（deref）。
 */
const manifest = {
  id: "estar",
  name: "エブリスタ",
  version: "1.1.0",
  accent: "#00a960",
  hosts: ["estar.jp"],
  urlPatterns: ["estar\\.jp/novels/(\\d+)"],
  novelPageUrl: "https://estar.jp/novels/{id}",
  // 期間は `ranking_axis_type` そのもの。日間だけ `general_popular` という
  // 名前で、ほかと揃っていない
  rankingPeriods: [
    { key: "general_popular", label: "日間" },
    { key: "monthly_popular", label: "月間" },
    { key: "quarterly_popular", label: "四半期" },
    { key: "yearly_popular", label: "年間" },
  ],
  emptyQuery: true,
  tagFilterKey: "tag",
  filters: [
    { type: "text", key: "tag", label: "タグ" },
    {
      type: "choice", key: "sort", label: "並び順",
      options: [
        { value: "", label: "既定" },
        { value: "score_desc", label: "人気順" },
        { value: "published_at_desc", label: "新着順" },
      ],
    },
  ],
};

const BASE = "https://estar.jp";

/**
 * Nuxt の payload を取り出す。
 *
 * **0件と「読めなかった」を混ぜない。** 空で返すと画面が「見つかりませんでした」と
 * 出し、利用者は検索語を変え続けることになる
 */
async function payload(url) {
  const res = await host.fetch(url);
  if (res.status === 404) throw new Error("この作品は見つかりませんでした（404）");
  if (res.status !== 200) throw new Error("取得できませんでした（" + res.status + "）");
  const script = host.select(res.body, "script#__NUXT_DATA__")[0];
  if (!script) {
    throw new Error("ページの作りが変わった可能性があります（データが見つかりません）");
  }
  const data = JSON.parse(host.text(script));
  if (!Array.isArray(data)) {
    throw new Error("ページの作りが変わった可能性があります（データの形が違います）");
  }
  return data;
}

/**
 * 添字をたどって実体にする。
 *
 * payload は値の配列で、オブジェクトの鍵も値も添字で書かれている。
 * **深さを切る** — 参照が輪になっていることがあり、素直にたどると戻ってこない
 */
function deref(data, value, depth) {
  depth = depth || 0;
  if (depth > 8) return null;
  if (typeof value !== "number" || value < 0 || value >= data.length) return value;
  const target = data[value];
  if (Array.isArray(target)) {
    return target.slice(0, 500).map(v => deref(data, v, depth + 1));
  }
  if (target && typeof target === "object") {
    // 鍵は文字列そのもの。値だけが添字で書かれている
    const out = {};
    for (const key of Object.keys(target)) {
      out[key] = deref(data, target[key], depth + 1);
    }
    return out;
  }
  return target;
}

/** payload の中から、指定の鍵をすべて持つオブジェクトを集める */
function collect(data, required) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const node = data[i];
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const names = Object.keys(node);
    if (required.every(r => names.indexOf(r) >= 0)) {
      out.push(deref(data, i));
    }
  }
  return out;
}

function toSummary(work) {
  return {
    id: String(work.workId || work.id || ""),
    title: work.title || "",
    author: (work.user && (work.user.nickname || work.user.name)) || "",
    // 短い惹句と長い紹介の両方がある。あらすじには長いほうを使う
    synopsis: work.description || work.catchphrase || "",
    // 話数は一覧に出ない（出るのは総文字数）。目次を取るまで分からないので 0
    episodeCount: 0,
    lastUpdatedAt: toEpoch(work.bodyUpdatedAt || work.updatedAt || work.publishedAt),
    revisedAt: null,
    length: typeof work.publishedBodyCount === "number" ? work.publishedBodyCount : null,
    // 「しおり数」は出るが、評価とは別の指標。**混ぜない**
    bookmarkCount: null,
    allPoint: null,
    serializing: work.status === "published" ? true
      : work.status === "completed" ? false : null,
    isShort: null,
    isR15: null,
    isCruel: false,
    tags: Array.isArray(work.tags)
      ? work.tags.map(t => (typeof t === "string" ? t : t && t.name)).filter(Boolean)
      : [],
  };
}

function toEpoch(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return isNaN(t) ? null : t;
}

function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

async function search(q, page, filter) {
  filter = filter || {};
  const words = [q, filter.tag].map(s => (s || "").trim()).filter(Boolean).join(" ");
  const data = await payload(BASE + "/novels?" + query({
    keyword: words,
    sort: filter.sort,
    page: page > 1 ? page : undefined,
  }));
  // 作品は workId と title を持つ。同じ作品が何度も出てくるので、id で寄せる
  const seen = {};
  const out = [];
  for (const work of collect(data, ["workId", "title"])) {
    const summary = toSummary(work);
    if (!summary.id || !summary.title || seen[summary.id]) continue;
    seen[summary.id] = true;
    out.push(summary);
  }
  return out;
}

async function ranking(periodKey) {
  // 名乗った区分以外を受け取らない。知らない値をそのままURLへ載せると、
  // 配信元の一覧ページへ好きな条件を投げられる
  const known = manifest.rankingPeriods.some(p => p.key === periodKey);
  if (!known) throw new Error("この期間のランキングはありません");
  const data = await payload(BASE + "/novels/ranking?" + query({
    ranking_axis_type: periodKey,
    // 全て（新作・完結・短編に絞ることもできるが、ここは総合を出す）
    ranking_type: "all",
  }));
  const seen = {};
  const out = [];
  for (const work of collect(data, ["workId", "title"])) {
    const summary = toSummary(work);
    if (!summary.id || !summary.title || seen[summary.id]) continue;
    seen[summary.id] = true;
    out.push(summary);
  }
  if (out.length === 0) throw new Error("この期間のランキングはまだ公開されていません");
  return out;
}

async function summaries(ids) {
  const out = [];
  for (const id of ids) {
    try {
      out.push((await detail(id)).summary);
    } catch (e) {
      // 「無い」と言われたときだけ、消えた作品として返す
      if (String(e).indexOf("404") >= 0) {
        out.push({ id: id, title: "", author: "", synopsis: "", episodeCount: 0, isRemoved: true });
      }
    }
  }
  return out;
}

/**
 * 目次。
 *
 * この配信元は「話」がさらにページに分かれる。アプリの「話」は1つの読み物なので、
 * ページではなく話を単位にする（ページを話として並べると、129ページの作品が
 * 129話に見え、1話ぶんが数行で終わる）。
 *
 * 話の始まりは `pageNo` が最小のページ。そこから次の話の直前までが1話ぶん。
 */
async function detail(id) {
  const data = await payload(BASE + "/novels/" + id + "/viewer/?page=1");

  const works = collect(data, ["workId", "title"]).filter(w => String(w.workId) === String(id));
  const summary = works.length > 0
    ? toSummary(works[0])
    : { id: String(id), title: "", author: "", synopsis: "", episodeCount: 0 };

  const episodes = episodesOf(data).map((ep, index) => ({
    // 並んだ順で振る。この配信元の話番号は「何ページ目か」とは別で、
    // ページ番号を話番号にすると、1話ぶんが複数ページある作品で番号が飛ぶ
    episodeNo: index + 1,
    // ページ番号を鍵にする。本文はページ番号で引く作りで、
    // novelPageId から引く道がない
    episodeKey: String(ep.startPage),
    title: ep.title,
    chapter: ep.chapter,
    sourceUpdatedAt: ep.publishedAt,
  }));

  return {
    summary: Object.assign({}, summary, { episodeCount: episodes.length || summary.episodeCount }),
    episodes: episodes,
    // 目次が空のまま「取り切った」と言わない。取りこぼしを取りこぼしと
    // 分からないまま既読や保存本文を消すのが一番まずい
    tocComplete: episodes.length > 0,
  };
}

/** ページの一覧を、話にまとめ直す */
function episodesOf(data) {
  const pages = collect(data, ["novelPageId", "pageNo"])
    .filter(p => p.pageNo)
    .sort((a, b) => a.pageNo - b.pageNo);

  const byEpisode = {};
  for (const page of pages) {
    const no = page.episodeNo || 0;
    if (!byEpisode[no] || page.pageNo < byEpisode[no].startPage) {
      byEpisode[no] = {
        episodeNo: no,
        startPage: page.pageNo,
        title: page.title || "",
        // 章の見出しは空文字で来ることがある。**空を章にしない**
        chapter: (page.chapterTitle || "").trim() || null,
        publishedAt: toEpoch(page.publishedAt),
      };
    }
  }
  return Object.keys(byEpisode)
    .map(k => byEpisode[k])
    .sort((a, b) => a.startPage - b.startPage);
}

/**
 * 本文。
 *
 * 1話が複数ページに分かれている。開始ページだけ返すと、話の途中で切れる。
 * 次の話の直前まで読み進めて、1話ぶんとしてつなぐ。
 *
 * 1回の取得で数ページぶんの本文が返ってくるので、足りないぶんだけ取りに行く。
 * **上限を置く** — 長い話で何十回も叩かない
 */
async function episode(novelId, episodeKey, episodeNo) {
  const startPage = parseInt(episodeKey, 10) || 1;
  const first = await payload(BASE + "/novels/" + novelId + "/viewer/?page=" + startPage);

  const episodes = episodesOf(first);
  const current = episodes.filter(e => e.startPage === startPage)[0];
  const next = episodes.filter(e => e.startPage > startPage)
    .sort((a, b) => a.startPage - b.startPage)[0];
  // 次の話が無ければ最後の話。作品の終わりまで
  const endPage = next ? next.startPage - 1 : startPage + MAX_PAGES_PER_EPISODE - 1;

  const bodies = {};
  collectBodies(first, bodies, startPage, endPage);

  // 足りないページだけ取りに行く
  for (let page = startPage; page <= endPage; page++) {
    if (bodies[page] !== undefined) continue;
    if (Object.keys(bodies).length >= MAX_PAGES_PER_EPISODE) break;
    const data = await payload(BASE + "/novels/" + novelId + "/viewer/?page=" + page);
    const before = Object.keys(bodies).length;
    collectBodies(data, bodies, startPage, endPage);
    // 進まなくなったら諦める。同じページを取り続けない
    if (Object.keys(bodies).length === before) break;
  }

  const text = Object.keys(bodies)
    .map(Number)
    .sort((a, b) => a - b)
    .map(no => bodies[no])
    .join("\n");

  // **章の見出しが、独立した「話」として並ぶ。** 本文を持たないので、
  // 取れなかったのと区別が付かない。ここで「壊れた」と言うと、
  // 章のたびに読書が止まる。見出しであることをそのまま出す
  if (!text.trim()) {
    if (current && current.title) {
      return {
        episodeNo: episodeNo,
        title: current.title,
        paragraphs: [{ text: "――" + current.title + "――", rubies: [], imageUrl: null }],
      };
    }
    throw new Error("本文が見つかりませんでした（ページの作りが変わった可能性があります）");
  }

  return {
    episodeNo: episodeNo,
    title: current ? current.title : "",
    // 本文は素の文字列（改行区切り）。HTMLではないので、そのまま段落にする
    // 本文には `![識別子](...)` の形で挿絵が埋まる。**そのまま文字として出さない** —
    // 画像のURLを組み立てる道が無いので、行ごと落とす
    paragraphs: text.split("\n")
      .filter(line => !/^!\[[^\]]*\]/.test(line.trim()))
      .map(line => ({ text: line, rubies: [], imageUrl: null })),
  };
}

function collectBodies(data, into, from, to) {
  for (const page of collect(data, ["novelPageId", "body", "pageNo"])) {
    const no = page.pageNo;
    if (typeof page.body !== "string" || !page.body) continue;
    if (no < from || no > to) continue;
    into[no] = page.body;
  }
}

/** 1話ぶんとして読み進める上限。長い話で何十回も叩かない */
const MAX_PAGES_PER_EPISODE = 40;
