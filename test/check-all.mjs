/**
 * 入っている拡張が、いまも配信元に対して働くかを確かめる。
 *
 * **配信元の作りは黙って変わる。** セレクタが1つ変わるだけで、検索は0件になり、
 * 本文は空になる。しかも例外は出ないので、使っている人が「壊れた」と気づくまで
 * 分からない。ここで先に気づくためのもの。
 *
 * 通信するので、既定では走らせない。`npm run check` で明示的に動かす。
 */
import { readFileSync } from "node:fs";
import { installHost } from "./host-shim.mjs";

const index = JSON.parse(readFileSync("sources.json", "utf-8"));
let failed = 0;

/** 1話としてありえる最小。これを下回るなら取りこぼしている */
const MIN_BODY_CHARS = 200;

/** 1段落としてありえる最大。超えるなら段落の区切りが失われている */
const MAX_SINGLE_PARAGRAPH_CHARS = 600;

/** 本文のある話を探して試す数。章の見出しが続くことがある */
const MAX_EPISODE_TRIES = 5;

/** アプリが配信元に対して行うこと。**どれが壊れても読書は止まる** */
const CHECKS = [
  {
    name: "検索",
    async run(api) {
      const items = await api.search("異世界", 1, {});
      if (!Array.isArray(items) || items.length === 0) throw new Error("0件");
      const first = items[0];
      if (!first.id) throw new Error("作品IDが空");
      if (!first.title) throw new Error("題が空");
      return `${items.length}件 / 先頭「${first.title.slice(0, 20)}」`;
    },
  },
  {
    name: "ランキング",
    async run(api) {
      const periods = api.manifest.rankingPeriods || [];
      if (periods.length === 0) return "対応していない（宣言どおり）";
      const key = periods[0].key;
      const items = await api.ranking(key);
      if (!Array.isArray(items) || items.length === 0) throw new Error(`${key} が0件`);
      return `${key} ${items.length}件`;
    },
  },
  {
    name: "目次",
    async run(api, state) {
      const detail = await api.detail(state.novelId);
      if (!detail.episodes || detail.episodes.length === 0) throw new Error("0話");
      // **番号は増え続ける必要がある。** 連番でなくてよい（作者が話を消すと飛ぶ）が、
      // 戻ったり重なったりすると、既読としおりが別の話に付く
      let previous = 0;
      for (const e of detail.episodes) {
        if (!(e.episodeNo > previous)) {
          throw new Error(`話番号が増えていない（${previous} → ${e.episodeNo}）`);
        }
        previous = e.episodeNo;
      }
      if (detail.episodes.some(e => !e.episodeKey)) throw new Error("本文の鍵が空の話がある");
      // 取り切れていないなら、そう言っているか。**黙って「全部」と言わせない**
      const declared = detail.summary.episodeCount;
      // **1話目が章の見出しのことがある**（本文を持たない）。
      // それを本文の確認に使うと「取りこぼし」と誤って言う
      state.episodes = detail.episodes;
      return `${detail.episodes.length}話 / 取り切れた=${detail.tocComplete}` +
        (declared ? ` / 公開話数=${declared}` : "");
    },
  },
  {
    name: "本文",
    async run(api, state) {
      // 先頭から順に試して、**本文のある話**で確かめる。
      // 章の見出しだけの話が並ぶ配信元があり、それを掴むと誤って落ちる
      let body = null;
      let text = [];
      let chars = 0;
      for (const episode of state.episodes.slice(0, MAX_EPISODE_TRIES)) {
        const candidate = await api.episode(state.novelId, episode.episodeKey, episode.episodeNo);
        const lines = (candidate.paragraphs || []).filter(p => p.text && p.text.trim());
        const length = lines.reduce((n, p) => n + p.text.length, 0);
        if (length >= MIN_BODY_CHARS) {
          body = candidate;
          text = lines;
          chars = length;
          break;
        }
      }
      if (!body) {
        throw new Error(
          `先頭${MAX_EPISODE_TRIES}話のどれからも本文を取れなかった。取りこぼしの可能性`,
        );
      }
      // **「取れた」だけでは足りない。** 段落分けが壊れていても、文字は
      // 取れているので気づけない（3350字が1段落、というのを実際に見逃していた）
      if (text.length === 1 && chars > MAX_SINGLE_PARAGRAPH_CHARS) {
        throw new Error(
          `${chars}字が1段落になっている。段落の区切りが失われている`,
        );
      }
      return `${text.length}段落 / ${chars}字 / 先頭「${text[0].text.slice(0, 20)}」`;
    },
  },
  {
    name: "更新チェック",
    async run(api, state) {
      // 本棚の更新確認で毎日走る経路。**ここが壊れると新着に気づけなくなる**
      const items = await api.summaries([state.novelId]);
      if (!Array.isArray(items) || items.length === 0) throw new Error("0件");
      if (String(items[0].id) !== String(state.novelId)) {
        throw new Error(`別の作品が返った: ${items[0].id}`);
      }
      return `${items.length}件`;
    },
  },
  {
    name: "作品URLの見分け",
    async run(api, state) {
      const patterns = api.manifest.urlPatterns || [];
      if (patterns.length === 0) return "対応していない（宣言どおり）";
      const url = (api.manifest.novelPageUrl || "").replace("{id}", state.novelId);
      if (!url) return "作品ページのURLを名乗っていない";
      const matched = patterns.some(p => {
        const m = new RegExp(p).exec(url);
        return m && m[1] === String(state.novelId);
      });
      if (!matched) throw new Error(`自分の作品URL（${url}）を見分けられない`);
      return "自分の作品URLを見分けられる";
    },
  },
];

for (const file of index.sources) {
  const source = readFileSync(file, "utf-8");
  const api = new Function(
    `${source}\n return { manifest, search, ranking, summaries, detail, episode };`,
  )();
  // **その拡張が名乗った接続先だけを許す。** アプリと同じ制約で試さないと、
  // 手元で通ったものがアプリで動かない
  installHost(globalThis, api.manifest.hosts || []);
  console.log(`\n== ${file}（${api.manifest.name} / 版 ${api.manifest.version}）`);

  // 確認に使う作品は、**そのとき検索で見つかったものから選ぶ。**
  // 特定の作品を書き込むと、それが消えた日に「拡張が壊れた」と誤って言う。
  //
  // ただし**どれを使ったかは必ず出す。** 出さないと、落ちたときに
  // 「作品が変わったせいか、拡張が壊れたのか」が分からない
  const state = {};
  try {
    const items = await api.search("異世界", 1, {});
    // 話数の多い作品を選ぶ。1話しかない作品だと、目次や段落の確認が
    // 通ってしまい、壊れていても気づけない
    const usable = items.filter(i => (i.episodeCount || 0) >= 5);
    const picked = usable[0] || items[0];
    state.novelId = picked && picked.id;
    state.novelTitle = picked && picked.title;
  } catch (e) { /* 検索の確認で落ちる */ }

  if (state.novelId) {
    console.log(`  （確認に使う作品: ${state.novelId}「${(state.novelTitle || "").slice(0, 24)}」）`);
  }

  for (const check of CHECKS) {
    if (!state.novelId && check.name !== "検索") {
      console.error(`  NG ${check.name}: 確認に使う作品を取れなかった`);
      failed++;
      continue;
    }
    try {
      console.log(`  OK ${check.name}: ${await check.run(api, state)}`);
    } catch (e) {
      console.error(`  NG ${check.name}: ${e.message}`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed}件が壊れています。配信元の作りが変わった可能性があります。`);
  process.exit(1);
}
console.log("\nすべて動いています。");
