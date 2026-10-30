/**
 * 로그인 화면의 앱 받기 — 업데이트 안내 + 받기 버튼 + 버전 줄(2026-10-07, app/login/page.tsx에서 분리).
 *
 * 왜 따로 두나: 업데이트 안내는 설치된 앱 버전을 읽은 뒤(페이지의 효과)에만 그려져, 페이지를 서버 렌더로 그려서는
 *   볼 수 없었다 — 문구를 소스에서 grep하는 수밖에 없었다. 상태를 받는 순수 컴포넌트로 빼서, 두 스위치 값
 *   (NEXT_PUBLIC_APP_ON_PLAY — lib/app-version)에서 그대로 그려 본다(__tests__/app-on-play.test.ts).
 *
 * 웹 APK 링크는 없앴다(2026-10-30 사용자: "Play 스토어에 배포했으니 로그인 화면의 안드로이드 앱 다운로드 링크는 없앤다").
 *   스위치가 꺼져 있으면(1.2.0 프로덕션 단계적 출시가 100%가 되기 전) 브라우저든 앱 안이든 아무것도 그리지 않는다.
 *   켜면 Play 링크와 업데이트 안내가 나온다. public/maeum-app.apk 파일은 예전에 공유한 직접 링크 때문에 남긴다.
 * Play 정책(2026-10-08 10차): 앱 안에서 Play 밖 앱 내려받기·자체 업데이트를 안내하면 안 된다(기기 및 네트워크 악용 정책) —
 *   그래서 처음부터 앱 안에는 Play 링크만 두었다.
 *   ⚠ 앱인지 모르는 서버 렌더에서는 이 컴포넌트를 그리지 않는다(app/login/page — 하이드레이션 전에 앱 웹뷰에 잘못된 링크가 보이지 않게).
 */
import { APP_ON_PLAY, LATEST_APP_VERSION, PLAY_STORE_URL } from "@/lib/app-version";

/** 앱 받기 버튼 모양 — 업데이트가 필요하면 눈에 띄게 */
const downloadClass = (updateNeeded: boolean) =>
  `mt-3 flex items-center justify-center gap-2 rounded-xl border py-4 text-base font-medium transition focus:outline-none focus:ring-2 ${updateNeeded ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-400" : "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 focus:ring-emerald-400 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40"}`;

export interface AppDownloadProps {
  /** 설치된 앱이 최신보다 낮다(버전을 모르는 구버전 앱 포함) — 업데이트 안내를 띄운다 */
  updateNeeded: boolean;
  /** RN 앱이 주입한 설치 버전(알 수 없으면 null) */
  appVersion: string | null;
  /** RN 앱(WebView) 안에서 열렸다 — 버전 줄에 현재 버전을 적는다 */
  inApp: boolean;
}

export function AppDownload({ updateNeeded, appVersion, inApp }: AppDownloadProps) {
  // 스위치가 꺼져 있으면 보여 줄 것이 없다 — 웹 APK 링크는 없앴다(위 주석)
  if (!APP_ON_PLAY) return null;
  return (
    <>
      {/* 업데이트 안내 — 설치된 앱이 최신보다 낮을 때 */}
      {updateNeeded && (
        <div className="mt-3 rounded-xl border border-amber-400 bg-amber-50 px-3 py-2.5 text-center text-sm text-amber-800 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-200">
          ⚠️ 새 버전 <b>v{LATEST_APP_VERSION}</b>이 Play 스토어에 나왔어요. 아래 버튼으로 업데이트해 주세요.
          {/* 웹 APK와 Play 앱은 서명 키가 달라 Play가 덮어 설치하지 못한다 — 먼저 지워야 설치된다 */}
          <span className="block text-xs text-amber-700 dark:text-amber-200/90">웹사이트에서 받은 앱이라면 먼저 삭제한 뒤 Play 스토어에서 설치해 주세요.</span>
          <span className="block text-xs text-amber-600 dark:text-amber-300/80">현재 버전: {appVersion ? `v${appVersion}` : "확인 불가(구버전)"}</span>
        </div>
      )}
      {/**
       * Play 스토어로 — **target="_blank"가 핵심이다**(2026-10-07 확인).
       *   앱(react-native-webview 13.17)은 onOpenWindow를 넘기지 않아, 새 창 요청(onCreateWindow)을 WebViewClient 없는
       *   새 WebView로 받는다(MaeumApp/node_modules/react-native-webview/android/.../RNCWebChromeClient.java).
       *   WebViewClient가 없으면 안드로이드가 주소를 시스템에 넘겨 **Play 스토어 앱**이 열린다. 같은 창 링크면 Play
       *   웹페이지가 우리 WebView 안에 떠 설치·업데이트가 안 된다. 일반 브라우저에선 새 탭으로 Play 페이지가 열린다.
       */}
      <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" className={downloadClass(updateNeeded)}>
        {updateNeeded ? "⬆️ Play 스토어에서 업데이트" : "📱 Play 스토어에서 앱 받기"}
      </a>
      <p className="mt-1 text-center text-xs text-zinc-400 dark:text-zinc-500">
        Google Play · 안드로이드<br />
        {inApp && (
          <>현재 버전 {appVersion ? `v${appVersion}` : "확인 불가"}{appVersion && !updateNeeded && <span className="text-emerald-500"> ✓</span>} · </>
        )}
        최신 v{LATEST_APP_VERSION}
      </p>
    </>
  );
}
