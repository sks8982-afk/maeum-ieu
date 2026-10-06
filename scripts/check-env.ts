/**
 * 배포 환경변수 점검 — 현장 테스트/프로덕션 투입 전 필수 env 존재·형식 검증.
 *   ⚠️ 비밀값은 절대 출력하지 않음(존재·형식·기능 영향만 표시).
 *   로컬: `npx tsx scripts/check-env.ts` (.env 기준)
 *   프로덕션: Vercel에서 `vercel env pull .env.prod` 후 `dotenv -e .env.prod -- tsx scripts/check-env.ts`
 *             또는 배포 환경에서 직접 실행.
 */
import "dotenv/config";

/**
 * `--build` 모드 — **빌드가 실제로 필요로 하는 것만** 실패 사유로 본다.
 *
 * 왜 나눴나 (2026-10-02, AWS 이전 감사 blocker):
 *   package.json의 prebuild가 이 스크립트를 돌리는데, 전체 모드는 DATABASE_URL·
 *   ENCRYPTION_KEY·GMAIL_APP_PASSWORD 같은 **런타임 시크릿**이 없으면 exit 1을 낸다.
 *   Vercel에서는 빌드 환경에 런타임 env가 함께 주입돼 가려져 있었지만, Docker/CodeBuild에서는
 *   둘 중 하나가 된다:
 *     (a) 빌드가 무조건 실패하거나
 *     (b) 통과시키려고 빌드 인자로 시크릿을 넣어 **이미지 레이어에 박힌다**
 *   둘 다 받아들일 수 없다. 빌드에 진짜 필요한 건 NEXT_PUBLIC_*(번들에 인라인되는 값)뿐이다.
 *   런타임 검증은 배포 단계에서 `npm run check:env:deploy`로 따로 돌린다.
 */
const BUILD_MODE = process.argv.includes("--build");

/** 빌드 산출물에 영향을 주는 변수 — 이것만 빌드 실패 사유가 될 수 있다. */
const BUILD_TIME_VARS = ["NEXT_PUBLIC_SHOW_LIVE_BETA"];

type Sev = "critical" | "important" | "optional";
interface Check {
  label: string;
  sev: Sev;
  feature: string;
  breaks: string;                       // 없을 때 무슨 일이 나는지
  names: string[];                       // 이 중 하나라도 있으면 present (대체 허용: _B64 등)
  validate?: (v: string) => string | null; // 형식 오류 문자열 또는 null(정상)
}

function jsonFields(v: string, fields: string[]): string | null {
  try { const o = JSON.parse(v); for (const f of fields) if (!o[f]) return `JSON에 '${f}' 필드 없음`; return null; }
  catch { return "JSON 파싱 실패(한 줄인지·따옴표 확인)"; }
}
function b64Json(v: string, fields: string[]): string | null {
  try { return jsonFields(Buffer.from(v, "base64").toString("utf8"), fields); } catch { return "base64 디코드 실패"; }
}

