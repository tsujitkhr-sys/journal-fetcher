import fetch from "node-fetch";
import { writeFileSync, mkdirSync } from "fs";

const JAMA_ISSNS = ["0098-7484", "1538-3598"];

function lastMonth() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

const { from, to } = lastMonth();

function buildURL(cursor = "*") {
  const filter = [
    `from-pub-date:${from}`,
    `until-pub-date:${to}`,
    `type:journal-article`,
    ...JAMA_ISSNS.map(i => `issn:${i}`)
  ].join(",");
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("filter", filter);
  u.searchParams.set("sort", "issued");
  u.searchParams.set("order", "asc");
  u.searchParams.set("rows", "200");
  u.searchParams.set("cursor", cursor);
  return u.toString();
}

async function main() {
  const acc = [];
  let cursor = "*";
  for (let i = 0; i < 10; i++) {
    const url = buildURL(cursor);
    const res = await fetch(url);
    const j = await res.json();
    const items = j?.message?.items || [];
    for (const it of items) {
      acc.push({ doi: it.DOI || "", url: it.URL || `https://doi.org/${it.DOI}` });
    }
    const next = j?.message?.["next-cursor"];
    if (!next || !items.length) break;
    cursor = next;
  }
  mkdirSync("public", { recursive: true });
  writeFileSync("public/_jama-urls.json", JSON.stringify({ from, to, items: acc }, null, 2));
  console.log(`Saved ${acc.length} JAMA URLs`);
}

main();
