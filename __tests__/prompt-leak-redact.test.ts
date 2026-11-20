/**
 * 야간 누출 검사 — 공개 저장소의 Actions 로그 가리기 + 실패 알림 구분(2026-11-20).
 *
 * 계기: 11-20 야간 검사가 "Prompt-leak detected!" 메일을 보냈는데, 실제로는 `npm ci`에서 onnxruntime-node가
 *   GPU 파일(api.nuget.org)을 받다 연결 시간 초과로 실패해 검사는 돌지도 않았다(다시 돌리니 clean).
 *   실패 알림 단계가 어느 단계가 실패하든 같은 문구를 찍었다. 검사를 주 저장소(공개)로 옮기면서 로그에 찍히는
 *   실제 사용자 값과 DB 서버 주소도 가린다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inCi, maskValue, maskIn, scrubHosts } from "../scripts/prompt-leak-redact";

describe("값 가리기", () => {
  it("첫 글자만 남긴다 — 한 글자는 통째로", () => {
    expect(maskValue("영수")).toBe("영○");
    expect(maskValue("김복순")).toBe("김○○");
    expect(maskValue("가")).toBe("○");
  });

  it("코드 줄 속의 그 값을 모두 가린다", () => {
    expect(maskIn("큰아들 영수가 왔어, 영수야", "영수")).toBe("큰아들 영○가 왔어, 영○야");
    expect(maskIn("그대로", "")).toBe("그대로");
  });

  it("오류 메시지 속 서버 주소·접속 문자열을 가린다", () => {
    expect(scrubHosts("connect ETIMEDOUT 203.0.113.10:5432")).toBe("connect ETIMEDOUT [주소 가림]");
    expect(scrubHosts("bad url postgresql://u:p@db.example.com:5432/maeum?x=1 here")).toBe("bad url [접속 문자열 가림] here");
    expect(scrubHosts("self signed certificate")).toBe("self signed certificate");
  });

  it("GitHub Actions에서만 가린다(로컬은 고치려면 값을 봐야 한다)", () => {
    expect(inCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(inCi({})).toBe(false);
    expect(inCi({ GITHUB_ACTIONS: "false" })).toBe(false);
  });
});

describe("검사 스크립트가 가리기·종료 코드를 쓴다", () => {
  const src = readFileSync("scripts/check-prompt-leak.ts", "utf-8");

  it("누출 목록은 CI에서 값과 코드 줄을 가려 찍는다", () => {
    expect(src).toMatch(/const value = ci \? maskValue\(v\.value\) : v\.value;/);
    expect(src).toMatch(/const snippet = ci \? maskIn\(v\.snippet, v\.value\) : v\.snippet;/);
  });

  it("실행 오류(DB 연결 등)는 3으로 끝난다 — 누출(1)과 구분, CI에선 주소를 가린다", () => {
    expect(src).toMatch(/inCi\(\) \? scrubHosts\(msg\) : msg/);
    expect(src).toMatch(/process\.exit\(3\);\s*\}\);\s*$/);
  });
});

describe("야간 작업 — 실패 알림을 원인별로 나눈다", () => {
  const yml = readFileSync(".github/workflows/prompt-leak-full.yml", "utf-8");

  it("설치에서 onnxruntime-node의 GPU 파일을 받지 않는다(외부 서버 장애로 검사 전에 실패했다)", () => {
    expect(yml).toMatch(/- run: npm ci\s+if: \$\{\{ env\.DB_URL != '' \}\}\s+env:\s+ONNXRUNTIME_NODE_INSTALL: skip/);
  });

  it("검사 단계의 종료 코드를 남기고, 알림은 누출(1)·검사 오류·설치 실패를 나눠 찍는다", () => {
    expect(yml).toContain("id: leak");
    expect(yml).toContain('echo "code=$code" >> "$GITHUB_OUTPUT"');
    expect(yml).toContain("steps.leak.outputs.code");
    // 🔒 예전 문구 — 어느 단계가 실패하든 이 한 줄이었다
    expect(yml).not.toMatch(/run: \|\s+echo "::error::Prompt-leak detected!/);
  });
});
