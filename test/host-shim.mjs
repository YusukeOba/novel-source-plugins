/**
 * node で拡張を試すための `host`。
 *
 * **アプリと同じ制約を課す。** 検証のほうが緩いと、手元で通ったものがアプリで
 * 動かない — しかも「検証は通った」という事実が、原因を探す邪魔になる。
 * HTMLの解析だけはアプリ側（ksoup）と実装が違うので、そこは近似でしかない。
 */
import { JSDOM } from "jsdom";

/** アプリ側と同じ上限（ScriptHost.kt） */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HEADERS = 20;
const MAX_HEADER_NAME = 64;
const MAX_HEADER_VALUE = 1024;

/**
 * jsdom は CSS を解析しようとして転ぶことがある（アプリ本体は ksoup なので無関係）。
 * 見たいのは要素の構造だけなので、`<style>` は落としてから読む
 */
function dom(html) {
  return new JSDOM(`<body>${String(html).replace(/<style[\s\S]*?<\/style>/gi, "")}</body>`);
}

/** アプリ側と同じ判定（SourceHost.kt の rejectSourceRequest） */
function rejectRequest(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `URLとして読めません（${url}）`;
  }
  if (parsed.protocol !== "https:") return `https:// でないURLへは繋ぎません（${url}）`;
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.some(d => {
    const t = d.trim().toLowerCase();
    return host === t || host.endsWith("." + t);
  });
  return allowed ? null : `この拡張が名乗っていない接続先です（${host}）`;
}

function isUnsafeHeader(name, value) {
  if (!name || name.length > MAX_HEADER_NAME) return true;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return true;
  if (String(value).length > MAX_HEADER_VALUE) return true;
  // 改行が通ると、そこから先が別のヘッダとして解釈されうる
  return /[\x00-\x1F\x7F]/.test(String(value));
}

/**
 * @param allowedHosts 拡張が名乗った接続先。**渡さないと何も取りに行けない** —
 *   アプリでも同じで、名乗りの無い拡張は動かない
 */
export function installHost(target = globalThis, allowedHosts = []) {
  target.host = {
    async fetch(url, options = {}) {
      const rejected = rejectRequest(String(url), allowedHosts);
      if (rejected) throw new Error(`host.fetch: ${rejected}`);

      const headers = options.headers || {};
      if (Object.keys(headers).length > MAX_HEADERS) {
        throw new Error("host.fetch: ヘッダが多すぎます");
      }
      for (const [name, value] of Object.entries(headers)) {
        if (isUnsafeHeader(name, value)) {
          throw new Error(`host.fetch: ヘッダに使えない文字が入っています（${name}）`);
        }
      }

      // **転送を追わない。** 追うと、名乗った接続先が転送するだけでその外へ飛ぶ
      const res = await fetch(String(url), { headers, redirect: "manual" });
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_RESPONSE_BYTES) {
        throw new Error(`host.fetch: 応答が大きすぎます（${buffer.length}バイト）`);
      }
      const encoding = (options.encoding || "utf-8").toLowerCase();
      const decoder = new TextDecoder(
        encoding === "shift_jis" || encoding === "sjis" ? "shift_jis" : "utf-8",
      );
      return {
        status: res.status,
        body: decoder.decode(buffer),
        url: res.url,
        location: res.headers.get("location"),
      };
    },
    select(html, selector) {
      return [...dom(html).window.document.body.querySelectorAll(selector)].map(e => e.outerHTML);
    },
    text(html) {
      const body = dom(html).window.document.body;
      // アプリ側と同じ。`<script>` の中身は「文字」ではないので、
      // 素直に取ると空になる（ページ埋め込みのJSONを読む拡張が通る道）
      const embedded = body.querySelectorAll("script, style");
      if (embedded.length > 0 && !body.textContent.trim()) {
        return [...embedded].map(e => e.textContent).join("\n");
      }
      return body.textContent.trim();
    },
    attr(html, name) {
      const el = dom(html).window.document.body.firstElementChild;
      return el ? el.getAttribute(name) : null;
    },
    paragraphs(html) {
      // アプリ側と同じ。囲みを渡されたら中を見る（渡さないと本文が1段落になる）
      const paragraphTags = new Set(["P", "BR", "RUBY", "IMG", "FIGURE"]);
      let container = dom(html).window.document.body;
      while (container.children.length === 1 &&
             !paragraphTags.has(container.children[0].tagName)) {
        container = container.children[0];
      }
      return [...container.children].map(e => ({
        text: e.textContent, rubies: [], imageUrl: null,
      }));
    },
    paragraphsByBr(html) {
      return String(html).split(/<br\s*\/?>/i)
        .map(t => ({ text: t.replace(/<[^>]*>/g, ""), rubies: [], imageUrl: null }));
    },
  };
}
