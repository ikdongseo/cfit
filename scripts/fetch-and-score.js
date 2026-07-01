const fs = require("fs");
const path = require("path");

const WORKNET_KEY = process.env.WORKNET_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!WORKNET_KEY) {
  console.error("WORKNET_API_KEY 환경변수가 없습니다.");
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

const MAX_JOBS_KEPT = 300;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

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
    console.error("이력서 파일을 찾을 수 없습니다: " + RESUME_PATH);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// XML 태그에서 값 추출
function extractXml(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}

function extractAllXml(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

// 워크넷 API 호출
async function fetchWorknetJobs(keyword) {
  const url = new URL("https://www.work24.go.kr/cm/e/a/0110/selectJobseekerInfo.do");
  url.searchParams.set("authKey", WORKNET_KEY);
  url.searchParams.set("callTp", "L");
  url.searchParams.set("returnType", "XML");
  url.searchParams.set("startPage", "1");
  url.searchParams.set("display", "20");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("sortTp", "DATE"); // 최신순
  url.searchParams.set("termContractMmcnt", ""); // 전체 고용형태

  const res = await fetch(url.toString());
  const xml = await res.text();

  // 에러 체크
  const errMsg = extractXml(xml, "errMsg");
  if (errMsg) {
    console.error(`[워크넷 API 오류] keyword="${keyword}" errMsg=${errMsg}`);
    return [];
  }

  const items = extractAllXml(xml, "wanted");
  return items;
}

function parseWorknetJob(itemXml, matchedKeyword) {
  const id = extractXml(itemXml, "wantedAuthNo");
  return {
    id,
    source: "worknet",
    matchedKeyword,
    title: extractXml(itemXml, "jobNm"),
    company: extractXml(itemXml, "cmpnyNm"),
    url: extractXml(itemXml, "wantedInfoUrl") || extractXml(itemXml, "wantedMobileInfoUrl"),
    location: extractXml(itemXml, "workPlacNm"),
    jobType: extractXml(itemXml, "empTpNm"),
    industry: extractXml(itemXml, "jobsCdNm"),
    experience: extractXml(itemXml, "careerCondNm"),
    education: extractXml(itemXml, "educationNm"),
    salary: extractXml(itemXml, "salaryNm"),
    postingDate: extractXml(itemXml, "receiptDt"),
    expirationDate: extractXml(itemXml, "closeDt"),
    fetchedAt: new Date().toISOString(),
  };
}

// Anthropic API로 매칭 점수화
async function scoreJobWithClaude(job, resumeText) {
  const jdSummary = [
    "공고 제목: " + job.title,
    "회사: " + job.company,
    "직무 분야: " + job.industry,
    "경력 조건: " + job.experience,
    "학력 조건: " + job.education,
    "근무 형태: " + job.jobType,
    "근무 지역: " + job.location,
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
    throw new Error("Anthropic 응답 파싱 실패: " + text.slice(0, 200));
  }
  if (data.error) {
    throw new Error("Anthropic API 오류: " + (data.error.message || JSON.stringify(data.error)));
  }

  const replyText = data.content?.[0]?.text || "";
  const match = replyText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON 추출 실패: " + replyText.slice(0, 200));
  return JSON.parse(match[0]);
}

async function main() {
  const resumeText = loadResume();
  const keywords = loadJSON(KEYWORDS_PATH, ["SCM", "S&OP", "공급망", "전략기획", "사업전략"]);
  const existingJobs = loadJSON(JOBS_PATH, []);
  const existingIds = new Set(existingJobs.map((j) => j.id));

  console.log("기존 저장된 공고: " + existingJobs.length + "건");
  console.log("검색 키워드: " + keywords.join(", "));

  // 1. 워크넷 API로 키워드별 수집
  const collected = [];
  const seenInThisRun = new Set();

  for (const keyword of keywords) {
    try {
      const items = await fetchWorknetJobs(keyword);
      for (const itemXml of items) {
        const job = parseWorknetJob(itemXml, keyword);
        if (!job.id || seenInThisRun.has(job.id)) continue;
        seenInThisRun.add(job.id);
        collected.push(job);
      }
      console.log("[" + keyword + "] " + items.length + "건 수집");
    } catch (e) {
      console.error("[" + keyword + "] 수집 실패: " + e.message);
    }
    await sleep(300);
  }

  // 2. 신규 공고만 필터링
  const newJobs = collected.filter((j) => !existingIds.has(j.id));
  console.log("신규 공고: " + newJobs.length + "건");

  // 3. Claude로 매칭 점수화
  const scoredNewJobs = [];
  for (const job of newJobs) {
    try {
      const scoreResult = await scoreJobWithClaude(job, resumeText);
      scoredNewJobs.push({
        ...job,
        score: scoreResult.score,
        matchKeywords: scoreResult.match_keywords || [],
        gapKeywords: scoreResult.gap_keywords || [],
        analysis: scoreResult.analysis || "",
      });
      console.log("  - [" + scoreResult.score + "점] " + job.title + " (" + job.company + ")");
    } catch (e) {
      console.error("  - 매칭 실패 (" + job.title + "): " + e.message);
      scoredNewJobs.push({ ...job, score: null, matchKeywords: [], gapKeywords: [], analysis: "" });
    }
    await sleep(200);
  }

  // 4. 합치고 정렬 후 저장
  const now = Date.now();
  const merged = [...scoredNewJobs, ...existingJobs]
    .filter((j) => {
      if (!j.expirationDate) return true;
      const exp = new Date(j.expirationDate).getTime();
      return isNaN(exp) || exp > now;
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, MAX_JOBS_KEPT);

  fs.writeFileSync(JOBS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  console.log("완료: " + merged.length + "건 저장");
}

main().catch((e) => {
  console.error("실행 실패:", e);
  process.exit(1);
});
