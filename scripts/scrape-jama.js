// scripts/scrape-jama.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "fs";

// 判定テキストの正規化
function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// JAMAのページから「論文タイプ」候補を幅広く拾う
function extractType(html) {
  const $ = cheerio.load(html);

  // 1) よく使われるバッジ/キッカー
  const t1 = norm($(".article-header__kicker").first().text());
  const t2 = norm($(".article-header__type").first().text());
  const t3 = norm($(".article-type").first().text());
  const t4 = norm($(".ArticleBadge, .c-article-type, .c-article__type").first().text());

  // 2) <meta> 系
  const m1 = norm($('meta[name="citation_article_type"]').attr("content"));
  const m2 = norm($('meta[name="DC.Type"]').attr("content"));           // 互換
  const m3 = norm($('meta[name="prism.section"]').attr("content"));     // 互換
  const m4 = norm($('meta[property="article:section"]').attr("content"));

  // 3) JSON-LD内の articleSection
  let ld = "";
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).contents().text());
      const section = obj?.articleSection || obj?.headline?.articleSection;
      if (!ld && typeof section === "string") ld = norm(section);
    } catch {}
  });

  // 4) 最終手段：本文全体からキーワード
  const fallback = (() => {
    const rx = /(Original Investigation|Research Letter|Editorial|Correspondence|Review|Viewpoint)/i;
    const hit = html.match(rx);
    return hit ? hit[0] : "";
  })();

  // 重複除去して優先順で返す
  const cand = [t1, t2, t3, t4, m1, m2, m3, m4, ld, fallback]
    .filter(Boolean)
    .map(norm);

  // “Original Investigation” を最優先
  const oi = cand.find(x => /original investigation/i.test(x));
  if (oi) return "Original Investigation";

  // それ以外もそのまま返す（Editorial など）
  return cand[0] || "";
}

// DOIリンク(doi.org) → 最終URL(jamanetwork) を解決してHTML取得
async function resolveAndFetch(url) {
  const headers = {
    // bot避けにUA設定（重要）
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml"
  };

  // 1st: そのまま
  let res = await fetch(url, { redirect: "follow", headers });
  let finalURL = res.url || url;
  let html = await res.text();

  // もし本文が短い/タイプ取れない → fullarticle/abstract 相互に試す
  const type1 = extractType(html);
  if (!type1) {
    let alt = finalURL.includes("/fullarticle/")
      ? finalURL.replace("/fullarticle/", "/article-abstract/")
      : finalURL.replace("/article-abstract/", "/fullarticle/");
    if (alt !== finalURL) {
      const res2 = await fetch(alt, { redirect: "follow", headers });
      const html2 = await res2.text();
      const type2 = extractType(html2);
      if (type2) {
        return { finalURL: res2.url || alt, html: html2 };
      }
    }
  }
  return { finalURL, html };
}

async function main() {
  const { items, from, to } = JSON.parse(readFileSync("public/_jama-urls.json", "utf-8"));
  const out = [];

  // 以前は .slice(0,50) で打ち切っていた → すべて処理に変更
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      if (!it.url) {
        out.push({ doi: it.doi, url: "", final_url: "", article_type: "" });
        continue;
      }
      const { finalURL, html } = await resolveAndFetch(it.url);
      const type = extractType(html);

      out.push({
        doi: it.doi || "",
        url: it.url,
        final_url: finalURL,
        article_type: type
      });

      // 速すぎるとブロックされやすいので少し待つ
      await new Promise(r => setTimeout(r, 300));
      if ((i + 1) % 25 === 0) console.log(`...processed ${i + 1}/${items.length}`);
    } catch (e) {
      out.push({ doi: it.doi || "", url: it.url, final_url: "", article_type: "", error: String(e) });
    }
  }

  writeFileSync(
    "public/jama-article-types.json",
    JSON.stringify({ from, to, items: out }, null, 2)
  );
  console.log(`✅ Saved public/jama-article-types.json (${out.length} rows)`);
}

main().catch(e => { console.error(e); process.exit(1); });
