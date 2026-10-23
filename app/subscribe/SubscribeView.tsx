"use client";

/**
 * 구독 화면 본체 — 앱(WebView)과 웹 브라우저를 가른다(2026-10-22, 웹 PG 정기결제).
 *
 *   앱 안   : 구독 상태 + (BILLING_PLAY_ENABLED=1일 때만) Play 구매 버튼. **웹 결제(PG) 화면·문구·링크는 없다**(Play 결제 정책).
 *   브라우저: 구독 상태 + 웹 결제 — 보호자는 구독 관리와 이용권 신청, 어르신·일반 회원·의사 계정은 결제 대신 안내만(설계 13 —
 *             일반 회원은 하루 대화 한도가 없어 이용권 효과가 없다, 2026-10-22 검토).
 *             PG 판매가 꺼져 있어도(config 503) 이미 가입한 이용권의 관리·해지는 보인다(status.pg — 해지를 막으면 해지 방해다).
 * 앱인지 모르는 첫 그리기(서버 렌더)에서는 아무것도 고르지 않는다(useInApp null — 앱 웹뷰에 웹 결제 화면이 잠깐도 보이지 않게).
 * 서버도 앱 요청을 따로 거절한다(lib/billing/portone-route — 가입은 config 403, 우리 앱이 틀림없으면 status pg null·해지 403).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useInApp } from "@/app/components/WebOnly";
import { PgCheckout } from "./PgCheckout";
import { PgManage } from "./PgManage";
import { LinkFirstNotice } from "./CheckoutFields";
import { PLAY_MANAGE_TEXT, PlayBenefits, PlayPurchase, StatusCard } from "./PlayPanel";
import { hasPgRecords, pgOf, requestJson, toConfigState, type BillingStatus, type ConfigState, type PgConfig } from "./pg-client";

const note = "rounded-2xl border border-zinc-200 bg-white p-5 text-base text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200";

/** 구독 상태(/api/billing/status) — 401이면 로그인 안내 */
function useBillingStatus() {
  const [st, setSt] = useState<BillingStatus | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const r = await requestJson<BillingStatus>("/api/billing/status");
    if (r.ok) { setSt(r.data); return; }
    setErr(r.status === 401 ? "로그인이 필요합니다." : "상태를 불러오지 못했습니다.");
  }, []);
  useEffect(() => { (async () => { await load(); })(); }, [load]);
  return { st, err, setErr, load };
}

/** 웹 결제 설정 — 브라우저일 때만 부른다(앱이면 서버가 403으로 거절한다) */
function usePgConfig(enabled: boolean) {
  const [cfg, setCfg] = useState<ConfigState>({ kind: "loading" });
  const load = useCallback(async () => {
    setCfg(toConfigState(await requestJson<PgConfig>("/api/billing/portone/config")));
  }, []);
  useEffect(() => { if (enabled) (async () => { await load(); })(); }, [enabled, load]);
  return { cfg, load };
}

/**
 * 지금 신청할 수 없는 계정의 안내 — 결제 화면 대신. 결제는 보호자만 한다(설계 13 · 2026-10-22 검토: 일반 회원은 하루 대화 한도가
 *   없어 이용권 효과가 없다). 시험 운영 중 허용 목록 밖 보호자에게는 역할 안내가 아니라 시험 운영이라고 알린다.
 */
function RoleNotice({ config }: { config: PgConfig }) {
  if (config.testModeRestricted) return <p className={note}>지금은 시험 운영 중이라 이용권을 신청할 수 없어요.</p>;
  if (config.role === "pro") return <p className={note}>의사 계정에서는 이용권을 결제할 수 없어요(업무용 계정).</p>;
  if (config.role === "general") return <p className={note}>일반 회원 계정에는 하루 대화 한도가 없어 이용권이 필요 없어요.</p>;
  return <p className={note}>이용권은 <b>보호자 계정</b>에서 신청할 수 있어요. 대화를 더 하고 싶으시면 보호자께 부탁해 주세요.</p>;
}

/** 웹 결제를 팔지 않을 때(config 503 — 스위치 꺼짐) — 예전 브라우저 안내. 앱 Play 구매도 꺼져 있으면 '준비 중' */
function OffNotice({ st }: { st: BillingStatus | null }) {
  if (st?.tier === "pro") return <p className="text-sm text-zinc-500 dark:text-zinc-400">{PLAY_MANAGE_TEXT}</p>;
  return (
    <>
      <PlayBenefits />
      <p className={note}>{st?.playPurchaseEnabled
        ? <>구독 결제는 <b>마음이음 앱</b>에서 진행됩니다. 앱을 설치한 뒤 같은 계정으로 로그인해 주세요.</>
        : "구독 결제는 아직 준비 중이에요."}</p>
    </>
  );
}

