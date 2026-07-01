const fs = require("fs");
const path = require("path");

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!SERPAPI_KEY) { console.error("SERPAPI_KEY 없음"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("ANTHROPIC_API_KEY 없음"); process.exit(1); }

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const RESUME_PATH = path.join(DATA_DIR, "resume.txt");
const MAX_JOBS_KEPT = 300;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p,"utf-8")); } catch(e) { return fb; } }
function loadResume() { try { return fs.readFileSync(RESUME_PATH,"utf-8").trim(); } catch(e) { console.error("이력서 없음"); process.exit(1); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// SerpAPI로 구글 검색 → 채용공고 수집
async function fetchJobsByQuery(query) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "kr");
  url.searchParams.set("num", "10");

  console.log("검색:", query);
  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.error) {
    console.error("SerpAPI 오류:", data.error);
    return [];
  }

  const results = data.organic_results || [];
  console.log("결과:", results.length + "건");
  return results;
}

function parseSearchResult(item, query) {
  return {
    id: Buffer.from(item.link || item.title || "").toString("base64").slice(0, 40),
    source: "serpapi",
    matchedKeyword: query,
    title: item.title || "",
    company: item.displayed_link || "",
    url: item.link || "",
    location: "",
    jobType: "",
    industry: "",
    experience: "",
    education: "",
    salary: "",
    snippet: item.snippet || "",
    fetchedAt: new Date().toISOString(),
  };
}

async function scoreJobWithClaude(job, resumeText) {
  const jdSummary = [
    "공고 제목: " + job.title,
    "출처: " + job.company,
    "내용 요약: " + job.snippet,
    "검색 키워드: " + job.matchedKeyword,
  ].join("\n");

  const prompt = `경력기술서와 채용공고를 비교 분석하세요. JSON만 반환하세요. 다른 텍스트 없이.

경력기술서:
${resumeText.slice(0, 3000)}

채용공고:
${jdSummary}

JSON 형식:
{"score":75,"match_keywords":["키워드1","키워드2"],"gap_keywords":["부족1"],"analysis":"분석 2문장"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const m = (data.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON 추출 실패");
  return JSON.parse(m[0]);
}

async function main() {
  const resumeText = loadResume();
  const existingJobs = loadJSON(JOBS_PATH, []);
  const existingIds = new Set(existingJobs.map(j => j.id));

  // 무료 플랜 월 100회 한도 내 운영
  // 하루 1회 실행 × 쿼리 3개 = 월 90회
  const queries = [
    "site:saramin.co.kr SCM 공급망 전략기획 채용",
    "site:saramin.co.kr S&OP 수요예측 경영전략 채용",
    "site:wanted.co.kr SCM 전략기획 사업전략 채용",
  ];

  console.log("기존 저장된 공고: " + existingJobs.length + "건");

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const results = await fetchJobsByQuery(query);
      for (const item of results) {
        const job = parseSearchResult(item, query);
        if (!job.id || seen.has(job.id)) continue;
        seen.add(job.id);
        collected.push(job);
      }
    } catch(e) {
      console.error("수집 실패:", e.message);
    }
    await sleep(500);
  }

  const newJobs = collected.filter(j => !existingIds.has(j.id));
  console.log("신규 공고: " + newJobs.length + "건");

  const scoredNewJobs = [];
  for (const job of newJobs) {
    try {
      const r = await scoreJobWithClaude(job, resumeText);
      scoredNewJobs.push({
        ...job,
        score: r.score,
        matchKeywords: r.match_keywords || [],
        gapKeywords: r.gap_keywords || [],
        analysis: r.analysis || "",
      });
      console.log("  [" + r.score + "점] " + job.title);
    } catch(e) {
      console.error("  매칭 실패:", e.message);
      scoredNewJobs.push({ ...job, score: null, matchKeywords: [], gapKeywords: [], analysis: "" });
    }
    await sleep(200);
  }

  const merged = [...scoredNewJobs, ...existingJobs]
    .sort((a,b) => (b.score??-1) - (a.score??-1))
    .slice(0, MAX_JOBS_KEPT);

  fs.writeFileSync(JOBS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  console.log("완료: " + merged.length + "건 저장");
}

main().catch(e => { console.error("실행 실패:", e); process.exit(1); });