const CHECKS: Check[] = [
  // ── 코어(앱 자체) ──
  { label: "DATABASE_URL", sev: "critical", feature: "DB", breaks: "앱 전체 동작 불가", names: ["DATABASE_URL"],
    validate: v => /^postgres(ql)?:\/\//.test(v) ? null : "postgres URL 형식 아님" },
  { label: "GEMINI_API_KEY", sev: "critical", feature: "AI 대화·분석", breaks: "대화·인지분석·백스톱 전부 불가", names: ["GEMINI_API_KEY"] },
  { label: "NEXTAUTH_SECRET", sev: "critical", feature: "로그인 세션(JWT 서명)", breaks: "로그인 불가 또는 세션 위조 위험", names: ["NEXTAUTH_SECRET"],
    validate: v => v.length >= 32 ? null : "권장: 32자 미만 — 동작은 하나 더 긴 무작위 값 권장" },
  /**
   * ⚠ self-host(AWS)에서 **필수**. Vercel에서는 플랫폼이 넣는 VERCEL 변수 덕에 next-auth가
   *   origin을 자동 추론해 이 항목이 없어도 동작했고, 그래서 지금까지 보이지 않았다.
   *   AWS에는 VERCEL도 AUTH_TRUST_HOST도 없으므로 누락 시 origin이 http://localhost:3000으로
   *   폴백한다. 결과가 두 겹으로 나쁘다:
   *     (1) url.base가 https가 아니라 useSecureCookies=false → 쿠키 이름이 `__Secure-` 접두사를
   *         잃는다. 기존 세션 전원이 즉시 로그아웃되고, 새 쿠키는 Secure 플래그가 없어
   *         건강 민감정보 세션이 평문 HTTP로도 전송 가능해진다.
   *     (2) middleware의 withAuth 리다이렉트 기준이 localhost로 잡힌다.
   *   안전 영향: 어르신이 로그인하지 못하면 /chat에 못 들어가고, 그러면 응급 감지
   *   파이프라인이 **한 번도 실행되지 않는다**. 증상은 '로그인 안 됨'으로만 보여서
   *   응급 미작동과 연결 짓기 어렵다.
   *   ALB가 TLS를 종단해 Node는 http를 보므로, 이 값을 https로 고정하는 것이 쿠키 Secure를
   *   지키는 방법이다(동시에 ALB 리스너에서 80→443 리다이렉트).
   */
  { label: "NEXTAUTH_URL", sev: "critical", feature: "로그인 origin·쿠키 Secure·리다이렉트",
    breaks: "self-host에서 전원 로그인 불가 + 세션 쿠키 Secure 소실 + 기존 세션 전원 무효 → 어르신이 대화에 못 들어가 응급 감지가 아예 안 돈다",
    names: ["NEXTAUTH_URL"],
    validate: v => /^https:\/\//.test(v) ? null : "https:// 로 시작해야 함 — http면 세션 쿠키 Secure 플래그가 꺼진다" },
  // ── 위급 알림(현장 테스트 핵심) ──
  { label: "FCM_SERVICE_ACCOUNT(_B64)", sev: "critical", feature: "보호자 앱 푸시", breaks: "앱 위급 알림이 조용히 skip됨", names: ["FCM_SERVICE_ACCOUNT_B64", "FCM_SERVICE_ACCOUNT"],
    validate: v => (v.trim().startsWith("{") ? jsonFields(v, ["project_id", "private_key", "client_email"]) : b64Json(v, ["project_id", "private_key", "client_email"])) },
  { label: "ENCRYPTION_KEY", sev: "critical", feature: "연락처 PII·목소리 특징값(성문) 암/복호화", breaks: "보호자 이메일/전화 복호화 불가 → 이메일 알림 실패, PII 평문 저장. 목소리 등록은 저장 거부(평문 금지)·기존 성문 대조 불가",
    names: ["ENCRYPTION_KEY"], validate: v => /^[0-9a-fA-F]{64}$/.test(v) ? null : (v.length >= 16 ? "hex64 아님 → 패스프레이즈로 SHA-256 파생됨(정상이나 ⚠️바뀌면 기존 데이터 복호화 불가)" : "너무 짧음") },
  { label: "GMAIL_USER + GMAIL_APP_PASSWORD", sev: "important", feature: "이메일 위급 알림", breaks: "이메일 채널 미동작(앱푸시/webhook은 별개)", names: ["GMAIL_USER"],
    validate: v => { const pw = process.env.GMAIL_APP_PASSWORD; if (!pw) return "GMAIL_APP_PASSWORD 없음"; if (!/@/.test(v)) return "GMAIL_USER 이메일 형식 아님"; return null; } },
  // ── 음성(TTS) — 계획 env 목록에 누락돼 있었음 ──
  { label: "GOOGLE_APPLICATION_CREDENTIALS_JSON(_B64)", sev: "important", feature: "Google Cloud 고품질 TTS", breaks: "Cloud TTS 불가 → Gemini TTS 폴백(GEMINI_API_KEY)으로 동작하나 음질/지연 확인 필요",
    names: ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS_B64"],
    validate: v => (v.trim().startsWith("{") ? jsonFields(v, ["project_id", "private_key", "client_email"]) : b64Json(v, ["project_id", "private_key", "client_email"])) },
  { label: "GCP_PROJECT_ID", sev: "important", feature: "서버 TTS", breaks: "TTS 프로젝트 식별 불가", names: ["GCP_PROJECT_ID"] },
  // ── rate-limit ──
  { label: "UPSTASH_REDIS_REST_URL + _TOKEN", sev: "important", feature: "분산 rate-limit", breaks: "인메모리 폴백(서버리스에서 부정확·남용 방어 약화)", names: ["UPSTASH_REDIS_REST_URL"],
    validate: v => { if (!process.env.UPSTASH_REDIS_REST_TOKEN) return "UPSTASH_REDIS_REST_TOKEN 없음"; return /^https:\/\//.test(v) ? null : "https URL 아님"; } },
  // ── 구독 결제(Play Billing) — 미설정이면 결제만 불가, 서비스는 무료 티어로 정상 동작 ──
  { label: "PLAY_PACKAGE_NAME", sev: "optional", feature: "구독 구매 검증", breaks: "/api/billing/verify가 503 — 결제 불가(무료 이용은 정상)", names: ["PLAY_PACKAGE_NAME"],
    validate: v => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(v) ? null : "안드로이드 패키지명 형식 아님" },
  { label: "PLAY_SERVICE_ACCOUNT_JSON", sev: "optional", feature: "구독 구매 검증", breaks: "구매 토큰을 Google에 확인할 수 없어 권리 부여 불가",
    names: ["PLAY_SERVICE_ACCOUNT_JSON"],
    validate: v => (v.trim().startsWith("{") ? jsonFields(v, ["client_email", "private_key"]) : b64Json(v, ["client_email", "private_key"])) },
  { label: "BILLING_RTDN_SECRET", sev: "optional", feature: "갱신·해지 통지(RTDN)", breaks: "엔드포인트가 404로 닫힘 — 해지·환불이 반영되지 않아 혜택이 샐 수 있음",
    names: ["BILLING_RTDN_SECRET"], validate: v => v.length >= 24 ? null : "너무 짧음 — 24자 이상 무작위 값 권장" },
  { label: "BILLING_PRO_PRODUCT_IDS", sev: "optional", feature: "유료 상품 식별", breaks: "비어 있으면 모든 구독 상품을 유료로 인정(가격 미확정 단계에선 정상)",
    names: ["BILLING_PRO_PRODUCT_IDS"] },
  // ── 운영 통보·관리 (2026-10-02 추가 — 둘 다 "없으면 조용히 꺼지는" 유형) ──
  { label: "OPS_ALERT_EMAIL", sev: "optional", feature: "운영자 경보 받는 주소(모든 보호자 채널 실패 시)",
    breaks: "없으면 보내는 Gmail(GMAIL_USER) 자신에게 간다(2026-10-06). GMAIL_USER까지 없으면 보호자에게 한 건도 못 보낸 응급을 아무도 모른다",
    names: ["OPS_ALERT_EMAIL"], validate: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "이메일 형식 아님" },
  { label: "ADMIN_EMAILS", sev: "important", feature: "관리자 콘솔(/admin)",
    breaks: "관리자로 인정되는 계정이 없어 운영 통계·회원 현황을 아무도 못 본다",
    names: ["ADMIN_EMAILS"], validate: v => v.includes("@") ? null : "콤마 구분 이메일 목록이어야 함" },
];

/**
 * 값이 없어도 동작하지만 **무엇으로 동작하는지 보여야 하는** 설정.
 *
 * 왜 따로 두나: 이들은 전부 코드에 기본값이 있어 누락이 에러를 내지 않는다. 그래서
 *   "설정했다고 생각했는데 기본값으로 돌고 있었다"가 조용히 성립한다 — 모델을 내렸다가
 *   인지 선별 지시 준수가 깨진 2026-09-30 사고가 그 유형이다.
 *   누락을 실패로 처리하지는 않되(기본값이 올바른 선택이다), **실효값을 눈에 보이게** 찍는다.
 */
const EFFECTIVE: { label: string; name: string; fallback: string; note: string }[] = [
  { label: "동반자 모델(수다 턴)", name: "COMPANION_MODEL", fallback: "gemini-2.5-flash", note: "확인 턴은 아래 PROBE로 상향" },
  { label: "동반자 모델(확인 턴)", name: "COMPANION_PROBE_MODEL", fallback: "gemini-3.8-flash", note: "내리면 인지 선별 지시 준수가 깨진다(2026-09-30 실측)" },
  { label: "인지 분석기", name: "COGNITIVE_MODEL", fallback: "gemini-3.8-flash", note: "2단 라우팅의 primary" },
  { label: "STT", name: "STT_MODEL", fallback: "gemini-2.5-flash", note: "" },
  { label: "Live", name: "LIVE_MODEL", fallback: "(코드 기본값)", note: "NEXT_PUBLIC_SHOW_LIVE_BETA=1일 때만" },
  { label: "일일 턴 상한", name: "DAILY_TURN_LIMIT", fallback: "100", note: "빈 문자열은 미설정으로 처리(명시적 0만 해제)" },
  { label: "유료 턴 상한", name: "PRO_DAILY_TURN_LIMIT", fallback: "무료×3", note: "" },
  { label: "2단 분석 라우팅", name: "COGNITIVE_TWO_STAGE", fallback: "활성(0이면 비활성)", note: "" },
  { label: "프롬프트 캐시", name: "PROMPT_CACHE", fallback: "off(1일 때만 on)", note: "멀티 인스턴스에서 핸들이 인스턴스별" },
  { label: "C2 악화 알림", name: "C2_NOTIFY", fallback: "off", note: "" },
  { label: "Live 베타 노출", name: "NEXT_PUBLIC_SHOW_LIVE_BETA", fallback: "off", note: "⚠ 빌드 타임에 번들에 박힌다 — 런타임 주입으로는 바뀌지 않는다" },
];

const icon = { ok: "✅", miss: "❌", warn: "⚠️ " };
const sevTag = { critical: "🔴 필수", important: "🟠 권장", optional: "🟡 선택" };

let criticalMissing = 0, importantMissing = 0;
console.log(`\n===== 배포 env 점검 (NODE_ENV=${process.env.NODE_ENV || "development"}) =====`);
console.log(`※ 비밀값은 표시하지 않음 — 존재·형식만 검사\n`);

for (const c of CHECKS) {
  const val = c.names.map(n => process.env[n]).find(v => v && v.length > 0);
  if (!val) {
    console.log(`${icon.miss} ${sevTag[c.sev]}  ${c.label} — 없음`);
    console.log(`      ↳ ${c.breaks}`);
    if (c.sev === "critical") criticalMissing++; else if (c.sev === "important") importantMissing++;
    continue;
  }
  const err = c.validate ? c.validate(val) : null;
  if (err && (err.startsWith("hex64") || err.startsWith("권장"))) console.log(`${icon.warn}${sevTag[c.sev]}  ${c.label} — 있음 (${err})`);
  else if (err) { console.log(`${icon.warn}${sevTag[c.sev]}  ${c.label} — 있으나 형식 이상: ${err}`); if (c.sev === "critical") criticalMissing++; }
  else console.log(`${icon.ok} ${sevTag[c.sev]}  ${c.label} — OK (${c.feature})`);
}

// ── 실효값 (없어도 동작하지만 무엇으로 도는지 보여야 하는 것) ──
console.log(`
===== 실효 설정값 =====`);
for (const e of EFFECTIVE) {
  const v = process.env[e.name]?.trim();
  const shown = v && v.length > 0 ? v : `(기본) ${e.fallback}`;
  console.log(`   ${e.label.padEnd(22, " ")} ${shown}${e.note ? `   — ${e.note}` : ""}`);
}

// 주의 플래그
console.log("");
if (process.env.DATABASE_SSL_NO_VERIFY === "1")
  console.log(`${icon.warn}주의: DATABASE_SSL_NO_VERIFY=1 — RDS TLS 인증서 검증이 꺼진다(중간자 위험). 건강 민감정보 DB이므로 프로덕션에서 반드시 제거.`);
// Upstash 미설정 = 레이트리밋이 **조용히** 인메모리 폴백으로 내려간다 — 멀티 인스턴스에서 한도가 N배가 된다.
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)
  console.log(`${icon.warn}주의: Upstash 미설정 — rate-limit이 인메모리 폴백. 인스턴스 수만큼 한도가 늘어나 남용 방어가 사실상 사라진다.`);
// self-host 전용 경고 — Vercel에서는 플랫폼이 가려주던 항목들
if (!process.env.VERCEL && !process.env.NEXTAUTH_URL)
  console.log(`${icon.warn}주의: VERCEL 환경이 아닌데 NEXTAUTH_URL이 없다 — next-auth origin이 localhost로 폴백해 로그인이 깨진다.`);

console.log(`\n===== 판정 =====`);
console.log(`🔴 필수 누락/오류: ${criticalMissing}  ·  🟠 권장 누락: ${importantMissing}`);
if (BUILD_MODE) {
  // 빌드 모드: 번들에 인라인되는 값만 실패 사유. 런타임 시크릿은 참고로만 보고한다.
  console.log(`\n[--build] 빌드 게이트 — 번들에 박히는 값만 검사합니다.`);
  for (const n of BUILD_TIME_VARS) {
    const v = process.env[n]?.trim();
    console.log(`   ${n} = ${v && v.length ? v : "(미설정 → off로 빌드됨)"}`);
  }
  console.log(`   ※ 위 값은 **빌드 시점에 번들에 고정**된다 — 런타임 env로는 바꿀 수 없다.`);
  console.log(`   ※ 런타임 시크릿(DATABASE_URL·ENCRYPTION_KEY 등)은 여기서 실패 사유가 아니다.`);
  console.log(`     배포 단계에서 'npm run check:env:deploy'(전체 모드)를 따로 돌려 확인할 것.`);
  console.log(`✅ 빌드 진행 가능.`);
  process.exit(0);
}

if (criticalMissing > 0) console.log(`❌ 배포 불가 — 필수 env를 채운 뒤 재확인하세요.`);
else if (importantMissing > 0) console.log(`⚠️  가능하나 일부 기능 제한(위 권장 항목 확인). 특히 알림/운영 통보 채널.`);
else console.log(`✅ 필수·권장 env 모두 충족.`);
console.log(`\n※ 이 결과는 실행한 환경의 것 — 배포 판정은 **실제 런타임 환경**(ECS 태스크 등)에서 동일 실행해야 확정됩니다.`);
process.exit(criticalMissing > 0 ? 1 : 0);
