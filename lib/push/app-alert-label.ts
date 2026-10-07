/**
 * 어르신 마이페이지 연결 목록의 "그분 휴대폰 앱 알림" 표시(2026-10-07) — app/mypage/page.tsx.
 *
 * 왜 0대를 스위치로 가리나: 스위치를 켜기 전(1.2.0 프로덕션 단계적 출시가 100%가 되기 전)엔 등록 휴대폰 0대가 **정상**이다 — 현장 앱 1.0.3은 휴대폰 등록을
 *   모르고 토픽으로 받는다. 그때 "미등록"이라 적으면 알림을 잘 받고 있는 보호자를 못 받는 사람으로 보이게 한다.
 *   그래서 0대 경고는 PUSH_TOKENS_LIVE(lib/app-version — NEXT_PUBLIC_APP_ON_PLAY)일 때만. 꺼짐 보고는 1.2.0 휴대폰이 직접
 *   보낸 사실이라 언제나 보인다.
 * 왜 상태 셋뿐인가(2026-10-07 4차): 이건 **보호자·의사의 휴대폰 정보**다. 어르신 화면에는 "알림을 받을 수 있나"만 있으면
 *   된다 — 휴대폰 대수는 싣지 않는다(서버도 상태만 보낸다, app/api/users/linked-experts — 개인정보처리방침 9항).
 */
import { PUSH_TOKENS_LIVE } from "@/lib/app-version";

/** 연결한 분의 앱 알림 상태 — 알림 허용 휴대폰 있음 / 등록 휴대폰은 있는데 모두 꺼짐 / 등록 휴대폰 없음 */
export type AppAlertState = "ready" | "off" | "none";

export interface AppAlertLabel {
  text: string;
  /** 경고(주황)인가 — 하나라도 있으면 목록 아래에 해결 안내를 붙인다 */
  warn: boolean;
}

/** @returns 표시할 문구, 아무것도 표시하지 않으면 null */
export function appAlertLabel(state: AppAlertState): AppAlertLabel | null {
  if (state === "ready") return { text: "앱 알림 ✅", warn: false };
  if (state === "off") return { text: "⚠ 앱 알림 꺼짐", warn: true };
  return PUSH_TOKENS_LIVE ? { text: "⚠ 앱 알림 미등록", warn: true } : null;
}
