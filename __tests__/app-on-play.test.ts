/**
 * Play 배포 스위치(NEXT_PUBLIC_APP_ON_PLAY=1) — 하나가 두 가지를 함께 바꾼다(2026-10-07, lib/app-version 주석):
 *   · 로그인 화면 앱 받기: 꺼짐 = 웹 APK(1.0.3, download) / 켜짐 = Play 스토어(새 창 — 앱 웹뷰에서 Play 앱이 열리게)
 *     (10차) 앱 안에서는 웹 APK·"최신 v1.0.3"을 그리지 않는다(Play 정책) — 꺼짐이면 앱 안엔 아무것도 없다
 *   · 기기 토큰 시대 경고(PUSH_TOKENS_LIVE): 꺼짐이면 휴대폰 0대를 경고하지 않는다 — 현장 앱 1.0.3은 휴대폰 등록을 모르고
 *     토픽으로 받는다. 1.2.0 프로덕션 단계적 출시가 100%가 되기 전에 1.0.3 사용자에게 "휴대폰 없음·업데이트"를 띄우면 안 된다.
 *   (2026-10-08) 켜는 때는 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤다 — "공개"됐다는 것만으로는 아니다(배포 점검 문구로 고정한다, 아래).
 * 빌드 타임 값이라 모듈을 읽을 때 정해진다 → env를 바꾸고 모듈 레지스트리를 비운 뒤 다시 import한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

async function withFlag<T>(flag: string | undefined, load: () => Promise<T>): Promise<T> {
  vi.stubEnv("NEXT_PUBLIC_APP_ON_PLAY", flag);
  vi.resetModules();
  return load();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("lib/app-version — 스위치 하나", () => {
  it("꺼짐(미설정) → 최신 1.0.3, 기기 토큰 경고 꺼짐", async () => {
    const v = await withFlag(undefined, () => import("@/lib/app-version"));
    expect(v.APP_ON_PLAY).toBe(false);
    expect(v.LATEST_APP_VERSION).toBe("1.0.3");
    // 🔒 켜져 있으면 1.0.3 시대에 "휴대폰 없음"·운영 경보가 응급마다 뜬다
    expect(v.PUSH_TOKENS_LIVE).toBe(false);
  });

  it("'1' → 최신 1.2.0, 기기 토큰 경고 켜짐", async () => {
    const v = await withFlag("1", () => import("@/lib/app-version"));
    expect(v.APP_ON_PLAY).toBe(true);
    expect(v.LATEST_APP_VERSION).toBe("1.2.0");
    expect(v.PUSH_TOKENS_LIVE).toBe(true);
  });

  it.each(["0", "true", "", " 1", "yes"])("정확히 '1'만 켠다 — %j는 꺼짐", async (flag) => {
    const v = await withFlag(flag, () => import("@/lib/app-version"));
    expect(v.APP_ON_PLAY).toBe(false);
    expect(v.PUSH_TOKENS_LIVE).toBe(false);
  });

  it("Play 주소·휴대폰 등록 최소 버전", async () => {
    const v = await withFlag(undefined, () => import("@/lib/app-version"));
    expect(v.PLAY_STORE_URL).toBe("https://play.google.com/store/apps/details?id=com.maeumapp");
    expect(v.MIN_PUSH_TOKEN_APP_VERSION).toBe("1.2.0");
  });
});

describe("어르신 마이페이지 — 연결한 분의 앱 알림 표시(appAlertLabel)", () => {
  it("꺼짐: 미등록(none)은 아무것도 표시하지 않는다(1.0.3은 토픽으로 받는 게 정상) — 꺼짐 보고·받는 중은 그대로", async () => {
    const { appAlertLabel } = await withFlag(undefined, () => import("@/lib/push/app-alert-label"));
    // 🔒 "⚠ 앱 알림 미등록"이 뜨면 잘 받고 있는 보호자를 못 받는 사람으로 보이게 한다
    expect(appAlertLabel("none")).toBeNull();
    expect(appAlertLabel("off")).toEqual({ text: "⚠ 앱 알림 꺼짐", warn: true });
    // 🔒 휴대폰 대수는 그분의 휴대폰 정보다 — 어르신 화면엔 "받을 수 있나"만(2026-10-07 4차, 개인정보처리방침 9항)
    expect(appAlertLabel("ready")).toEqual({ text: "앱 알림 ✅", warn: false });
  });

  it("켜짐: 미등록(none)은 '⚠ 앱 알림 미등록'(경고) — 꺼짐·받는 중은 스위치와 상관없이 같다", async () => {
    const { appAlertLabel } = await withFlag("1", () => import("@/lib/push/app-alert-label"));
    expect(appAlertLabel("none")).toEqual({ text: "⚠ 앱 알림 미등록", warn: true });
    expect(appAlertLabel("off")).toEqual({ text: "⚠ 앱 알림 꺼짐", warn: true });
    expect(appAlertLabel("ready")).toEqual({ text: "앱 알림 ✅", warn: false });
  });

  it("마이페이지는 이 함수로만 표시하고, 해결 안내도 경고가 있을 때만 붙인다", () => {
    const src = readFileSync("app/mypage/page.tsx", "utf-8");
    expect(src).toMatch(/import \{ appAlertLabel, type AppAlertState \} from "@\/lib\/push\/app-alert-label"/);
    // 서버가 보내는 값은 상태 셋뿐이다(대수 없음 — 4차) — 화면의 타입도 그 셋이어야 한다
    expect(src).toMatch(/appAlert\?: AppAlertState \| null/);
    // 화면에 문구를 다시 박으면 스위치를 비켜 간다
    expect(src).not.toContain("앱 알림 미등록");
    expect(src).toMatch(/linkedExperts\.some\(\(e\) => e\.appAlert && appAlertLabel\(e\.appAlert\)\?\.warn\)/);
  });
});

const PLAY = "https://play.google.com/store/apps/details?id=com.maeumapp";
const anchorTo = (html: string, href: string) => html.match(new RegExp(`<a[^>]*href="${href.replace(/[.?]/g, "\\$&")}"[^>]*>`))?.[0];

describe("로그인 화면 앱 받기 버튼", () => {
  async function renderLogin(flag: string | undefined) {
    const { default: LoginPage } = await withFlag(flag, () => import("@/app/login/page"));
    return renderToStaticMarkup(createElement(LoginPage)).replace(/<!-- -->/g, "");
  }

  /**
   * 서버 렌더는 앱인지 모른다(2026-10-08 10차) — 그때 브라우저용(APK)을 그리면 Play로 받은 앱 웹뷰에 하이드레이션 전까지 웹 APK 링크가
   *   보인다(Play 정책 — AppDownload 주석). 앱인지 안 뒤(페이지 효과)에야 그린다. 브라우저·앱별 모양은 아래 AppDownload describe가 그려 본다.
   */
  it.each([[undefined], ["1"]])("스위치 %s: 서버 렌더(앱인지 모름)엔 앱 받기 영역이 없다 — APK·Play 링크·'최신 v' 줄 없음", async (flag) => {
    const html = await renderLogin(flag);
    expect(html).toContain("로그인");   // 페이지는 그려졌다(빈 화면이 아니다)
    // 🔒 앱 웹뷰는 이 HTML을 하이드레이션 전에 그대로 보여 준다 — 여기 APK 링크가 있으면 Play 앱 안에 APK 다운로드가 뜬다
    expect(html).not.toContain("maeum-app.apk");
    expect(html).not.toContain("play.google.com");
    expect(html).not.toContain("최신 v");
  });
});

