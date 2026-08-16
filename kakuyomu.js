/**
 * カクヨム。
 *
 * 検索・ランキング・作品ページは、ページに埋め込まれた `__NEXT_DATA__`
 * （Apollo の正規化キャッシュ）の JSON を読む。本文ページだけは埋め込みJSONを
 * 持たないので DOM を読む。
 *
 * 正規化キャッシュなので、実体は `__ref` を辿らないと出てこない。
 * 一覧の並びも `ROOT_QUERY` の接続フィールドが持つ `nodes` の順に従う —
 * キャッシュを総なめすると、関連作品など一覧外の作品まで混ざって順位が崩れる。
 */
const manifest = {
  id: "kakuyomu",
  name: "カクヨム",
  version: "1.0.0",
  // kakuyomu.jp の CSS 変数 --color-blue-60
  accent: "#0081c2",
  hosts: ["kakuyomu.jp"],
  urlPatterns: ["kakuyomu\\.jp/works/(\\d{1,24})"],
  novelPageUrl: "https://kakuyomu.jp/works/{id}",
  // 四半期は無く年間がある。**別の区分で埋めない**
  rankingPeriods: [
    { key: "daily", label: "日間" },
    { key: "weekly", label: "週間" },
    { key: "monthly", label: "月間" },
    { key: "yearly", label: "年間" },
  ],
  emptyQuery: true,
  tagFilterKey: "tag",
  filters: [
    { type: "text", key: "tag", label: "タグ" },
    {
      type: "choice", key: "genre_name", label: "ジャンル",
      options: [
        { value: "", label: "指定なし" },
        { value: "fantasy", label: "異世界ファンタジー" },
        { value: "action", label: "現代ファンタジー" },
        { value: "sf", label: "SF" },
        { value: "love_story", label: "恋愛" },
        { value: "romance", label: "ラブコメ" },
        { value: "drama", label: "現代ドラマ" },
        { value: "horror", label: "ホラー" },
        { value: "mystery", label: "ミステリー" },
        { value: "nonfiction", label: "エッセイ・ノンフィクション" },
        { value: "history", label: "歴史・時代・伝奇" },
        { value: "criticism", label: "創作論・評論" },
        { value: "others", label: "詩・童話・その他" },
      ],
    },
    {
      type: "choice", key: "order", label: "並び順",
      options: [
        { value: "", label: "既定（週間ランキング順）" },
        { value: "popular", label: "人気順" },
        { value: "published_at", label: "新着順" },
        { value: "last_episode_published_at", label: "更新が新しい順" },
      ],
    },
    // URLに載らない条件はここで落とす。検索URLは q / genre_name / order / page
    // しか受け付けないが、返るJSONには連載状態も文字数も自主規制タグも載っている
    {
      type: "choice", key: "status", label: "連載状態",
      options: [
        { value: "", label: "指定なし" },
        { value: "RUNNING", label: "連載中" },
        { value: "COMPLETED", label: "完結済み" },
      ],
    },
    { type: "toggle", key: "notCruel", label: "残酷な描写ありを除く" },
    { type: "range", key: "length", label: "文字数", unit: "字" },
  ],
};

const BASE = "https://kakuyomu.jp";
const RANK_PATH = { daily: "daily", weekly: "weekly", monthly: "monthly", yearly: "yearly" };

/** 埋め込みJSON（Apollo の正規化キャッシュ）を取り出す */
async function apolloState(url) {
  let res = await host.fetch(url);

  // 転送は自分で追う。アプリは追わない（名乗った接続先が転送するだけで
  // その外へ要求が飛ぶのを防ぐため）。行き先はもう一度確かめられるので、
  // 名乗っていない相手へは結局行けない
  for (let hop = 0; hop < MAX_REDIRECTS && res.status >= 300 && res.status < 400; hop++) {
    const next = res.location;
    if (!next) break;
    res = await host.fetch(next.startsWith("http") ? next : BASE + next);
  }

  if (res.status === 404) throw new Error("この作品は見つかりませんでした");
  if (res.status !== 200) throw new Error("取得できませんでした（" + res.status + "）");
  return { state: stateOf(res.body), body: res.body };
}

/** 転送の追跡は数回まで。輪になっていても止まる */
const MAX_REDIRECTS = 3;

