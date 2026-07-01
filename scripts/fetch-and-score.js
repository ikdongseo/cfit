const fs = require("fs");
const path = require("path");

const WORKNET_KEY = process.env.WORKNET_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!WORKNET_KEY) { console.error("WORKNET_API_KEY 없음"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("ANTHROPIC_API_KEY 없음"); process.exit(1); }

const DATA_DIR = path.join(__dirname, "..", "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const RESUME_PATH = path.join(DATA_DIR, "resume.txt");
const KEYWORDS_PATH = path.join(DATA_DIR, "keywords.json");
const MAX_JOBS_KEPT = 300;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p,"utf-8")); } catch(e) { return fb; } }
function loadResume() { try { return fs.readFileSync(RESUME_PATH,"utf-8").trim(); } catch(e) { console.error("이력서 없음"); process.exit(1); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractXml(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").trim() : "";
}
function extractAllXml(xml, tag) {
  const results = []; const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g"); let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

async function fetchWorknetJobs(keyword) {
  const url = new URL("https://apis.data.go.kr/B552474/JobPostingInfoService/getJobPostings");
  url.searchParams.set("serviceKey", WORKNET_KEY);
  url.searchParams.set("callTp", "L");
  url.searchParams.set("returnType", "XML");
  url.searchParams.set("startPage", "1");
  url.searchParams.set("display", "20");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("sortTp", "DATE");

  console.log("요청:", url.toString().replace(WORKNET_KEY, "***"));
  const res = await fetch(url.toString());
  const xml = await res.text();
  console.log("응답:", xml.slice(0, 400));

  let items = extractAllXml(xml, "wanted");
  if (items.length === 0) items = extractAllXml(xml, "item");
  return items;
}

function parseJob(itemXml, keyword) {
  return {
    id: extractXml(itemXml, "wantedAuthNo") || extractXml(itemXml, "recrutPblntSn"),
    source: "worknet", matchedKeyword: keyword,
    title: extractXml(itemXml, "jobNm") || extractXml(itemXml, "recrutPbancTtl"),
    company: extractXml(itemXml, "cmpnyNm") || extractXml(itemXml, "instNm"),
    url: extractXml(itemXml, "wantedInfoUrl") || extractXml(itemXml, "srcUrl"),
    location: extractXml(itemXml, "workPlacNm") || extractXml(itemXml, "workRgnNm"),
    jobType: extractXml(itemXml, "empTpNm") || extractXml(itemXml, "emplymShpNm"),
    industry: extractXml(itemXml, "jobsCdNm") || "",
    experience: extractXml(itemXml, "careerCondNm") || "",
    education: extractXml(itemXml, "educationNm") || "",
    salary: extractXml(itemXml, "salaryNm") || "",
    postingDate: extractXml(itemXml, "receiptDt") || "",
    expirationDate: extractXml(itemXml, "closeDt") || "",
    fetchedAt: new Date().toISOString(),
  };
}

async function scoreJobWithClaude(job, resumeText) {
  const jdSummary = [
    "공고 제목: " + job.title,
    "회사: " + job.company,
    "직무 분야: " + job.industry,
    "경력 조건: " + job.experience,
    "근무 형태: " + job.jobType,
    "근무 지역: " + job.location,
  ].join("\n");

  const prompt = `경력기술서와 채용공고를 비교 분석하세요. JSON만 반환하세요.

경력기술서:
${resumeText.slice(0, 3000)}

채용공고:
${jdSummary}

JSON 형식:
{"score":75,"match_keywords":["키워드1","키워드2"],"gap_keywords":["부족1"],"analysis":"분석 2문장"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const m = (data.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON 추출 실패");
  return JSON.parse(m[0]);
}

async function main() {
  const resumeText = loadResume();
  const keywords = loadJSON(KEYWORDS_PATH, ["SCM","S&OP","공급망","전략기획","사업전략"]);
  const existingJobs = loadJSON(JOBS_PATH, []);
  const existingIds = new Set(existingJobs.map(j => j.id));

  console.log("기존 저장된 공고: " + existingJobs.length + "건");
  console.log("검색 키워드: " + keywords.join(", "));

  const collected = [];
  const seen = new Set();

  for (const keyword of keywords) {
    try {
      const items = await fetchWorknetJobs(keyword);
      for (const xml of items) {
        const job = parseJob(xml, keyword);
        if (!job.id || seen.has(job.id)) continue;
        seen.add(job.id); collected.push(job);
      }
      console.log("[" + keyword + "] " + items.length + "건 수집");
    } catch(e) { console.error("[" + keyword + "] 실패: " + e.message); }
    await sleep(300);
  }

  const newJobs = collected.filter(j => !existingIds.has(j.id));
  console.log("신규 공고: " + newJobs.length + "건");

  const scoredNewJobs = [];
  for (const job of newJobs) {
    try {
      const r = await scoreJobWithClaude(job, resumeText);
      scoredNewJobs.push({ ...job, score: r.score, matchKeywords: r.match_keywords||[], gapKeywords: r.gap_keywords||[], analysis: r.analysis||"" });
      console.log("  [" + r.score + "점] " + job.title);
    } catch(e) {
      console.error("  매칭 실패: " + e.message);
      scoredNewJobs.push({ ...job, score: null, matchKeywords: [], gapKeywords: [], analysis: "" });
    }
    await sleep(200);
  }

  const now = Date.now();
  const merged = [...scoredNewJobs, ...existingJobs]
    .filter(j => { if (!j.expirationDate) return true; const exp = new Date(j.expirationDate).getTime(); return isNaN(exp) || exp > now; })
    .sort((a,b) => (b.score??-1) - (a.score??-1))
    .slice(0, MAX_JOBS_KEPT);

  fs.writeFileSync(JOBS_PATH, JSON.stringify(merged, null, 2), "utf-8");
  console.log("완료: " + merged.length + "건 저장");
}

main().catch(e => { console.error("실행 실패:", e); process.exit(1); });
