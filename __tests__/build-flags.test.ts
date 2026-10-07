/**
 * 켜고 끄는 스위치(NEXT_PUBLIC_APP_ON_PLAY·NEXT_PUBLIC_SHOW_LIVE_BETA) — 코드와 배포 점검이 **같은 함수**로 본다(2026-10-07 4차).
 *
 * 결함: 배포 점검(scripts/check-env.ts)은 값을 그대로(앞뒤 공백까지 지워서) 찍었다. NEXT_PUBLIC_APP_ON_PLAY="true"나 " 1"을 넣으면
 *   점검엔 켜진 것처럼 보이는데 코드(=== "1")는 꺼짐으로 빌드했다 — "env는 넣었는데 Play 안내·기기 토큰 경고가 안 켜짐"이
 *   점검에 안 보였다. 이제 둘 다 lib/flags의 flagOn으로 정하고, 점검은 on/off와 "정확히 1이 아님" 경고를 찍는다.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeFlag, flagOn } from "@/lib/flags";

describe("flagOn — 정확히 '1'만 켠다", () => {
  it.each([
    ["1", true],
    ["0", false], ["true", false], [" 1", false], ["1 ", false], ["", false], ["yes", false], ["on", false], [undefined, false],
  ] as const)("%j → %s", (v, on) => {
    expect(flagOn(v)).toBe(on);
  });
});

describe("describeFlag — 배포 점검이 찍는 on/off와 경고", () => {
  it.each([
    [undefined, "off (미설정)", null],
    ["", "off (미설정)", null],   // Docker ARG 기본값 — 모든 이미지 빌드에서 경고가 나면 진짜 경고가 묻힌다
    ["1", 'on (값 "1")', null],
    ["true", 'off (값 "true")', 'X="true" — 정확히 "1"만 켭니다. 지금 값으로는 off로 빌드됩니다.'],
    [" 1", 'off (값 " 1")', 'X=" 1" — 정확히 "1"만 켭니다. 지금 값으로는 off로 빌드됩니다.'],
    ["0", 'off (값 "0")', 'X="0" — 정확히 "1"만 켭니다. 지금 값으로는 off로 빌드됩니다.'],
  ] as const)("%j → %s", (v, state, warning) => {
    // 🔒 값만 찍으면 "true"가 켜진 것처럼 보인다 — 코드와 같은 판정(flagOn)으로 on/off를 찍는다
    expect(describeFlag("X", v)).toEqual({ state, warning });
  });
});

describe("배포 점검(scripts/check-env.ts)이 실제로 찍는 것", () => {
  it("--build: 스위치마다 코드가 보는 on/off — 정확히 '1'이 아니면 경고, '1'이면 경고 없음", () => {
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-env.ts", "--build"], {
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_APP_ON_PLAY: "true", NEXT_PUBLIC_SHOW_LIVE_BETA: "1" },
    });
    expect(r.status).toBe(0);   // 빌드 모드는 런타임 시크릿으로 실패하지 않는다
    const out = r.stdout;
    expect(out).toContain('NEXT_PUBLIC_APP_ON_PLAY = off (값 "true")');
    expect(out).toContain('NEXT_PUBLIC_SHOW_LIVE_BETA = on (값 "1")');
    // 실효 설정값 표에도 같은 판정
    expect(out).toMatch(/Play 배포 안내\s+off \(값 "true"\)/);
    expect(out).toMatch(/Live 베타 노출\s+on \(값 "1"\)/);
    // 🔒 넣은 사람은 켰다고 믿는다 — 꺼짐으로 빌드된다고 알려야 한다
    expect(out).toContain('주의: NEXT_PUBLIC_APP_ON_PLAY="true" — 정확히 "1"만 켭니다. 지금 값으로는 off로 빌드됩니다.');
    expect(out).not.toContain("주의: NEXT_PUBLIC_SHOW_LIVE_BETA=");
  }, 60_000);
});

describe("코드도 같은 함수로 본다 — 스위치를 직접 비교하는 곳이 없다", () => {
  /** app·lib 아래 모든 .ts/.tsx(주석 제외) */
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name).replace(/\\/g, "/")] : []);
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("NEXT_PUBLIC_APP_ON_PLAY·NEXT_PUBLIC_SHOW_LIVE_BETA를 === / !== 로 직접 비교하지 않는다(flagOn을 거친다)", () => {
    const direct = [...sources("app"), ...sources("lib")]
      .filter((f) => /NEXT_PUBLIC_(APP_ON_PLAY|SHOW_LIVE_BETA)\s*[!=]==/.test(code(readFileSync(f, "utf-8"))));
    // 🔒 한 곳이라도 따로 비교하면 점검이 보여 주는 on/off와 실제 빌드가 다시 갈릴 수 있다
    expect(direct).toEqual([]);
  });

  it("앱 버전 스위치·Live 베타 판정·배포 점검이 lib/flags를 쓴다", () => {
    expect(readFileSync("lib/app-version.ts", "utf-8")).toMatch(/export const APP_ON_PLAY = flagOn\(process\.env\.NEXT_PUBLIC_APP_ON_PLAY\);/);
    expect(readFileSync("lib/feature-flags.ts", "utf-8")).toMatch(/return flagOn\(process\.env\.NEXT_PUBLIC_SHOW_LIVE_BETA\);/);
    expect(readFileSync("lib/chat/live-preference.ts", "utf-8")).toMatch(/if \(!flagOn\(betaFlag\)\) return false;/);
    expect(readFileSync("scripts/check-env.ts", "utf-8")).toMatch(/import \{ describeFlag \} from "\.\.\/lib\/flags";/);
  });
});
