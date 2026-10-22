/**
 * 사업자 정보 — 모든 화면 하단(첫 화면·요금제·결제·약관·처리방침)에 보이는 값(2026-10-22, 웹 PG 정기결제 준비).
 *
 * 근거(research D 1): 상호·대표자·영업소 주소·전화·이메일·사업자등록번호·이용약관(전자상거래법 제10조①), 통신판매업 신고번호와
 *   신고기관(제13조①3호), 호스팅 제공자(시행령 제11조의4), 첫 화면의 공정위 사업자정보 공개 링크(시행규칙 제7조②).
 *   PG 심사도 같은 것을 본다 — 사업자등록증과 내용이 같아야 하고, 전화는 휴대폰 번호를 쓸 수 없다(카카오페이는 유선만).
 *
 * 값은 **서버 런타임 env(BIZ_*)** 에서 읽는다 — 코드에 박지 않는다(설계 0). NEXT_PUBLIC_로 만들지 않는 이유는
 *   lib/billing/portone-plans와 같다(빌드에 박히면 재빌드 없이 못 바꾼다). 그래서 이 값을 쓰는 화면은 서버에서 그린다(BizInfoFooter).
 * 값이 없으면 그 칸을 숨긴다 — "(설정 필요)" 같은 자리 표시를 사이트에 내보내지 않는다(설계 6). 빠진 이름은 problems로 돌려주고
 *   화면(개발 모드)·서버 로그가 경고한다. 값 자체는 로그에 찍지 않는다(이름만).
 */

/** 화면에 보이는 사업자 정보 — 값이 없으면 null(그 칸을 숨긴다) */
export interface BizInfo {
  /** 상호 */
  name: string | null;
  /** 대표자 성명 */
  owner: string | null;
  /** 영업소 주소(불만 처리 장소 포함) */
  address: string | null;
  /** 고객센터 전화 — 유선 번호 */
  phone: string | null;
  email: string | null;
  /** 사업자등록번호(적힌 그대로 — 예: 000-00-00000) */
  regNo: string | null;
  /** 통신판매업 신고번호 */
  mailOrderNo: string | null;
  /** 통신판매업 신고기관(예: ○○시) */
  mailOrderAuthority: string | null;
  /** 호스팅 제공자 상호 */
  hosting: string;
  /** 공정위 사업자정보 공개 페이지 — 사업자등록번호가 10자리일 때만 */
  ftcUrl: string | null;
}

/** 읽는 env와 화면 칸 — 순서가 화면·경고 순서다 */
const FIELDS = [
  ["name", "BIZ_NAME"],
  ["owner", "BIZ_OWNER"],
  ["address", "BIZ_ADDRESS"],
  ["phone", "BIZ_PHONE"],
  ["email", "BIZ_EMAIL"],
  ["regNo", "BIZ_REG_NO"],
  ["mailOrderNo", "BIZ_MAIL_ORDER_NO"],
  ["mailOrderAuthority", "BIZ_MAIL_ORDER_AUTHORITY"],
] as const;

/**
 * 호스팅 제공자 기본값 — 지금 운영은 Vercel이다(개인정보처리방침 5항과 같은 말).
 *   ⚠ AWS(ECS)로 옮기면 BIZ_HOSTING을 "Amazon Web Services, Inc." 등으로 넣고 처리방침도 함께 고친다(research D 1).
 */
export const DEFAULT_HOSTING = "Vercel Inc.";

/** 공정위 사업자정보 공개 페이지(통신판매사업자 조회) — 사업자등록번호 10자리를 붙인다(2026-10-22 형식 확인, research D 11) */
export const FTC_BIZ_URL = "https://www.ftc.go.kr/bizCommPop.do?wrkr_no=";

/** 휴대폰 번호 꼴(010·011·016·017·018·019) — PG 심사가 받지 않는다 */
const MOBILE_RE = /^01[016789]/;

type Env = Readonly<Record<string, string | undefined>>;

/** 환경 변수 → 화면 값과 문제 목록(빠진 이름·형식 경고). 순수 함수 — 시험은 env 객체를 넘긴다 */
export function readBizInfo(env: Env = process.env): { info: BizInfo; problems: string[] } {
  const value = (key: string) => env[key]?.trim() || null;
  const problems: string[] = FIELDS.filter(([, key]) => value(key) === null).map(([, key]) => `${key} 없음`);
  const regDigits = value("BIZ_REG_NO")?.replace(/\D/g, "") ?? "";
  const ftcUrl = regDigits.length === 10 ? `${FTC_BIZ_URL}${regDigits}` : null;
  if (regDigits && !ftcUrl) problems.push("BIZ_REG_NO는 숫자 10자리여야 공정위 사업자정보 확인 링크를 붙인다");
  const phoneDigits = value("BIZ_PHONE")?.replace(/\D/g, "") ?? "";
  if (MOBILE_RE.test(phoneDigits)) problems.push("BIZ_PHONE이 휴대폰 번호 — PG 심사는 유선 대표번호를 요구한다");
  const info = {
    ...Object.fromEntries(FIELDS.map(([field, key]) => [field, value(key)])),
    hosting: value("BIZ_HOSTING") ?? DEFAULT_HOSTING,
    ftcUrl,
  } as BizInfo;
  return { info, problems };
}

/** 비어 있는 사업자 정보 env 이름 — 웹 결제를 켜려면 모두 있어야 한다(lib/billing/portone-plans pgConfigProblems — 결제 화면 고지·하단 표시) */
export function missingBizFields(env: Env = process.env): string[] {
  return FIELDS.filter(([, key]) => !env[key]?.trim()).map(([, key]) => key);
}

/** 하단에 사업자 정보 칸을 그릴 게 있나 — 하나도 없으면 호스팅 줄만 남기지 않고 통째로 숨긴다 */
export function hasBizInfo(info: BizInfo): boolean {
  return FIELDS.some(([field]) => info[field] !== null);
}
