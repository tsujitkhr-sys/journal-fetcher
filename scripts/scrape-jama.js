import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "fs";

function extractType(html) {
  const $ = cheerio.load(html);
  const t1 = $(".article-header__type").first().text().trim();
  const t2 = $(".article-type").first().text().trim();
  const t3 = $('meta[name="citation_article_type"]').attr("content") || "";
  return t1 || t2 || t3 || "";
}

async function main() {
  const { items } = JSON.parse(readFileSync("public/_jama-urls.json"));
  const results = [];
  for (const it of items.slice(0, 50)) {
    try {
      const res = await fetch(it.url, { redirect: "follow" });
      const html = await res.text();
      const type = extractType(html);
      results.push({ ...it, article_type: type });
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.push({ ...it, article_type: "", error: e.message });
    }
  }
  writeFileSync("public/jama-article-types.json", JSON.stringify(results, null, 2));
  console.log("✅ Saved public/jama-article-types.json");
}

main();