function stateOf(html) {
  const script = host.select(html, "script#__NEXT_DATA__")[0];
  // **0件と「構造が変わって読めなかった」を混ぜない。** 空で返すと画面が
  // 「見つかりませんでした」と出し、利用者は検索語を変え続けることになる
  if (!script) throw new Error("ページの作りが変わった可能性があります（データが見つかりません）");
  const raw = host.text(script);
  const data = JSON.parse(raw);
  const state = data && data.props && data.props.pageProps
    && data.props.pageProps.__APOLLO_STATE__;
  if (!state) throw new Error("ページの作りが変わった可能性があります（データが空です）");
  return state;
}

/**
 * 一覧の並びは `ROOT_QUERY` の接続フィールドが持つ `nodes` の順に従う。
 * キャッシュの鍵の並びに頼ると、サイト側の出力順が変わった日に黙って崩れる
 */
function orderedWorkRefs(state) {
  const root = state["ROOT_QUERY"];
  if (!root) throw new Error("ページの作りが変わった可能性があります（一覧が見つかりません）");
  const refs = [];
  for (const value of Object.values(root)) {
    if (!value || typeof value !== "object") continue;
    const nodes = value.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const ref = node && node.__ref;
      if (typeof ref === "string" && ref.startsWith("Work:") && refs.indexOf(ref) < 0) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

function toSummary(state, key) {
  const work = state[key];
  if (!work) return null;
  const author = work.author && work.author.__ref ? state[work.author.__ref] : null;
  return {
    id: work.id || String(key).slice("Work:".length),
    title: work.title || "",
    author: work.alternateAuthorName || (author && author.activityName) || "",
    synopsis: work.introduction || "",
    episodeCount: work.publicEpisodeCount || 0,
    lastUpdatedAt: toEpoch(work.lastEpisodePublishedAt),
    // 話ごとの改稿日時を出していないので、改稿の検出はできない
    revisedAt: null,
    length: work.totalCharacterCount != null ? work.totalCharacterCount : null,
    // ブックマークの内訳は公開していない。**0 を入れない** — 出せないことと0件は違う
    bookmarkCount: null,
    allPoint: work.totalReviewPoint != null ? work.totalReviewPoint : null,
    serializing: work.serialStatus ? work.serialStatus === "RUNNING" : null,
    isShort: null,
    isR15: work.isSexual === true ? true : null,
    isCruel: work.isCruel === true || work.isViolent === true,
    tags: Array.isArray(work.tagLabels) ? work.tagLabels : [],
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

/** URLに載らない条件を、返ってきたものから落とす */
function applyLocal(items, filter) {
  let out = items;
  if (filter.status) out = out.filter(i => (i.serializing === (filter.status === "RUNNING")));
  if (filter.notCruel === "1") out = out.filter(i => !i.isCruel);
  const min = parseInt(filter["length.min"], 10);
  const max = parseInt(filter["length.max"], 10);
  if (!isNaN(min)) out = out.filter(i => (i.length || 0) >= min);
  if (!isNaN(max)) out = out.filter(i => (i.length || 0) <= max);
  return out;
}

async function search(q, page, filter) {
  filter = filter || {};
  const words = [q, filter.tag].map(s => (s || "").trim()).filter(Boolean).join(" ");
  const url = BASE + "/search?" + query({
    q: words || undefined,
    genre_name: filter.genre_name,
    order: filter.order,
    page: page > 1 ? page : undefined,
  });
  const { state } = await apolloState(url);
  const items = orderedWorkRefs(state).map(ref => toSummary(state, ref)).filter(Boolean);
  return applyLocal(items, filter);
}

async function ranking(period) {
  const path = RANK_PATH[period];
  if (!path) throw new Error("この期間には対応していません");
  const { state } = await apolloState(BASE + "/rankings/all/" + path);
  return orderedWorkRefs(state).map(ref => toSummary(state, ref)).filter(Boolean);
}

async function summaries(ids) {
  const out = [];
  // 1件でも失敗したら全部を投げ捨てる、にはしない。削除された作品を本棚に
  // 1つ残しているだけで、この配信元の作品が二度と更新されなくなる
  for (const id of ids) {
    try {
      const detail = await detailOf(id);
      out.push(detail.summary);
    } catch (e) {
      // 消えた作品と、取れなかったのを混ぜない
      if (String(e).indexOf("見つかりませんでした") >= 0) {
        out.push({ id: id, title: "", author: "", synopsis: "", episodeCount: 0, isRemoved: true });
      }
    }
  }
  return out;
}

async function detailOf(id) {
  const { state } = await apolloState(BASE + "/works/" + id);
  const summary = toSummary(state, "Work:" + id);
  if (!summary) throw new Error("作品情報を取得できませんでした");

  // 章の並びは作品の tableOfContentsV2 から取る。キャッシュの鍵の並びに頼ると、
  // サイト側の出力順が変わった日に黙って崩れる。
  // **1つでも欠けていたら並びの情報として信用しない** — 欠けた章の話を黙って
  // 落とすと、以降の話番号が丸ごとずれ、既読としおりが別の話に付く
  const work = state["Work:" + id] || {};
  const declared = (work.tableOfContentsV2 || []).map(r => r && r.__ref).filter(Boolean);
  const inState = Object.keys(state).filter(k => k.startsWith("TableOfContentsChapter:"));
  const chapterKeys = declared.length > 0 && declared.every(k => state[k]) ? declared : inState;

  const ordered = [];
  let parentTitle = null;
  for (const key of chapterKeys) {
    const toc = state[key];
    if (!toc) continue;
    const chapter = toc.chapter && toc.chapter.__ref ? state[toc.chapter.__ref] : null;
    const title = chapter && chapter.title ? String(chapter.title).trim() || null : null;
    if (chapter && (chapter.level || 0) <= 1) {
      parentTitle = title;
      if (!toc.episodeUnions || toc.episodeUnions.length === 0) continue;
    }
    let heading;
    if (title === null) heading = parentTitle;
    else if (chapter && (chapter.level || 0) > 1 && parentTitle) heading = parentTitle + " ／ " + title;
    else heading = title;
    for (const union of toc.episodeUnions || []) {
      if (union && union.__ref) ordered.push([union.__ref, heading]);
    }
  }

  const headings = ordered.map(o => o[1]).filter(Boolean);
  // 章が1つしか無いなら、全部の話に同じ見出しを付けても何も分からない
  const useChapters = new Set(headings).size > 1;

  const episodes = [];
  ordered.forEach(([ref, chapter]) => {
    const entity = state[ref];
    // **鍵の無い話を並べない。** 開いても本文を引けず、しかも話番号だけ進むので
    // 以降の番号が全部ずれる
    if (!entity || !entity.id) return;
    episodes.push({
      episodeNo: episodes.length + 1,
      episodeKey: entity.id,
      title: entity.title || "",
      sourceUpdatedAt: toEpoch(entity.publishedAt),
      chapter: useChapters ? chapter : null,
    });
  });

  // **公開話数は、目次で上書きする前の値と比べる。**
  // 上書きしてから比べると、何話取りこぼしても「取り切れた」になり、
  // アプリが目次に無い話として既読と保存本文を消す
  const declaredCount = summary.episodeCount || 0;
  return {
    summary: Object.assign({}, summary, { episodeCount: episodes.length }),
    episodes: episodes,
    tocComplete: episodes.length > 0 && episodes.length >= declaredCount,
  };
}

async function detail(id) {
  return await detailOf(id);
}

async function episode(novelId, episodeKey, episodeNo) {
  const res = await host.fetch(BASE + "/works/" + novelId + "/episodes/" + episodeKey);
  if (res.status !== 200) throw new Error("本文を取得できませんでした（" + res.status + "）");

  const titleNode = host.select(res.body, ".widget-episodeTitle")[0];
  const body = host.select(res.body, ".widget-episodeBody")[0];
  // 有料の話は、話ページを開くと作品ページへ飛ばされる。通信としては成功に見え、
  // 本文だけが取れない。**白紙を出さない**
  if (!body) {
    throw new Error(
      "この話は読めませんでした。公開されていないか、有料の話の可能性があります",
    );
  }
  return {
    episodeNo: episodeNo,
    title: titleNode ? host.text(titleNode).trim() : "",
    paragraphs: host.paragraphs(body).filter(p => (p.text && p.text.trim()) || p.imageUrl),
  };
}
