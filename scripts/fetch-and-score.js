/**
 * scripts/fetch-and-score.js
 *
 * 1. 사람인 채용 공고 API로 키워드별 신규 공고 수집
 * 2. 기존에 수집된 공고(data/jobs.json)와 비교해 신규 공고만 추출
 * 3. Anthropic API로 이력서(data/resume.txt) 대비 매칭 점수화
 * 4. data/jobs.json에 점수 포함 결과 저장 (최신순, 최대 N건 유지)
 *
 * 필요한 환경변수 (GitHub Secrets):
 *   SARAMIN_API_KEY   - 사람인 access-key
 *   ANTHROPIC_API_KEY - Anthropic API 키
 */

const fs = require("fs");
const path = require("path");

const SARAMIN_KEY = process.env.SARAMIN_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!SARAMIN_KEY) {
  console.error("SARAMIN_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const RESUME_PATH = path.join(DATA_DIR, "resume.txt");
const KEYWORDS_PATH = path.join(DATA_DIR, "keywords.json");

const MAX_JOBS_KEPT = 300; // jobs.json에 유지할 최대 건수
const MAX_PER_KEYWORD = 20; // 키워드당 가져올 최대 공고 수 (count 파라미터)
const DAILY_CALL_BUDGET_SARAMIN = 80; // 1일 500회 한도 중 여유있게 사용
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// ---------- 유틸 ----------

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

function loadResume() {
  try {
    return fs.readFileSync(RESUME_PATH, "utf-8").trim();
  } catch (e) {
    console.error(`이력서 파일을 찾을 수 없습니다: ${RESUME_PATH}`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 사람인 API ----------

async function fetchSaraminJobs(keyword) {
  const url = new URL("https://oapi.saramin.co.kr/job-search");
  url.searchParams.set("access-key", SARAMIN_KEY);
  url.searchParams.set("keywords", keyword);
  url.searchParams.set("count", String(MAX_PER_KEYWORD));
  url.searchParams.set("sort", "pd"); // 게시일 역순
  url.searchParams.set("fields", "posting-date,expiration-date");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  const data = await res.json();

  if (data.code) {
    // 에러 응답 (code: 1~99)
    console.error(`[사람인 API 오류] keyword="${keyword}" code=${data.code} message=${data.message}`);
    return [];
  }

  const jobList = data?.jobs?.job;
  if (!jobList) return [];
  return Array.isArray(jobList) ? jobList : [jobList];
}

function normalizeSaraminJob(raw, matchedKeyword) {
  const position = raw.position || {};
  const company = raw.company?.detail || {};
  return {
    id: String(raw.id),
    source: "saramin",
    matchedKeyword,
    title: position.title || "",
    company: company.name || "",
    url: raw.url || "",
    location: position.location?.name || "",
    jobType: position.jobType?.name || position["job-type"]?.name || "",
    industry: position.industry?.name || "",
    experience: position["experience-level"]?.name || "",
    education: position["required-education-level"]?.name || "",
    keyword: raw.keyword || "",
    salary: raw.salary?.name || "",
    postingDate: raw["posting-date"] || null,
    expirationDate: raw["expiration-date"] || null,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- Anthropic API ----------

async function scoreJobWithClaude(job, resumeText) {
  const jdSummary = [
    `공고 제목: ${job.title}`,
    `회사: ${job.company}`,
    `직무 분야: ${job.industry}`,
    `경력 조건: ${job.experience}`,
    `학력 조건: ${job.education}`,
    `근무 형태: ${job.jobType}`,
    `근무 지역: ${job.location}`,
    `키워드: ${job.keyword}`,
  ].join("\n");

  const prompt = `경력기술서와 채용공고를 비교 분석하세요. JSON만 반환하세요. 다른 텍스트 없이.

경력기술서:
${resumeText.slice(0, 3000)}

채용공고:
${jdSummary}

JSON 형식:
{"score":75,"match_keywords":["키워드1","키워드2","키워드3"],"gap_keywords":["부족1","부족2"],"analysis":"종합 분석 2문장"}`;

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

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Anthropic 응답 파싱 실패: ${text.slice(0, 200)}`);
  }
  if (data.error) {
    throw new Error(`Anthropic API 오류: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const replyText = data.content?.[0]?.text || "";
  const match = replyText.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`JSON 추출 실패: ${replyText.slice(0, 200)}`);
  }
  return JSON.parse(match[0]);
}

// ---------- 메인 ----------

async function main() {
  const resumeText = loadResume();
  const keywords = loadJSON(KEYWORDS_PATH, [
    "SCM",
    "S&OP",
    "공급망",
    "전략기획",
    "사업전략",
  ]);
  const existingJobs = loadJSON(JOBS_PATH, []);
  const existingIds = new Set(existingJobs.map((j) => j.id));

  console.log(`기존 저장된 공고: ${existingJobs.length}건`);
  console.log(`검색 키워드: ${keywords.join(", ")}`);

  // 1. 사람인 API로 키워드별 수집
  let saraminCalls = 0;
  const collected = [];
  const seenInThisRun = new Set();

  for (const keyword of keywords) {
    if (saraminCalls >= DAILY_CALL_BUDGET_SARAMIN) {
      console.log("사람인 API 호출 예산 소진, 이후 키워드 건너뜀");
      break;
    }
    try {
      const rawJobs = await fetchSaraminJobs(keyword);
      saraminCalls += 1;
      for (const raw of rawJobs) {
        const job = normalizeSaraminJob(raw, keyword);
        if (seenInThisRun.has(job.id)) continue; // 이번 실행 내 중복 제거
        seenInThisRun.add(job.id);
        collected.push(job);
      }
      console.log(`[${keyword}] ${rawJobs.length}건 수집`);
    } catch (e) {
      console.error(`[${keyword}] 수집 실패: ${e.message}`);
    }
    await sleep(300); // API 과호출 방지
  }

  // 2. 신규 공고만 필터링 (기존에 없던 것)
  const newJobs = collected.filter((j) => !existingIds.has(j.id));
  console.log(`신규 공고: ${newJobs.length}건 (Claude 매칭 분석 대상)`);
