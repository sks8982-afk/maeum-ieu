/**
 * 사업자 정보 하단(서버 컴포넌트) — 첫 화면(/ 로그아웃 랜딩)·/login·/pricing·/subscribe·/terms/*·/privacy(2026-10-22).
 *
 * 무엇을: 상호·대표·사업자등록번호[사업자정보확인]·통신판매업 신고번호(신고기관)·주소·고객센터 전화·이메일·호스팅 제공자
 *   + 약관·처리방침·환불정책 링크(research D 1 문구 예시). 값은 lib/biz-info(BIZ_* 서버 env) — 없는 칸은 숨긴다.
 * 웹 결제 링크는 **웹 브라우저일 때만**(WebOnly) — 앱 안에서는 웹 결제로 이끄는 링크를 보이지 않는다(Play 결제 정책).
 *   유료서비스 이용약관·환불정책은 판매가 꺼져도 포트원 설정이 있으면 남긴다 — 가입한 결제회원이 계약 내용을 찾을 길이 있어야 한다
 *   (2026-10-22 검토 — 약관 화면도 같은 조건으로 열린다). 요금 안내는 판매 중에만(꺼지면 404인 화면이다).
 *   사업자 정보 자체는 결제 문구가 아니라 앱 안에서도 그대로 보인다.
 * 경고: 빠진 값·형식 문제는 개발 모드 화면에 한 줄로, 서버 로그에는 PG가 켜졌을 때(심사·법정 표시가 걸릴 때)와 개발 모드에서
 *   문제 목록이 바뀔 때만 한 번 남긴다 — 값은 찍지 않는다(이름만).
 */
import Link from "next/link";
import { hasBizInfo, readBizInfo, type BizInfo } from "@/lib/biz-info";
import { isPgEnabled, portoneConfigured } from "@/lib/billing/portone-plans";
import { WebOnly } from "@/app/components/WebOnly";

const linkClass = "underline-offset-2 hover:underline";

/** 같은 문제 목록을 요청마다 다시 찍지 않는다 */
let lastWarned = "";

function warnOnce(problems: string[]): void {
  const key = problems.join("|");
  if (key === lastWarned) return;
  lastWarned = key;
  console.warn(`[biz-info] 사업자 정보 하단 — ${problems.join(", ")}`);
}

/** 한 줄 — 값이 있는 칸만 " | "로 잇는다(모두 없으면 줄을 그리지 않는다) */
function Line({ parts }: { parts: (React.ReactNode | null)[] }) {
  const shown = parts.filter((p) => p !== null);
  if (shown.length === 0) return null;
  return (
    <p>
      {shown.map((p, i) => (
        <span key={i}>{i > 0 && <span aria-hidden="true"> | </span>}{p}</span>
      ))}
    </p>
  );
}

function BizLines({ info }: { info: BizInfo }) {
  const mailOrder = info.mailOrderNo
    ? `통신판매업 신고 ${info.mailOrderNo}${info.mailOrderAuthority ? `(신고기관: ${info.mailOrderAuthority})` : ""}`
    : null;
  return (
    <div className="space-y-0.5">
      <Line parts={[
        info.name && `상호 ${info.name}`,
        info.owner && `대표 ${info.owner}`,
        info.regNo && (
          <>사업자등록번호 {info.regNo}{info.ftcUrl && (
            <> <a href={info.ftcUrl} target="_blank" rel="noopener noreferrer" className={`font-semibold ${linkClass}`}>[사업자정보확인]</a></>
          )}</>
        ),
      ]} />
      <Line parts={[mailOrder, info.address && `주소 ${info.address}`]} />
      <Line parts={[
        info.phone && <>고객센터 <a href={`tel:${info.phone}`} className={linkClass}>{info.phone}</a></>,
        info.email && <a href={`mailto:${info.email}`} className={linkClass}>{info.email}</a>,
        `호스팅 제공: ${info.hosting}`,
      ]} />
    </div>
  );
}

export function BizInfoFooter() {
  const { info, problems } = readBizInfo();
  const pg = isPgEnabled();
  const termsOpen = pg || portoneConfigured();
  const dev = process.env.NODE_ENV !== "production";
  if (problems.length > 0 && (pg || dev)) warnOnce(problems);
  return (
    <footer className="mx-auto w-full max-w-2xl px-5 pb-8 pt-6 text-center text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
      {hasBizInfo(info) && <BizLines info={info} />}
      <nav aria-label="약관과 정책" className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 font-medium">
        {termsOpen && (
          <WebOnly>
            <Link href="/terms/paid" className={linkClass}>유료서비스 이용약관</Link>
            <Link href="/terms/refund" className={linkClass}>환불·청약철회 정책</Link>
            {pg && <Link href="/pricing" className={linkClass}>요금 안내</Link>}
          </WebOnly>
        )}
        <Link href="/privacy" className={linkClass}>개인정보처리방침</Link>
      </nav>
      {dev && problems.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          개발 모드 경고 — 사업자 정보 하단: {problems.join(", ")}
        </p>
      )}
    </footer>
  );
}