/**
 * 업데이트 안내 + 받기 버튼(app/login/AppDownload) — 페이지에선 앱 버전을 읽은 뒤(효과)에만 그려져 서버 렌더로 볼 수 없던
 *   부분을, 상태를 받는 순수 컴포넌트로 빼서 두 스위치 값에서 그대로 그려 본다(예전 소스 grep 테스트를 대신한다).
 */
describe("로그인 화면 업데이트 안내 + 받기 버튼(AppDownload) — 두 스위치 값에서 그려 본다", () => {
  async function renderDownload(flag: string | undefined, props: { updateNeeded: boolean; appVersion: string | null; inApp: boolean }) {
    const { AppDownload } = await withFlag(flag, () => import("@/app/login/AppDownload"));
    return renderToStaticMarkup(createElement(AppDownload, props)).replace(/<!-- -->/g, "");
  }

  it("켜짐 + 업데이트 필요: Play로 새 창(target=_blank), '먼저 삭제' 안내 — APK·download 없음", async () => {
    const html = await renderDownload("1", { updateNeeded: true, appVersion: "1.0.3", inApp: true });
    const a = anchorTo(html, PLAY);
    expect(a).toBeDefined();
    // 🔒 같은 창이면 Play 웹페이지가 앱 웹뷰 안에 떠 업데이트를 못 한다
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(a).not.toContain("download");
    expect(html).toContain("⚠️ 새 버전 <b>v1.2.0</b>이 Play 스토어에 나왔어요. 아래 버튼으로 업데이트해 주세요.");
    // 🔒 웹 APK와 Play 앱은 서명이 달라 덮어 설치가 안 된다 — 이 안내가 빠지면 업데이트가 "설치 실패"로 끝난다
    expect(html).toContain("웹사이트에서 받은 앱이라면 먼저 삭제한 뒤 Play 스토어에서 설치해 주세요.");
    expect(html).toContain("⬆️ Play 스토어에서 업데이트");
    expect(html).toContain("현재 버전: v1.0.3");
    expect(html).not.toContain("maeum-app.apk");
  });

  /**
   * Play 정책(2026-10-08 10차) — 앱 안(inApp)에서는 웹 APK 링크도 "최신 v1.0.3" 줄도 그리지 않는다. 스위치가 꺼져 있으면(1.2.0 프로덕션 단계적 출시가 100%가 되기 전)
   *   앱 안에서는 아무것도 없다 — 예전엔 Play로 받은 1.2.0 안에서도 "📱 안드로이드 앱 다운로드 (v1.0.3)"과 "최신 v1.0.3"이 떴다.
   */
  it.each([
    ["1.2.0(Play 앱) · 업데이트 불필요", { updateNeeded: false, appVersion: "1.2.0" }],
    ["1.0.3 · 업데이트 불필요", { updateNeeded: false, appVersion: "1.0.3" }],
    ["버전 모름(구버전) · 업데이트 필요", { updateNeeded: true, appVersion: null }],
  ])("꺼짐 + 앱 안 %s: 아무것도 그리지 않는다 — APK 링크·'최신 v1.0.3'·업데이트 안내 없음", async (_, props) => {
    const html = await renderDownload(undefined, { ...props, inApp: true });
    // 🔒 Play 앱 안에 Play 밖 APK 다운로드·자체 업데이트 안내가 보이면 Play 정책(기기 및 네트워크 악용) 위반이다
    expect(html).not.toContain("maeum-app.apk");
    expect(html).not.toContain("최신 v1.0.3");
    expect(html).not.toContain("새 버전");
    expect(html).toBe("");
  });

  it("켜짐 + 앱 안(1.2.0, 업데이트 불필요): Play 링크만 — 현재 버전 ✓·'최신 v1.2.0', APK 없음", async () => {
    const html = await renderDownload("1", { updateNeeded: false, appVersion: "1.2.0", inApp: true });
    expect(anchorTo(html, PLAY)).toBeDefined();
    expect(html).toContain("📱 Play 스토어에서 앱 받기");
    expect(html).not.toContain("새 버전");
    expect(html).not.toContain("먼저 삭제");
    expect(html).toContain('현재 버전 v1.2.0<span class="text-emerald-500"> ✓</span>');
    expect(html).toContain("최신 v1.2.0");
    expect(html).not.toContain("maeum-app.apk");
  });

  it("꺼짐 + 브라우저: 지금 그대로 — 웹 APK(download, 같은 창), '테스트용 · 안드로이드 전용(.apk)' · '최신 v1.0.3', 현재 버전 줄 없음", async () => {
    const html = await renderDownload(undefined, { updateNeeded: false, appVersion: null, inApp: false });
    const a = anchorTo(html, "/maeum-app.apk");
    expect(a).toBeDefined();
    expect(a).toContain('download="마음이음.apk"');
    expect(a).not.toContain("target=");
    expect(html).toContain("📱 안드로이드 앱 다운로드 (v1.0.3)");
    expect(html).toContain("테스트용 · 안드로이드 전용(.apk)");
    expect(html).toContain("최신 v1.0.3");
    expect(html).not.toContain("현재 버전");
    // 🔒 1.2.0을 모두가 받을 수 있기 전(단계적 출시 100% 전)에 Play로 보내면 받을 수 없는 앱 때문에 쓰던 앱을 지운다
    expect(html).not.toContain("play.google.com");
  });

  it("켜짐 + 브라우저: Play 스토어 — PLAY_STORE_URL을 새 창(target=_blank)으로, download·APK 없음", async () => {
    const html = await renderDownload("1", { updateNeeded: false, appVersion: null, inApp: false });
    const a = anchorTo(html, PLAY);
    expect(a).toBeDefined();
    // 🔒 같은 창 링크면 Play 웹페이지가 앱 웹뷰 안에 떠 설치·업데이트를 못 한다(새 창이어야 시스템이 Play 앱을 연다)
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(a).not.toContain("download");
    expect(html).toContain("📱 Play 스토어에서 앱 받기");
    expect(html).toContain("Google Play · 안드로이드");
    expect(html).toContain("최신 v1.2.0");
    expect(html).not.toContain("maeum-app.apk");
  });

  it("로그인 화면은 이 컴포넌트로 그린다 — 화면에 받기 분기를 다시 두지 않고, 앱인지 안 뒤에만 그린다", () => {
    const src = readFileSync("app/login/page.tsx", "utf-8");
    expect(src).toMatch(/<AppDownload updateNeeded=\{updateNeeded\} appVersion=\{appVersion\} inApp=\{inApp\} \/>/);
    // 🔒 앱인지 모를 때(서버 렌더) 그리면 앱 웹뷰에 하이드레이션 전까지 APK 링크가 보인다(10차)
    expect(src).toMatch(/\{inApp !== null && <AppDownload /);
    expect(src).toMatch(/useState<boolean \| null>\(null\)/);
    // 🔒 화면에 분기를 다시 박으면 위 렌더 테스트가 그 분기를 보지 못한다
    expect(src).not.toContain("maeum-app.apk");
    expect(src).not.toContain("PLAY_STORE_URL");
  });
});

describe("배포 점검에 스위치가 보인다", () => {
  it("scripts/check-env.ts — 빌드 타임 변수이자 실효값 목록에 있다", () => {
    const src = readFileSync("scripts/check-env.ts", "utf-8");
    // 🔒 빌드 타임 목록에 없으면 'env는 넣었는데 재배포를 안 해서 꺼져 있음'이 점검에 안 보인다
    expect(src).toMatch(/const BUILD_TIME_VARS = \[[^\]]*"NEXT_PUBLIC_APP_ON_PLAY"[^\]]*\]/);
    expect(src).toContain('{ label: "Play 배포 안내", name: "NEXT_PUBLIC_APP_ON_PLAY", fallback: "off(웹 APK 1.0.3 안내)"');
    // 🔒 (2026-10-08) 켜는 때 — "공개 후"면 단계적 출시 중(일부 사용자만 1.2.0)에 켜, 나머지에게 받을 수 없는 업데이트를 안내한다
    expect(src).toContain('note: "⚠ 빌드 타임 — 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤 1로 켜고 재배포"');
    expect(src).not.toMatch(/1\.2\.0 공개 후/);
  });
  // .env.example은 고정하지 않는다 — 2026-10-08 .gitignore에서 풀었지만(!.env.example) 커밋되기 전엔 CI의 새 체크아웃에 파일이 없다
});
