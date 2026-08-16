/**
 * 名乗り（manifest）が、アプリの受け入れる形になっているか。
 *
 * **通信しない。** ここが通らない拡張は、そもそも追加できない。
 * 配信元を叩く前に、形だけで分かることを先に潰す。
 */
import { readFileSync } from "node:fs";

const index = JSON.parse(readFileSync("sources.json", "utf-8"));
let failed = 0;
const ids = new Set();

/** アプリ側の検証（PluginManifest.validate）と同じ規則 */
const RULES = [
  ["識別子", m => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(m.id || ""), "英小文字・数字・- _ で32文字まで"],
  ["名前", m => (m.name || "").length > 0 && m.name.length <= 60, "1〜60字"],
  ["接続先", m => Array.isArray(m.hosts) && m.hosts.length > 0, "1つ以上必要"],
  ["接続先の形", m => (m.hosts || []).every(h => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)),
    "ホスト名だけ（スキームやパスを含めない）"],
  ["接続先の広さ", m => (m.hosts || []).every(h => h.split(".").length >= 2 &&
    !["co.jp", "ne.jp", "or.jp", "com.au"].includes(h.toLowerCase())),
    "1段だけ／実質1段の名乗りは広すぎる"],
  ["作品ページのURL", m => !m.novelPageUrl || m.novelPageUrl.startsWith("https://"),
    "https:// で書く（端末の外の仕組みへ渡る）"],
  ["URLの見分け", m => (m.urlPatterns || []).length <= 10 &&
    (m.urlPatterns || []).every(p => p.length <= 200), "10個・200字まで"],
  ["URLの見分けが読めるか", m => (m.urlPatterns || []).every(p => {
    try { new RegExp(p); return true; } catch { return false; }
  }), "正規表現として読めない"],
  ["ランキングの区分", m => (m.rankingPeriods || []).every(p => p && p.key && p.label),
    "{ key, label } の形で書く"],
  ["絞り込み", m => (m.filters || []).length <= 30 &&
    (m.filters || []).every(f => f.key && f.label && f.options?.length !== 0 ||
      f.type !== "choice"), "30個まで／選択肢は空にしない"],
  ["選択肢の指定なし", m => (m.filters || []).filter(f => f.type === "choice")
    .every(f => (f.options || []).some(o => o.value === "")),
    "「指定なし」を入れないと、選んだ条件を空へ戻せない"],
];

for (const file of index.sources) {
  const source = readFileSync(file, "utf-8");
  const m = new Function(`${source}\n return manifest;`)();
  console.log(`\n== ${file}`);

  if (ids.has(m.id)) {
    console.error(`  NG 識別子が重なっている: ${m.id}`);
    failed++;
  }
  ids.add(m.id);

  for (const [name, check, hint] of RULES) {
    if (check(m)) {
      console.log(`  OK ${name}`);
    } else {
      console.error(`  NG ${name}: ${hint}`);
      failed++;
    }
  }

  // 実装すべき関数が揃っているか
  const api = new Function(
    `${source}\n return { search, ranking, summaries, detail, episode };`,
  )();
  for (const fn of ["search", "ranking", "summaries", "detail", "episode"]) {
    if (typeof api[fn] !== "function") {
      console.error(`  NG ${fn}() が無い`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed}件が規約に合っていません。`);
  process.exit(1);
}
console.log("\n名乗りはすべて正しい形です。");
