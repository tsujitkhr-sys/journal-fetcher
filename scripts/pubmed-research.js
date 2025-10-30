// scripts/pubmed-research.js
// 目的:
// 1) jama-article-types.json を読み、各DOI→PubMed照会
// 2) pubtypes と "アブスト本文の内容" の両方で「研究のみ」を判定
// 3) アブストを Markdown 整形し、JSONとCSVを public/ に出力

import fetch from "node-fetch";
import { readFileSync, writeFileSync } from "fs";

const ESEARCH  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const EFETCH   = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

// ---- utils ----
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function norm(s){ return (s||"").replace(/\s+/g," ").trim(); }
function lc(s){ return (s||"").toLowerCase(); }

// CSVエスケープ
function csvEscape(v){
  const s = String(v ?? "");
  return `"${s.replace(/"/g,'""')}"`;
}

// ---- PubMed ----
async function doiToPMID(doi){
  if(!doi) return null;
  const q = new URLSearchParams({ db:"pubmed", term:`${doi}[DOI]`, retmode:"json" });
  const r = await fetch(`${ESEARCH}?${q.toString()}`);
  if(!r.ok) return null;
  const j = await r.json();
  return j?.esearchresult?.idlist?.[0] || null;
}

async function pmidToSummary(pmid){
  if(!pmid) return null;
  const q = new URLSearchParams({ db:"pubmed", id:pmid, retmode:"json" });
  const r = await fetch(`${ESUMMARY}?${q.toString()}`);
  if(!r.ok) return null;
  const j = await r.json();
  const rec = j?.result?.[pmid];
  if(!rec) return null;
  // 著者名を "Given Family" に整形
  const authors = Array.isArray(rec?.authors)
    ? rec.authors.map(a => [a?.name, a?.authtype].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  return {
    title: rec?.title || "",
    journal: rec?.fulljournalname || rec?.source || "",
    pubdate: rec?.pubdate || "",
    volume: rec?.volume || "",
    issue: rec?.issue || "",
    pages: rec?.pages || "",
    authors,
    pubtypes: rec?.pubtype || []   // Publication Type 配列
  };
}

async function pmidToAbstract(pmid){
  if(!pmid) return "";
  const q = new URLSearchParams({ db:"pubmed", id:pmid, retmode:"xml" });
  const r = await fetch(`${EFETCH}?${q.toString()}`);
  if(!r.ok) return "";
  const xml = await r.text();
  // 複数 <AbstractText> を結合
  const parts = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi)]
    .map(m => m[1]
      .replace(/<\/?b>/gi,"")
      .replace(/<\/?i>/gi,"")
      .replace(/<\/?sup>/gi,"")
      .replace(/<\/?sub>/gi,"")
      .replace(/<[^>]+>/g,"")
      .trim()
    )
    .filter(Boolean);
  return parts.join(" ");
}

