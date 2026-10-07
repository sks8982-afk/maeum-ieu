/**
 * 별도 동의 화면·개인정보처리방침 문안 — **고지 의무 항목**과 **코드 사실**이 맞물려 있는지.
 *
 * 왜: 동의서 문안은 법적 고지다. 2026-10-06 조사에서 기존 화면 문구("다른 사람 말소리는 서버로 가지
 *   않아요")가 코드 동작(섞인 조각은 함께 전송)과 달랐다 — 사실과 다른 고지는 동의를 무효로 만든다.
 *   그래서 (1) 법이 요구하는 항목이 빠지지 않았는지, (2) 문안 속 숫자·동작이 코드와 같은지를 고정한다.
 *
 * 렌더링: react-dom/server로 첫 화면을 그린다(체크 전 상태).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const { VoiceprintConsentCard, ObserveConsentCard } = await import("@/app/components/SensitiveConsentCards");
const { VOICEPRINT_DIM } = await import("@/lib/voiceprint/constants");
const PrivacyPage = (await import("@/app/privacy/page")).default;

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const vp = html(createElement(VoiceprintConsentCard, { onAgreed: () => {} }));
const ob = html(createElement(ObserveConsentCard, { onAgreed: () => {} }));
const privacy = html(createElement(PrivacyPage));

/**
 * 중요한 내용 표시(<Em>) 안에 들어 있는가 — 시행령 제17조③·처리 방법 고시 제4조.
 *   밑줄(underline)·굵게(font-bold)·색(text-rose-) 클래스가 **각각 단어로** 있어야 한다.
 *   ⚠ 처음엔 "underline"을 부분 문자열로 찾아, 밑줄을 지워도 underline-offset-2에 걸려 녹색이었다(변이로 확인).
 */
const emphasized = (markup: string, text: string) => {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...markup.matchAll(new RegExp(`<b class="([^"]*)">[^<]*${esc}`, "g"))].some(([, cls]) => {
    const words = cls.split(/\s+/);
    return words.includes("underline") && words.includes("font-bold") && words.some((w) => w.startsWith("text-rose-"));
  });
};

describe("목소리 등록 동의 — 제15조②·제23조 고지 항목", () => {
  it.each([
    ["목적", "① 무엇에 쓰나요"],
    ["항목", "② 무엇을 보관하나요"],
    ["보유 기간", "③ 얼마나 보관하나요"],
    ["거부권", "⑤ 동의하지 않으셔도 됩니다"],
    ["불이익", "목소리 등록과 상시 감시만 쓸 수 없습니다"],
  ])("%s 항목이 있다", (_l, text) => {
    expect(vp).toContain(text);
  });

  it("민감정보(생체인식정보)임과 보유 기간을 강조 표시한다", () => {
    expect(emphasized(vp, "목소리 특징값(성문) — 민감정보(생체인식정보)")).toBe(true);
    expect(emphasized(vp, "목소리 등록을 지우시거나 이 동의를 철회하시면 바로 지웁니다")).toBe(true);
  });

  it("체크하기 전엔 동의 버튼이 눌리지 않는다 — 선택 동의를 미리 체크해 두지 않는다", () => {
    expect(vp).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(vp).toMatch(/<button[^>]*disabled[^>]*>동의하고 목소리 등록하기/);
  });

  it(`문안의 "숫자 N개"가 실제 성문 차원과 같다`, () => {
    // 🔒 모델을 바꿔 차원이 달라지면 고지도 바꿔야 한다(그리고 SENSITIVE_CONSENT_VERSION을 올린다)
    expect(vp).toContain(`숫자 ${VOICEPRINT_DIM}개`);
  });
});

describe("상시 감시 동의 — 처리(제23조)와 제공(제17조)을 각각", () => {
  it("체크박스가 둘이고 둘 다 비어 있으며, 둘 다 체크하기 전엔 버튼이 눌리지 않는다", () => {
    expect(ob.match(/type="checkbox"/g)).toHaveLength(2);
    expect(ob).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(ob).toMatch(/<button[^>]*disabled[^>]*>동의하고 상시 감시 준비하기/);
  });

  it("제공 동의의 다섯 항목 — 받는 자·목적·항목·받는 자의 보유 기간은 강조", () => {
    expect(emphasized(ob, "어르신이 연결하신 보호자·의사")).toBe(true);
    expect(emphasized(ob, "위급 상황을 확인하고 도와드리기 위해")).toBe(true);
    expect(emphasized(ob, "어르신 성함, 위급 신호의 단계·종류, 감지 시각")).toBe(true);
    expect(emphasized(ob, "앱에서 보는 기록은 연결이 끊기거나")).toBe(true);
    expect(ob).toContain("동의하지 않으시면");
  });

  it("사실대로 — 섞인 말소리가 함께 갈 수 있다는 한계, 119를 대신하지 않음, 국외 처리", () => {
    // 🔒 예전 문구 "다른 사람 말소리는 서버로 가지 않아요"는 섞인 조각에 대해 사실이 아니었다
    expect(emphasized(ob, "섞이면 함께 보내질 수 있습니다")).toBe(true);
    expect(ob).toContain("119 신고를 대신하지 않습니다");
    expect(ob).toContain("Google LLC");
  });

  it(`메신저 알림의 "최대 200자"가 실제 웹훅 발송 길이와 같다`, () => {
    const notify = readFileSync("lib/chat/emergency-notify.ts", "utf-8");
    expect(notify).toMatch(/payload\.content\.slice\(0, 200\)/);
    expect(ob).toContain("최대 200자");
  });

  it("위급 신호가 없는 말은 저장하지 않는다는 고지가 라우트 동작과 짝이다", () => {
    const route = readFileSync("app/api/observe/turn/route.ts", "utf-8");
    expect(route).toMatch(/if \(emergency\.level === 0\) return NextResponse\.json\(\{ ok: true, text, emergencyLevel: 0 \}\);/);
    expect(emphasized(ob, "위급 신호가 없는 말은 저장하지 않고 버립니다")).toBe(true);
  });
});