/** 화면을 다시 읽게 하는 것과, 결제·해지가 끝났다는 안내를 화면 맨 위에 띄우는 것 */
interface WebHandlers { onChanged: () => void; onNotice: (text: string) => void }

/** 신청 영역 — 보호자이고 아직 이용권이 없는 분이 있을 때. 연결된 어르신이 없으면 연결 안내만 */
function Checkout({ config, onChanged, onNotice }: { config: PgConfig } & WebHandlers) {
  const { data: session } = useSession();
  if (config.beneficiaries.length === 0) return <div className={note}><LinkFirstNotice /></div>;
  if (!config.beneficiaries.some((b) => !b.covered)) return null;
  return (
    <section aria-labelledby="pg-checkout-title" className="space-y-4">
      <h2 id="pg-checkout-title" className="text-xl font-extrabold text-zinc-800 dark:text-zinc-100">월 이용권 신청</h2>
      <PgCheckout
        config={config} me={{ name: session?.user?.name ?? null, email: session?.user?.email ?? null }} onChanged={onChanged} onNotice={onNotice}
      />
    </section>
  );
}

/** 브라우저 — 구독 관리(가입한 이용권 — 판매가 꺼져도 보인다) + 신청(보호자) */
export function WebPanel({ st, cfg, onChanged, onNotice }: { st: BillingStatus | null; cfg: ConfigState } & WebHandlers) {
  const pg = pgOf(st);
  const pgError = st?.pg && "error" in st.pg ? st.pg.error : null;
  const manage = pg && hasPgRecords(st) ? <PgManage pg={pg} onChanged={onChanged} onNotice={onNotice} /> : null;
  if (cfg.kind === "loading") return <p className="text-base text-zinc-600 dark:text-zinc-300">불러오는 중…</p>;
  return (
    <div className="space-y-6">
      {pgError && <p className={note}>{pgError}</p>}
      {manage}
      {cfg.kind === "error" && <p className={note}>{cfg.message}</p>}
      {cfg.kind === "off" && !manage && <OffNotice st={st} />}
      {cfg.kind === "ready" && st?.source === "purchaser" && !manage && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{PLAY_MANAGE_TEXT}</p>
      )}
      {cfg.kind === "ready" && (cfg.config.canPurchase
        ? <Checkout config={cfg.config} onChanged={onChanged} onNotice={onNotice} /> : <RoleNotice config={cfg.config} />)}
    </div>
  );
}

/** 앱 안 — 구독 상태 다음에 Play만(혜택 설명은 구매 버튼이 보일 때·구독 중일 때만. 기본은 상태만) */
export function AppPanel({ st, onReload, onError }: { st: BillingStatus | null; onReload: () => void; onError: (msg: string) => void }) {
  return (
    <>
      {(st?.playPurchaseEnabled || st?.tier === "pro") && <PlayBenefits />}
      <PlayPurchase st={st} onReload={onReload} onError={onError} />
    </>
  );
}

export function SubscribeView() {
  const inApp = useInApp();
  const { st, err, setErr, load } = useBillingStatus();
  const { cfg, load: loadConfig } = usePgConfig(inApp === false && !!st);
  const [notice, setNotice] = useState("");
  const onChanged = useCallback(() => { void load(); void loadConfig(); }, [load, loadConfig]);
  const onError = useCallback((msg: string) => setErr(msg), [setErr]);
  // 결제·해지 완료 안내 — 화면 아래에서 눌렀어도 보이게 맨 위로 올린다
  const onNotice = useCallback((text: string) => { setNotice(text); window.scrollTo({ top: 0, behavior: "smooth" }); }, []);
  return (
    <div className="mx-auto max-w-md px-5 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-extrabold text-zinc-800 dark:text-zinc-100">구독 관리</h1>
        <Link href="/" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">← 돌아가기</Link>
      </div>
      {err && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{err}</p>}
      {notice && (
        <p role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-base text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">{notice}</p>
      )}
      {err === "로그인이 필요합니다." && (
        // 로그인 뒤 이 화면으로 돌아온다(app/login/return-path — 메일·요금 안내로 들어온 분이 구독 관리를 잃지 않게)
        <Link href="/login?callbackUrl=%2Fsubscribe" className="mb-4 flex w-full items-center justify-center rounded-2xl bg-[#007bff] px-6 py-4 text-lg font-bold text-white">로그인</Link>
      )}
      <StatusCard st={st} />
      {inApp === true && <AppPanel st={st} onReload={load} onError={onError} />}
      {inApp === false && st && <WebPanel st={st} cfg={cfg} onChanged={onChanged} onNotice={onNotice} />}
    </div>
  );
}
