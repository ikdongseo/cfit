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

// 구글 Jobs 검색
async function fetchGoogleJobs(query) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("engine", "google_jobs");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ko");
  url.searchParams.set("gl", "kr");
  url.searchParams.set("location", "South Korea");

  console.log("Jobs 검색:", query);
  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.error) {
    console.error("SerpAPI 오류:", data.error);
    return [];
  }

  const results = data.jobs_results || [];
  console.log("결과:", results.length + "건");
  return results;
}

function parseGoogleJob(item, query) {
  // 경력 조건 추출
  const highlights = item.job_highlights || [];
  const qualifications = highlights.find(h => h.title === "Qualifications") || {};
  const experience = (qualifications.items || []).find(i => /경력|년|year/i.test(i)) || "";

  return {
    id: Buffer.from((item.job_id || item.title + item.company_name || "")).toString("base64").slice(0, 40),
    source: "google_jobs",
    matchedKeyword: query,
    title: item.title || "",
    company: item.company_name || "",
    url: (item.related_links?.[0]?.link) || "",
    location: item.location || "",
    jobType: (item.detected_extensions?.schedule_type) || "",
    industry: "",
    experience: experience,
    education: "",
    salary: (item.detected_extensions?.salary) || "",
    snippet: item.description?.slice(0, 300) || "",
    postingDate: item.detected_extensions?.posted_at || "",
    expirationDate: "",
    fetchedAt: new Date().toISOString(),
  };
}

async function scoreJobWithClaude(job, resumeText) {
  const jdSummary = [
    "공고 제목: " + job.title,
    "회사: " + job.company,
    "근무지: " + job.location,
    "고용형태: " + job.jobType,
    "경력 조건: " + job.experience,
    "급여: " + job.salary,
    "공고 내용: " + job.snippet,
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

  // 구글 Jobs 쿼리 3개 (월 90회, 무료 한도 내)
  const queries = [
    "SCM 공급망 전략기획 채용 서울",
    "S&OP 수요예측 경영전략 채용 경력",
    "사업전략 DX 오퍼레이션 채용 대기업",
  ];

  console.log("기존 저장된 공고: " + existingJobs.length + "건");

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const results = await fetchGoogleJobs(query);
      for (const item of results) {
        const job = parseGoogleJob(item, query);
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
      console.log("  [" + r.score + "점] " + job.title + " (" + job.company + ")");
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
