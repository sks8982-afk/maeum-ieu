/**
 * 약관·정책 문서의 공통 틀(/terms/paid · /terms/refund) — 개인정보처리방침(/privacy)과 같은 모양(제목·시행일·조항·사업자 정보 하단).
 *   훅 없는 서버 컴포넌트 — 문서는 로그인 없이 열린다(middleware matcher에 /terms가 없다 — __tests__/billing-pg-screens.test.ts).
 */
import Link from "next/link";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";
import { PG_TERMS_EFFECTIVE } from "@/lib/billing/pg-terms";
import { PG_TERMS_VERSION } from "@/lib/billing/portone-consent";

export function TermsShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      <div className="mx-auto max-w-2xl px-5 py-8">
        <Link href="/" className="text-sm text-[#007bff] hover:underline">← 홈</Link>
        <h1 className="mt-3 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-1 text-sm text-zinc-500">마음이음 · 시행 {PG_TERMS_EFFECTIVE} · 문안 버전 {PG_TERMS_VERSION}</p>
        {children}
      </div>
      <BizInfoFooter />
    </div>
  );
}

/** 조항 하나 — id는 다른 화면의 '보기' 링크가 가리키는 곳(예: /terms/paid#auto-renew) */
export function Article({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-4">
      <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <div className="space-y-2 text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

/** 번호 붙은 항(①②…) 목록 */
export function Clauses({ items }: { items: React.ReactNode[] }) {
  const marks = "①②③④⑤⑥⑦⑧⑨⑩";
  return (
    <ol className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-1.5"><span aria-hidden="true">{marks[i]}</span><span>{item}</span></li>
      ))}
    </ol>
  );
}