// ---- 研究判定（pubtypes＋アブスト） ----
// 1) pubtypesで除外（Review/Editorial/Comment/Letterなど）
// 2) pubtypesで明示的に許可（RCT/Clinical trial/Observational等）
// 3) 上記で不明な場合、アブスト本文のキーワードで判定（例文のような RCT/phase/観察研究）
function isResearchByPubTypes(types = []){
  const T = types.map(t => lc(t));

  const deny = [
    "review","systematic review","meta-analysis",
    "editorial","comment","letter",
    "news","biography","practice guideline","guideline",
    "retracted publication","expression of concern",
    "case reports"
  ];
  if (T.some(t => deny.includes(t))) return false;

  // 明示的に「研究」
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

  // ゆらぎ吸収（フェーズ等）
  const allowRegex = [
    /clinical trial/i,
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

  return null; // 「pubtypesだけでは判定できない」
}

function isResearchByAbstract(abstract){
  const a = lc(abstract);
  if(!a) return null;

  // RCT/試験系キーワード
  const trialRx = [
    /randomi[sz]ed (double|single)?-?blind(ed)?/i,
    /phase\s*[1i]{1,3}\b/i,                // phase 1/2/3
    /clinical (trial|study)/i,
    /\bplacebo-?controlled\b/i,
    /\bdouble-?blind(ed)?\b/i,
    /\btrial\b/i
  ];

  // 観察研究キーワード
  const obsRx = [
    /\bcohort\b/i,
    /case-?control/i,
    /cross-?sectional/i,
    /\bprospective\b/i,
    /\bretrospective\b/i,
    /\bobservational study\b/i,
    /\bmulticenter\b/i
  ];

  if (trialRx.some(rx => rx.test(abstract))) return true;
  if (obsRx.some(rx => rx.test(abstract))) return true;

  return null; // どちらとも言えない
}

// ---- Markdown 整形（見出しを太字化） ----
function abstractToMarkdown(raw){
  if(!raw) return "";
  // “Importance: … Objective: …” などの見出しを **見出し** に
  const keys = ["Importance","Objective","Design, setting, and participants","Design","Setting","Participants",
                "Interventions","Main outcomes and measures","Outcomes","Results","Conclusions","Conclusion",
                "Meaning","Relevance","Exposure","Measures"];
  let text = raw;
  for(const k of keys){
    const re = new RegExp(`\\b${k}\\s*:\\s*`,"gi");
    text = text.replace(re, `**${k}:** `);
  }
  return text.trim();
}

// ---- CSV 生成（Markdownアブスト含む） ----
function makeCSV(rows){
  const header = [
    "title","authors","published","DOI","URL",
    "journal","issue","volume","pages",
    "article_type_site","pubmed_pubtypes","abstract_md"
  ];
  const lines = [header.join(",")];
  for(const r of rows){
    const authors = (r.authors || []).join("; ");
    const pubtypes = (r.pubmed_pubtypes || []).join("; ");
    const url = r.final_url || r.url || (r.doi ? `https://doi.org/${r.doi}` : "");
    const fields = [
      r.title || "",
      authors,
      r.pubdate || "",
      r.doi || "",
      url,
      r.journal || "",
      r.issue || "",
      r.volume || "",
      r.pages || "",
      r.article_type || "",
      pubtypes,
      r.abstract_md || ""
    ].map(csvEscape);
    lines.push(fields.join(","));
  }
  return lines.join("\n");
}

// ---- main ----
async function main(){
  const src = JSON.parse(readFileSync("public/jama-article-types.json","utf-8"));
  const items = Array.isArray(src.items) ? src.items : src;

  const enriched = [];
  for(let i=0;i<items.length;i++){
    const it = items[i];
    let pmid = "", summary = null, abs = "", isResearch = false;

    try{
      if(it.doi){
        pmid = await doiToPMID(it.doi) || "";
        await sleep(600);

        if(pmid){
          summary = await pmidToSummary(pmid);
          await sleep(600);

          abs = await pmidToAbstract(pmid);
          await sleep(600);

          // 1) pubtypesで判定
          let byPT = isResearchByPubTypes(summary?.pubtypes || []);
          // 2) 不明ならアブストで判定
          let byAbs = isResearchByAbstract(abs);
          // 決定ロジック: TRUEが一つでもあれば研究とみなす / FALSEがあれば非研究
          if (byPT === false || byAbs === false) isResearch = false;
          else if (byPT === true || byAbs === true) isResearch = true;
          else isResearch = false; // どちらも不明 → 非研究扱い
        }
      }
    }catch(e){
      console.log(`PubMed lookup failed for DOI=${it.doi}: ${e.message||e}`);
    }

    const abstract_md = abstractToMarkdown(abs);
    enriched.push({
      ...it,
      pubmed_pmid: pmid,
      title: summary?.title || "",
      journal: summary?.journal || "",
      pubdate: summary?.pubdate || "",
      volume: summary?.volume || "",
      issue: summary?.issue || "",
      pages: summary?.pages || "",
      authors: summary?.authors || [],
      pubmed_pubtypes: summary?.pubtypes || [],
      pubmed_is_research: isResearch,
      abstract_md
    });

    if((i+1)%10===0) console.log(`...PubMed processed ${i+1}/${items.length}`);
  }

  // JSON 2種
  writeFileSync("public/jama-article-types-with-pubmed.json", JSON.stringify({ ...src, items: enriched }, null, 2));
  const onlyResearch = enriched.filter(x => x.pubmed_is_research === true);
  writeFileSync("public/jama-research-only.json", JSON.stringify({ from: src.from, to: src.to, items: onlyResearch }, null, 2));

  // CSV（Markdownアブスト込み）
  const csv = makeCSV(onlyResearch);
  writeFileSync("public/jama-research.csv", csv);

  console.log(`✅ PubMed判定完了: research-only ${onlyResearch.length}/${enriched.length} saved → jama-research-only.json & jama-research.csv`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
