import { connection } from "next/server";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";

/**
 * 개인정보처리방침(/privacy)의 틀 — 화면 아래에 사업자 정보(2026-10-22, research D 1). 본문(page)은 그대로 두고 여기서 붙인다
 *   (본문은 훅·비동기 없는 컴포넌트라 시험이 react-dom/server로 그대로 그린다 — __tests__/sensitive-consent-cards·account-deletion-page).
 *   connection(): 사업자 정보는 런타임 env라 요청마다 그린다(빌드 때 굳히지 않게 — app/login/layout과 같은 이유).
 */
export default async function PrivacyLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <div className="bg-white dark:bg-zinc-950">
      {children}
      <BizInfoFooter />
    </div>
  );
}
