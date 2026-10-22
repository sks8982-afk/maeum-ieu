/**
 * 결제 화면의 입력 칸(요금제·혜택 받는 분·결제수단·카드 구매자 정보·필수 동의) — 상태는 PgCheckout이 갖고 여기는 그리기만 한다.
 *
 * 법정·심사 조건(research D 2·3): 요금제는 **미리 골라 두지 않는다**(제21조의2①2호) · 필수 동의는 항목마다 **따로**, 기본 **미체크**
 *   (시행령 제9조) · 각 항목에 '보기'(새 창 — 고르던 내용이 사라지지 않게). 혜택 받는 분은 이름을 보고 직접 고른다(설계 13).
 * 접근성: 라디오·체크박스는 큰 누름 영역(label 전체) · 글자 대비는 기존 구독 화면과 같다.
 */
import Link from "next/link";
import { consentLabel, kstDateLabel, krw } from "@/lib/billing/pg-terms";
import type { ConsentKey } from "@/lib/billing/portone-consent";
import type { PayMethod, PgConfig, PgPlan } from "./pg-client";

const optionClass = (checked: boolean, disabled = false) =>
  `flex cursor-pointer items-center gap-3 rounded-2xl border-2 px-4 py-3 transition ${disabled ? "cursor-not-allowed opacity-60" : ""} ${
    checked ? "border-teal-600 bg-teal-50 dark:border-teal-500 dark:bg-teal-900/20" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"}`;
const legendClass = "mb-2 text-lg font-bold text-zinc-800 dark:text-zinc-100";
const inputClass = "w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

export function PlanPicker({ plans, value, onChange }: { plans: PgPlan[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <fieldset>
      <legend className={legendClass}>1. 요금제</legend>
      <div className="space-y-2">
        {plans.map((p) => (
          <label key={p.id} className={optionClass(value === p.id)}>
            <input type="radio" name="plan" value={p.id} checked={value === p.id} onChange={() => onChange(p.id)} className="h-5 w-5 accent-teal-600" />
            <span className="flex-1">
              <span className="block text-base font-bold text-zinc-900 dark:text-zinc-100">{p.name}</span>
              <span className="block text-sm text-zinc-600 dark:text-zinc-300">하루 대화 {p.dailyTurnLimit}회</span>
            </span>
            <span className="text-right text-base font-extrabold text-zinc-900 dark:text-zinc-100">
              월 {krw(p.priceKrw)}<span className="block text-xs font-medium text-zinc-500">부가세 포함</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** 보호자인데 연결된 어르신이 없다 — 연결부터(도움말의 연결 안내와 같은 말) */
export function LinkFirstNotice() {
  return (
    <p className="text-base text-zinc-700 dark:text-zinc-200">
      먼저 어르신 계정과 연결해 주세요. <Link href="/expert" className="font-semibold text-teal-700 underline dark:text-teal-300">가족 상태</Link> 화면의
      &lsquo;내 초대 코드&rsquo;를 어르신께 알려 드리면 돼요.
    </p>
  );
}

/**
 * 혜택 받는 분 — 연결된 어르신 중 고른다(이미 이용권이 있으면 고를 수 없다). 결제는 보호자만 한다(일반 회원은 하루 대화 한도가 없다).
 *   이름 옆에 연결한 날을 보인다 — 보호자 코드를 아는 사람이 같은 이름으로 새로 연결해도 구별할 수 있게(2026-10-22 검토).
 */
export function BeneficiaryPicker({ config, value, onChange }: {
  config: PgConfig; value: string | null; onChange: (userId: string) => void;
}) {
  return (
    <fieldset>
      <legend className={legendClass}>2. 혜택 받는 분</legend>
      {config.beneficiaries.length === 0 ? <LinkFirstNotice /> : (
        <div className="space-y-2">
          {config.beneficiaries.map((b) => (
            <label key={b.userId} className={optionClass(value === b.userId, b.covered)}>
              <input
                type="radio" name="beneficiary" value={b.userId} checked={value === b.userId} disabled={b.covered}
                onChange={() => onChange(b.userId)} className="h-5 w-5 accent-teal-600"
              />
              <span className="flex-1">
                <span className="block text-base font-semibold text-zinc-900 dark:text-zinc-100">{b.name}님</span>
                <span className="block text-sm text-zinc-600 dark:text-zinc-300">{kstDateLabel(new Date(b.linkedAt))} 연결</span>
              </span>
              {b.covered && <span className="text-sm text-zinc-500">이미 이용권이 있어요</span>}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function MethodPicker({ methods, value, onChange }: {
  methods: PgConfig["payMethods"]; value: PayMethod | null; onChange: (m: PayMethod) => void;
}) {
  return (
    <fieldset>
      <legend className={legendClass}>3. 결제수단</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {methods.map((m) => (
          <label key={m.method} className={optionClass(value === m.method)}>
            <input type="radio" name="method" value={m.method} checked={value === m.method} onChange={() => onChange(m.method)} className="h-5 w-5 accent-teal-600" />
            <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface BuyerDraft { fullName: string; phone: string; email: string }

/** 카드 결제창이 요구하는 구매자 정보 — 결제창으로만 넘어가고 서비스는 저장하지 않는다 */
export function BuyerFields({ value, onChange }: { value: BuyerDraft; onChange: (v: BuyerDraft) => void }) {
  const field = (key: keyof BuyerDraft, label: string, type: string, autoComplete: string) => (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
      <input
        type={type} autoComplete={autoComplete} value={value[key]} className={inputClass}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <fieldset className="space-y-2">
      <legend className={legendClass}>카드 결제 정보</legend>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">카드 결제창이 요구하는 정보예요. 결제창으로만 넘어가고 마음이음은 저장하지 않아요.</p>
      {field("fullName", "이름", "text", "name")}
      {field("phone", "휴대전화 번호", "tel", "tel")}
      {field("email", "이메일", "email", "email")}
    </fieldset>
  );
}

/** 필수 동의 — 항목마다 따로, 기본 미체크, 각 '보기'(새 창) */
export function ConsentList({ items, value, onChange, priceKrw, chargeDay }: {
  items: readonly ConsentKey[]; value: Readonly<Record<ConsentKey, boolean>>;
  onChange: (key: ConsentKey, checked: boolean) => void; priceKrw: number; chargeDay: number;
}) {
  return (
    <fieldset>
      <legend className={legendClass}>필수 동의</legend>
      <ul className="space-y-2">
        {items.map((key) => {
          const { text, href } = consentLabel(key, { priceKrw, chargeDay });
          return (
            <li key={key} className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 dark:bg-zinc-900">
              <input
                id={`consent-${key}`} type="checkbox" checked={value[key]} onChange={(e) => onChange(key, e.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-teal-600"
              />
              <label htmlFor={`consent-${key}`} className="flex-1 cursor-pointer text-[15px] text-zinc-800 dark:text-zinc-100">{text}</label>
              <Link href={href} target="_blank" className="shrink-0 text-sm font-semibold text-teal-700 underline dark:text-teal-300">보기</Link>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
