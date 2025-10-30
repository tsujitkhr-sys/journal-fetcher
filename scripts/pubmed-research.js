// scripts/pubmed-research.js
// 目的: JAMAスクレイプ結果 (public/jama-article-types.json) の各DOIをPubMed照会し、
// Publication Typeから「研究のみ」を判定してフィールド追加・フィルタJSONを書き出す。

import fetch from "node-fetch";
import { readFileSync, writeFileSync } from "fs";

// PubMed E-utilities endpoints
const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

// --- 研究として扱う Publication Type の基準 ---
// ※「Review」「Meta-Analysis」「Editorial」「Comment」「Letter」は除外します。
// （必要なら基準をあとで調整可能）
function isResearchPubType(types = []) {
  // すべて小文字化
  const T = types.map(t => t.toLowerCase());

  // 1) まず除外（ここに1つでもあれば研究扱いしない）
  const deny = [
    "review", "systematic review", "meta-analysis",
    "editorial", "comment", "letter", "news",
    "biography", "practice guideline", "guideline",
    "retracted publication", "expression of concern",
    "case reports" // ←入れたくない場合は維持。含めたいならこれを消す
  ];
  if (T.some(t => deny.includes(t))) return false;

  // 2) 許可：研究タイプのみ（明示的なものだけ）
  //    ※ “journal article” は入れていません（←ここがポイント）
  const allowExact = new Set([
    "clinical trial",
    "randomized controlled trial",
    "controlled clinical trial",
    "pragmatic clinical trial",
    "multicenter study",
    "observational study",
    "comparative study",
    "evaluation study",
    "validation study",
    "clinical study",
    "cohort studies",
    "case-control studies",
    "cross-sectional studies",
    "prospective studies",
    "retrospective studies"
  ]);

  if (T.some(t => allowExact.has(t))) return true;

  // 3) さらに PubMed の細かい表記ゆれを拾う（フェーズ付きなど）
  const allowRegex = [
    /clinical trial/i,                  // "Clinical Trial, Phase III" 等を拾う
    /randomized controlled trial/i,
    /observational study/i,
    /(cohort|case-control|cross-sectional|prospective|retrospective) studies?/i,
    /comparative study/i,
    /evaluation study/i,
    /validation study/i,
    /multicenter study/i,
    /clinical study/i
  ];
  if (T.some(t => allowRegex.some(rx => rx.test(t)))) return true;

  // 4) 上記に当たらなければ研究とはみなさない（"journal article" 単独は false）
  return false;
}


// DOI -> PMID を取得
async function doiToPMID(doi) {
  if (!doi) return null;
  const params = new URLSearchParams({
    db: "pubmed",
    term: `${doi}[DOI]`,
    retmode: "json"
  });
  const r = await fetch(`${ESEARCH}?${params.toString()}`);
  if (!r.ok) return null;
  const j = await r.json();
  const idlist = j?.esearchresult?.idlist || [];
  return idlist[0] || null;
}

// PMID -> Publication Types 配列を取得
async function pmidToPubTypes(pmid) {
  if (!pmid) return [];
  const params = new URLSearchParams({
    db: "pubmed",
    id: pmid,
    retmode: "json"
  });
  const r = await fetch(`${ESUMMARY}?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json();
  const rec = j?.result?.[pmid];
  const types = rec?.pubtype || []; // 例: ["Clinical Trial", "Randomized Controlled Trial"]
  return types;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const input = JSON.parse(readFileSync("public/jama-article-types.json", "utf-8"));
  const items = Array.isArray(input.items) ? input.items : input; // どちらの形式でも対応

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const doi = it.doi || "";
    let pmid = null, pubTypes = [], isResearch = false;

    try {
      pmid = await doiToPMID(doi);
      if (pmid) {
        await sleep(350); // API礼儀
        pubTypes = await pmidToPubTypes(pmid);
        isResearch = isResearchPubType(pubTypes);
      }
    } catch (e) {
      // 失敗はログだけ記録
      console.log(`PMID lookup failed for DOI=${doi}: ${e.message || e}`);
    }

    out.push({
      ...it,
      pubmed_pmid: pmid || "",
      pubmed_pubtypes: pubTypes,
      pubmed_is_research: isResearch
    });

    await sleep(250); // レート制御（鍵なし利用を想定）
    if ((i + 1) % 20 === 0) console.log(`...PubMed processed ${i + 1}/${items.length}`);
  }

  // 付加情報つきの全件と、「研究のみ」の2ファイルを出力
  const enriched = { ...input, items: out };
  writeFileSync("public/jama-article-types-with-pubmed.json", JSON.stringify(enriched, null, 2));

  const onlyResearch = out.filter(x => x.pubmed_is_research === true);
  writeFileSync("public/jama-research-only.json", JSON.stringify({ from: input.from, to: input.to, items: onlyResearch }, null, 2));

  console.log(`✅ PubMed判定完了: research-only ${onlyResearch.length}/${out.length} saved → public/jama-research-only.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
