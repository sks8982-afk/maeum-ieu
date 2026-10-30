/**
 * 보호자·전문가 화면 — 연결된 사람이 없을 때 문구의 조사(2026-10-30 AWS 검증에서 발견).
 *   "어르신"/"환자" 뒤에 같은 "이"를 붙여, 전문가 화면에 "아직 연결된 환자이 없습니다"가 떴다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("연결된 사람이 없을 때 문구", () => {
  const src = readFileSync("app/expert/page.tsx", "utf-8");

  it("받침에 맞는 조사 — 어르신이 / 환자가", () => {
    expect(src).toContain('아직 연결된 {viewerRole === "guardian" ? "어르신이" : "환자가"} 없습니다.');
    // 🔒 예전 문구 — 두 낱말에 같은 조사를 붙이면 한쪽이 틀린다
    expect(src).not.toMatch(/"환자"\}이 없습니다/);
  });
});
