/**
 * 휴대폰 폭 머리글(2026-10-30 앱 에뮬레이터에서 발견) — 보호자·전문가·마음 건강 화면 머리글은 제목과 메뉴 4~5개가 한 줄에
 *   들어가지 않으면 **낱말 안에서** 글자가 꺾였다("가족 상\태", "사용 안\내", "로그아\웃"). 보호자는 이 화면을 휴대폰 앱으로 본다.
 *   낱말은 꺾지 않고(whitespace-nowrap), 자리가 모자라면 메뉴 묶음이 통째로 다음 줄로 간다(flex-wrap).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe.each(["app/expert/page.tsx", "app/expert/patients/[id]/page.tsx", "app/mental/page.tsx"])("%s 머리글", (file) => {
  const src = readFileSync(file, "utf-8");

  it("낱말을 꺾지 않고, 모자라면 묶음째 다음 줄로", () => {
    expect(src).toMatch(/className="mx-auto flex max-w-(?:4xl|3xl) items-center justify-between flex-wrap gap-x-3 gap-y-2 whitespace-nowrap"/);
    expect(src).toContain('<div className="flex flex-wrap items-center gap-x-3 gap-y-1">');
  });
});
