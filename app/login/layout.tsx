import { connection } from "next/server";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";

/**
 * 로그인 화면(/login)의 틀 — 화면 아래에 사업자 정보(2026-10-22, 전자상거래법 제10조① · 시행규칙 제7조② 첫 화면 공정위 링크 — research D 1).
 *   로그인 화면은 클라이언트 컴포넌트라 서버 env(BIZ_*)를 읽는 하단을 직접 넣을 수 없어 이 레이아웃에서 붙인다.
 *   connection(): 사업자 정보는 런타임 env다 — 빌드 때 한 번 그려 굳히면(정적 렌더) env를 바꿔도 화면이 그대로다.
 *   배경은 로그인 화면과 같은 색 — 하단이 다른 색 띠로 떨어져 보이지 않게.
 */
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <div className="bg-[#f0f2f5] dark:bg-[#0b0d10]">
      {children}
      <BizInfoFooter />
    </div>
  );
}