describe("개인정보처리방침 — 2026-10-06 개정분", () => {
  it.each([
    "목소리 등록(성문)과 상시 감시 — 선택 기능",
    "개인정보의 제3자 제공",
    "개인정보의 국외 이전",
    "제28조의8제1항제3호",
    "AES-256-GCM",
    "생성형 인공지능(Google Gemini)",
    "119 신고를 대신하지 않습니다",
    "변경 내역",
  ])("%s", (text) => {
    expect(privacy).toContain(text);
  });

  it("국외 이전의 법정 항목(받는 자·국가·항목·시기와 방법·목적·기간·거부)을 모두 적는다", () => {
    const sec = privacy.slice(privacy.indexOf("개인정보의 국외 이전"), privacy.indexOf("7. 보관 및 파기"));
    for (const k of ["이전받는 자", "이전 국가", "이전 항목", "이전 시기·방법", "이용 목적", "보유·이용 기간", "거부 방법·효과"]) {
      expect(sec, k).toContain(k);
    }
  });

  it("보관·파기의 휴대폰 등록 정보(알림 토큰) 줄이 실제 동작과 같다(2026-10-07 — 보호자·의사만 저장·로그아웃 해제·계정 전환 폐기·늦은 정리·탈퇴)", () => {
    const sec = privacy.slice(privacy.indexOf("7. 보관 및 파기"), privacy.indexOf("8. 보호 조치"));
    // (12차) 줄 머리가 "알림 토큰:"에서 "휴대폰 등록 정보(…):"로 — 범위는 계정 삭제 안내·출시 가이드와 같은 말(__tests__/account-deletion-page)
    const line = sec.match(/<li>휴대폰 등록 정보\([^<]*<\/li>/)?.[0] ?? "";
    for (const k of [
      // 5차 — app/api/push/device POST는 보호자·의사(pro) 계정만 저장한다(그 밖의 역할은 { ok:true, stored:false })
      "보호자·의사 계정의 휴대폰만 저장합니다(어르신·일반 계정은 저장하지 않습니다)",
      "앱에서 로그아웃하거나 보호자 화면에서 휴대폰을 삭제하면 지웁니다",            // app/api/push/device DELETE
      // 앱 deleteToken(app/RnBridge 계약) — 새 등록은 새 계정이 보호자·의사일 때만(5차)
      "같은 휴대폰에서 다른 계정으로 로그인하면 이전 토큰은 폐기하고, 새 계정이 보호자·의사 계정이면 새로 등록합니다",
      // retiredTokens(lib/push/devices — 그 휴대폰의 다음 등록)·FCM 오류(다음 발송) — 둘 다 "즉시"가 아니다(4차 정정)
      "연결 문제로 바로 지우지 못한 토큰은 그 휴대폰이 다시 로그인해 등록하거나 알림 발송 때 무효로 확인되는 대로 지우고",
      "알림을 보낼 때 확인되는 대로 삭제",
      "회원 탈퇴 시 계정과 함께 삭제",                                              // push_device FK ON DELETE CASCADE
    ]) expect(line, k).toContain(k);
    // 🔒 예전 문구 — 앱이 계정 전환 때 토큰을 폐기하므로 "그 계정으로 옮겨진다"는 이제 사실과 다르다
    expect(line).not.toContain("그 계정으로 옮겨지고");
    // 🔒 예전 문구 — 지우지 못한 행은 그 휴대폰이 다시 등록하거나 다음 발송 때에야 지워진다. "즉시"는 사실과 다른 고지다
    expect(line).not.toContain("확인되는 즉시");
    // 🔒 예전 문구 — 어르신 계정으로 바꿔 로그인하면 새로 등록하지 않는다(5차)
    expect(line).not.toContain("폐기하고 새로 등록합니다");
  });

  it("수집 항목(1항)의 알림 토큰 — 보호자·의사 계정만 저장한다고 적는다(2026-10-07 5차, app/api/push/device)", () => {
    const sec = privacy.slice(privacy.indexOf("1. 수집하는 개인정보 항목"), privacy.indexOf("2. 개인정보의 이용 목적"));
    const line = sec.match(/<li><b>기기·이용 정보<\/b>:[^<]*<\/li>/)?.[0] ?? "";
    expect(line).toContain("보호자·의사 계정으로 앱에 로그인하면");
    // (12차) 저장 범위는 push_device 그대로 — 계정 삭제 안내·출시 가이드와 같은 문자열(lib/privacy-scopes)
    expect(line).toContain("그 휴대폰의 등록 정보(알림 토큰·앱 버전·알림 허용·위급 알림 채널 상태·마지막 확인 시각)를 그 계정에 저장합니다");
    // 🔒 고지와 동작이 짝이어야 한다 — 서버는 그 밖의 역할(어르신·일반인)의 휴대폰을 저장하지 않는다
    expect(line).toContain("어르신·일반 계정의 휴대폰 알림 토큰은 저장하지 않습니다");
    // 🔒 예전 문구 — 모든 로그인 계정에 저장한다고 읽혔다
    expect(line).not.toContain("로그인한 계정에 저장합니다");
  });

  it("시행일·변경 내역(15항) — 10월 8일(배포일) 시행, 바뀐 것을 빠짐없이 적고 10월 6일 개정분은 그 날짜로 남긴다", () => {
    // 🔒 시행일은 게시(배포)일이다 — 10-07에 쓴 문안이 10-08에 배포되는데 "10월 7일 시행"이라 적으면 게시 전부터 시행된 것처럼 고지된다
    expect(privacy).toContain("시행 2026년 10월 8일");
    expect(privacy).not.toContain("10월 7일");
    const sec = privacy.slice(privacy.indexOf("15. 변경 내역"));
    const items = [...sec.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(items).toHaveLength(3);
    // 🔒 고지 문안(확정) — 바뀐 것을 빠짐없이
    expect(items[0]).toMatch(/^<b>2026년 10월 8일 시행<\/b>: /);
    for (const k of [
      "보호자·의사 계정 휴대폰 등록 정보(알림 토큰·앱 버전·알림 허용·위급 알림 채널 상태·마지막 확인 시각) 저장(1항)과 보관·삭제 기준(7항)",
      // (12차) 1·2·7항에 새로 넣은 구독 기록(항목·이용 목적·보관 기준)도 같은 시행분으로 적는다
      "구독 기록(상품·구독 상태·만료일·구매 토큰·마지막 확인 시각·환불·강제 해지 시각, 결제한 계정과 혜택을 받는 계정) 항목(1항)·이용 목적(2항)과 보관·삭제 기준(7항)",
      "연결된 어르신 화면에 표시되는 알림 수신 가능 여부(9항)",
    ]) {
      expect(items[0], k).toContain(k);
    }
    // 🔒 변경 내역이 2항을 적으면 2항에 그 목적이 실제로 있어야 한다(구독 기록을 저장하는 까닭 — 1항 "구독 혜택을 적용하려고")
    const purposes = privacy.slice(privacy.indexOf("2. 개인정보의 이용 목적"), privacy.indexOf("3. 목소리 등록"));
    expect(purposes).toContain("<li>(유료 구독 시) 구독 혜택 적용·구독 상태 확인</li>");
    // 🔒 10월 6일 개정분이 새 날짜로 둔갑하면 언제 무엇이 바뀌었는지 고지가 틀린다
    expect(items[1]).toMatch(/^<b>2026년 10월 6일 시행<\/b>: 목소리 등록\(성문\)·상시 감시 항목과 별도 동의 신설/);
    expect(items[2]).toBe("이전 방침: 2026년 9월 10일 시행");
  });

  it("연결된 어르신 화면에 보이는 보호자·의사 휴대폰 정보는 '받을 수 있는 상태'뿐 — 열람 범위(9항)에 적는다(2026-10-07 4차)", () => {
    const sec = privacy.slice(privacy.indexOf("9. 결과 열람 범위"), privacy.indexOf("10. 마이크"));
    // 🔒 서버는 상태 셋만 보낸다(app/api/users/linked-experts) — 고지와 동작이 짝이어야 한다
    expect(sec).toContain("<li>연결된 어르신 계정에는 보호자·의사가 앱 알림을 받을 수 있는 상태인지만 표시되며, 휴대폰 대수나 기기 정보는 보이지 않습니다.</li>");
  });

  it("처리 위탁에 실제로 쓰는 사업자가 빠지지 않는다", () => {
    for (const k of ["Gemini API", "Firebase Cloud Messaging", "Gmail", "Amazon Web Services", "Vercel", "Upstash"]) {
      expect(privacy, k).toContain(k);
    }
  });
});
