/**

 * 환경변수 (로컬에서는 같은 폴더의 .env 파일로도 설정 가능):
 *   BOARD_URL          [필수] 게시판 목록 주소. 예: https://example.com/board01
 *   SLACK_WEBHOOK_URL  Slack Incoming Webhook URL (없으면 화면 출력만)
 *   SITE_NAME          알림에 표시할 이름 (기본: "게시판")
 *   SEEN_FILE          본 글 번호 저장 파일 (기본: board_seen.json)
 *
 * 필요: Node.js 20.12 이상, npm install cheerio
 */

const fs = require("node:fs");
const path = require("node:path");
const cheerio = require("cheerio");
 
// 같은 폴더의 .env 불러오기 (로컬 실행용). 이미 설정된 환경변수는 덮어쓰지 않음
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(ENV_PATH);
}
 
const SITE_NAME = process.env.SITE_NAME || "게시판";
const SEEN_FILE = process.env.SEEN_FILE || "board_seen.json";
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const HEADERS = { "User-Agent": "Mozilla/5.0" };
const MAX_SEEN = 500;
 
// ── 게시판 주소: 환경변수에서만 읽음 ───────────────────────────
// 주소 자체는 로그에 절대 출력하지 않습니다.
function loadBoard() {
  const raw = (process.env.BOARD_URL || "").trim();
  if (!raw) throw new Error("BOARD_URL 환경변수가 설정되지 않았습니다.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BOARD_URL 형식이 올바르지 않습니다.");
  }
  const boardPath = url.pathname.replace(/\/+$/, ""); // 예: /board01
  if (!boardPath) throw new Error("BOARD_URL에 게시판 경로가 없습니다.");
 
  // 글 링크 패턴을 주소에서 만들어 냄: "{게시판 경로}/{숫자}"
  const escaped = boardPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    listUrl: url.origin + boardPath,
    postUrl: (id) => `${url.origin}${boardPath}/${id}`,
    idRe: new RegExp(`${escaped}/(\\d+)`),
  };
}
 
async function fetchPosts(board) {
  const res = await fetch(board.listUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`게시판 요청 실패: HTTP ${res.status}`);
  const html = await res.text();
 
  const $ = cheerio.load(html);
  const posts = [];
  const ids = new Set();
  $("a[href]").each((_, el) => {
    const m = board.idRe.exec($(el).attr("href"));
    if (!m) return;
    const id = m[1];
    const title = ($(el).attr("title") || $(el).text()).replace(/\s+/g, " ").trim();
    if (ids.has(id) || !title) return;
    ids.add(id);
    posts.push({ id, title, url: board.postUrl(id) });
  });
  return posts;
}
 
async function notify(post) {
  // Slack 링크 문법: <URL|표시텍스트>  (제목의 &, <, > 는 이스케이프)
  const title = post.title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const text = `📢 *${SITE_NAME}*\n<${post.url}|${title}>`;
  if (!WEBHOOK) {
    // 로컬 확인용. 링크(게시판 주소 포함)는 출력하지 않고 제목만 보여 줌
    console.log(`[dry-run] 📢 ${SITE_NAME} | ${post.title} (#${post.id})`);
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Slack 전송 실패: HTTP ${res.status}`);
}
 
function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return null;
  return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8")));
}
 
async function main() {
  const board = loadBoard();
  const posts = await fetchPosts(board);
  if (posts.length === 0) {
    throw new Error("글 목록을 가져오지 못했습니다 (사이트 구조 변경 가능성).");
  }
 
  let seen = loadSeen();
  if (seen === null) {
    seen = new Set();
    console.log(`첫 실행: ${posts.length}건 저장, 알림 생략`);
  } else {
    const fresh = posts.filter((p) => !seen.has(p.id));
    // 글 번호가 작은(오래된) 글부터 알림
    fresh.sort((a, b) => Number(a.id) - Number(b.id));
    for (const p of fresh) await notify(p);
    console.log(`[${new Date().toTimeString().slice(0, 8)}] 새 글 ${fresh.length}건 알림`);
  }
 
  for (const p of posts) seen.add(p.id);
  // 무한히 커지지 않게 최근 MAX_SEEN개만 유지 (번호가 클수록 최신)
  const keep = [...seen].sort((a, b) => Number(a) - Number(b)).slice(-MAX_SEEN);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(keep), "utf-8");
}
 
main().catch((e) => {
  // 에러 메시지만 출력 (스택이나 요청 주소가 로그에 남지 않게)
  console.error(`[error] ${e.message}`);
  process.exit(1);
});