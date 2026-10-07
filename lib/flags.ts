/**
 * 켜고 끄는 스위치(env) 판정 — **정확히 "1"만 켠다**(2026-10-07 4차).
 *
 * 왜 한 곳에 두나: 코드(lib/app-version의 Play 배포 스위치·Live 베타)와 배포 점검(scripts/check-env.ts)이 각자 값을 보면
 *   둘이 갈린다. 예전 점검은 값을 그대로(앞뒤 공백까지 지워서) 찍어, NEXT_PUBLIC_APP_ON_PLAY="true"나 " 1"이 켜진 것처럼
 *   보였는데 코드는 꺼짐으로 빌드했다 — "env는 넣었는데 스위치는 꺼져 있음"이 점검에 안 보였다.
 *   그래서 코드와 점검이 **같은 함수**로 켜짐/꺼짐을 정한다(__tests__/build-flags.test.ts).
 * ⚠ NEXT_PUBLIC_* 는 호출부에서 `flagOn(process.env.NEXT_PUBLIC_X)`처럼 **그 식 그대로** 넘긴다 — Next는 빌드 때 그 식을
 *   값으로 바꿔 넣는다(env를 다른 변수에 담아 읽으면 브라우저 번들에선 값이 없다).
 */
export function flagOn(v: string | undefined): boolean {
  return v === "1";
}

/**
 * 배포 점검(scripts/check-env.ts)이 찍는 스위치 상태 — 코드가 보는 켜짐/꺼짐(flagOn)과 실제 값.
 *   값이 있는데 정확히 "1"이 아니면(꺼짐으로 빌드된다) warning을 채운다. 빈 문자열은 미설정으로 본다 — Docker 빌드의
 *   ARG 기본값이 ""라, 그걸 경고하면 모든 이미지 빌드에서 경고가 떠 진짜 경고가 묻힌다.
 */
export function describeFlag(name: string, v: string | undefined): { state: string; warning: string | null } {
  const on = flagOn(v);
  const set = v !== undefined && v !== "";
  return {
    state: `${on ? "on" : "off"} (${set ? `값 ${JSON.stringify(v)}` : "미설정"})`,
    warning: set && !on ? `${name}=${JSON.stringify(v)} — 정확히 "1"만 켭니다. 지금 값으로는 off로 빌드됩니다.` : null,
  };
}
