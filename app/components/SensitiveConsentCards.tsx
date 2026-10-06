"use client";

/**
 * 민감정보 별도 동의 화면(선택) — 목소리 등록(성문)·상시 감시. 서버 규칙은 lib/sensitive-consent.ts.
 *
 * 문안 근거(2026-10-06 조사): 개인정보 보호법 제15조②(목적·항목·기간·거부권과 불이익), 제17조②(제공받는 자·
 *   목적·항목·보유기간·거부권), 제22조①(동의 사항을 구분해 각각 동의), 제23조①(민감정보 별도 동의),
 *   제28조의8(국외 이전), 시행령 제17조③·「개인정보 처리 방법에 관한 고시」 제4조(중요한 내용은 글씨
 *   크기·색·굵기·밑줄로 구분) — <Em>으로 표시한 부분.
 *
 * ⚠ 문안을 바꾸면 lib/sensitive-consent.ts의 SENSITIVE_CONSENT_VERSION을 올린다(재동의).
 * ⚠ 사실과 다른 고지를 하지 않는다 — 각 문장은 코드 동작과 맞춰 썼다(app/api/observe/turn, app/api/voiceprint,
 *   lib/voiceprint/seal). 동작을 바꾸면 문안도 같이 바꾼다.
 */
import { useState } from "react";
import Link from "next/link";

/** 중요한 내용 — 크기·색·굵기·밑줄로 다른 글과 구분(처리 방법 고시 제4조) */
function Em({ children }: { children: React.ReactNode }) {
  return (
    <b className="text-[1.05em] font-bold text-rose-700 underline decoration-rose-300 underline-offset-2 dark:text-rose-300 dark:decoration-rose-700">
      {children}
    </b>
  );
}

function Item({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-semibold text-zinc-800 dark:text-zinc-100">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 rounded border-zinc-300 text-[#007bff] focus:ring-2 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800"
      />
      <span className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">{children}</span>
    </label>
  );
}

const BOX = "space-y-4 rounded-xl bg-zinc-50 p-4 text-[15px] leading-relaxed text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-200";
const CARD = "rounded-2xl bg-white p-5 text-left text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-100";

/** 동의 기록 요청 — 실패 사유를 사람 말로 돌려준다 */
async function grant(kinds: string[]): Promise<string | null> {
  try {
    const res = await fetch("/api/users/sensitive-consent", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant: kinds }),
    });
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    if (d?.needConsent) return "먼저 건강정보 수집·이용 동의가 필요해요. 홈 화면에서 동의한 뒤 다시 와 주세요.";
    return d?.error || "처리에 실패했어요. 잠시 후 다시 시도해 주세요.";
  } catch {
    return "연결이 불안정해요. 잠시 후 다시 시도해 주세요.";
  }
}

/** 동의 철회(+파기) 요청 — 성공하면 null */
export async function withdrawSensitiveConsent(kind: "voiceprint" | "observe"): Promise<string | null> {
  try {
    const res = await fetch(`/api/users/sensitive-consent?kind=${kind}`, { method: "DELETE" });
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    return d?.error || "처리에 실패했어요. 잠시 후 다시 시도해 주세요.";
  } catch {
    return "연결이 불안정해요. 잠시 후 다시 시도해 주세요.";
  }
}

const SELF_ONLY = "이 동의는 어르신 본인의 뜻이어야 하며, 가족이 대신할 수 없습니다(법원이 정한 후견인은 문의해 주세요).";

export function VoiceprintConsentCard({ onAgreed }: { onAgreed: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!agreed) return;
    setBusy(true); setError("");
    const err = await grant(["voiceprint"]);
    setBusy(false);
    if (err) setError(err); else onAgreed();
  };

  return (
    <section className={CARD}>
      <h2 className="text-lg font-bold">목소리 등록 동의 <span className="text-sm font-semibold text-zinc-500">(선택)</span></h2>
      <p className="mt-1 text-[15px] text-zinc-600 dark:text-zinc-300">
        상시 감시가 어르신 목소리만 골라 들으려면, 어르신 목소리의 특징을 숫자로 바꾼 값(성문)을 보관해야 해요.
        <span className="mt-1 block text-xs text-zinc-400">개인정보 보호법 제23조(민감정보)에 따른 별도 동의</span>
      </p>
      <div className={`mt-4 ${BOX}`}>
        <Item title="① 무엇에 쓰나요">
          <p>상시 감시 중 들린 말소리가 어르신 본인 목소리인지 휴대폰 안에서 확인하는 데만 씁니다. 그 밖의 목적(인지 분석, 인공지능 학습, 광고 등)에는 쓰지 않습니다.</p>
        </Item>
        <Item title="② 무엇을 보관하나요">
          <p><Em>목소리 특징값(성문) — 민감정보(생체인식정보)</Em>. 목소리에서 뽑은 숫자 256개이고, 녹음 파일이 아닙니다. 등록할 때마다 만든 값과 그 평균값을 보관합니다.</p>
          <p>30초 동안 읽어 주신 녹음은 휴대폰 안에서 특징값을 만드는 데만 쓰고, 저장하거나 서버로 보내지 않습니다. 확인 테스트 때 녹음한 목소리의 특징값은 비교에만 쓰고 저장하지 않습니다.</p>
        </Item>
        <Item title="③ 얼마나 보관하나요">
          <p><Em>목소리 등록을 지우시거나 이 동의를 철회하시면 바로 지웁니다. 회원 탈퇴 때는 계정과 함께 지웁니다.</Em></p>
        </Item>
        <Item title="④ 어떻게 지키나요">
          <p>암호화해 저장하고, 암호화된 통신으로만 주고받습니다. 특징값은 상시 감시 화면을 열 때 어르신 휴대폰으로만 내려보냅니다. 연결된 의사(전문가)도 등록 여부(표본 수·등록 시각)만 볼 수 있고 특징값은 받지 못합니다.</p>
        </Item>
        <Item title="⑤ 동의하지 않으셔도 됩니다">
          <p><Em>동의하지 않으셔도 AI와 대화하기 등 다른 기능은 그대로 쓰실 수 있습니다. 목소리 등록과 상시 감시만 쓸 수 없습니다.</Em> 동의한 뒤에도 이 화면의 [목소리 등록 동의 철회]로 언제든 거두실 수 있습니다.</p>
        </Item>
        <Item title="⑥ 누가 동의하나요">
          <p>{SELF_ONLY} 연결된 의사(전문가)가 등록을 도와드릴 수 있지만, 어르신이 이 동의를 하신 경우에만 가능합니다.</p>
        </Item>
      </div>
      <div className="mt-4">
        <Check checked={agreed} onChange={setAgreed}>
          <span className="text-zinc-500">(선택)</span> 위 내용을 확인했고, <b>목소리 특징값(성문·민감정보)을 보관하고 이용하는 데 동의</b>합니다.
        </Check>
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      <button type="button" onClick={submit} disabled={!agreed || busy}
        className="mt-4 w-full rounded-full bg-[#28a745] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50">
        {busy ? "처리 중..." : "동의하고 목소리 등록하기"}
      </button>
      <p className="mt-3 text-center text-xs text-zinc-400">
        자세한 내용은 <Link href="/privacy" className="underline">개인정보처리방침</Link>에 있어요.
      </p>
    </section>
  );
}

export function ObserveConsentCard({ onAgreed }: { onAgreed: () => void }) {
  const [agreeProcess, setAgreeProcess] = useState(false);
  const [agreeShare, setAgreeShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!agreeProcess || !agreeShare) return;
    setBusy(true); setError("");
    // 두 동의는 각각 체크받고(제22조①), 서버에는 함께 기록한다(하나만 있으면 켤 수 없다)
    const err = await grant(["observe", "observe_share"]);
    setBusy(false);
    if (err) setError(err); else onAgreed();
  };

  return (
    <section className={CARD}>
      <h2 className="text-lg font-bold">상시 감시 이용 동의 <span className="text-sm font-semibold text-zinc-500">(선택)</span></h2>
      <p className="mt-1 text-[15px] text-zinc-600 dark:text-zinc-300">
        상시 감시를 켜면 휴대폰이 주변 소리를 들으며 어르신의 위급 신호를 살핍니다. 아래 두 가지에 <b>각각</b> 동의해 주셔야 켤 수 있어요.
        <span className="mt-1 block text-xs text-zinc-400">개인정보 보호법 제17조·제22조·제23조·제28조의8에 따른 안내</span>
      </p>

      <h3 className="mt-5 text-base font-bold">1. 음성·건강정보 처리 (민감정보)</h3>
      <div className={`mt-2 ${BOX}`}>
        <Item title="① 무엇에 쓰나요">
          <p>어르신이 혼자 계실 때 하시는 말에서 위급 신호(넘어짐, 숨쉬기 어려움, 극단적인 생각 등)를 찾아 보호자·의사에게 알리기 위해서입니다.</p>
        </Item>
        <Item title="② 어떻게 작동하나요">
          <p>켜 두는 동안 휴대폰이 주변 소리를 계속 듣습니다. 말소리가 들리면 휴대폰 안에서 등록된 목소리와 비교해 <Em>어르신 목소리로 판단된 말소리만</Em> 서버로 보냅니다. 다른 사람 목소리·TV 소리·잡음으로 판단된 소리는 휴대폰 안에서 비교만 하고 바로 버립니다.</p>
          <p><Em>다만 기계 판단이라 완벽하지 않아서, 어르신과 다른 분의 말소리가 섞이면 함께 보내질 수 있습니다. 다른 분과 이야기하시거나 전화하실 때는 꺼 주세요.</Em></p>
          <p>[감시 끄기]를 누르거나 이 화면을 나가면 멈춥니다.</p>
        </Item>
        <Item title="③ 무엇을 처리하나요">
          <p><Em>어르신 목소리로 판단된 말소리(음성), 그 말을 글자로 바꾼 내용, 위급 신호 판정 결과(단계·종류·시각) — 민감정보(건강정보) 포함</Em></p>
        </Item>
        <Item title="④ 얼마나 보관하나요">
          <p><Em>말소리(음성)는 서버에 저장하지 않습니다. 글자로 바꾼 말 가운데 위급 신호가 없는 말은 저장하지 않고 버립니다. 위급 신호로 판정된 말과 판정 결과는 이 동의를 철회하시거나 회원 탈퇴하실 때까지 보관하고, 그때 지웁니다.</Em></p>
        </Item>
        <Item title="⑤ 외국 회사가 처리합니다 (국외 이전 안내)">
          <p>말소리를 글자로 바꾸고 위급 여부를 판단하는 일은 <b>Google LLC</b>의 인공지능(Gemini) 서버(미국 등 Google 설비가 있는 국가)에서 처리됩니다. 말소리가 들릴 때마다 암호화된 통신으로 보내며, Google은 유료 이용약관에 따라 이를 인공지능 학습에 쓰지 않습니다(정책 위반 감시를 위해 제한된 기간 기록될 수 있음). 상시 감시를 쓰지 않으시면 보내지 않습니다. 자세한 내용은 개인정보처리방침의 &lsquo;개인정보의 국외 이전&rsquo;에 있습니다.</p>
        </Item>
        <Item title="⑥ 알아 두실 점">
          <p>인공지능과 규칙이 자동으로 판단하므로 위급을 놓치거나, 위급이 아닌데 알림이 갈 수 있습니다. <b>119 신고를 대신하지 않습니다.</b></p>
        </Item>
        <Item title="⑦ 동의하지 않으셔도 됩니다">
          <p><Em>동의하지 않으셔도 다른 기능은 그대로 쓰실 수 있고, 상시 감시만 쓸 수 없습니다.</Em> 이 화면의 [상시 감시 동의 철회]로 언제든 그만두실 수 있고, 철회하시면 상시 감시로 보관한 기록을 바로 지웁니다.</p>
        </Item>
      </div>
      <div className="mt-3">
        <Check checked={agreeProcess} onChange={setAgreeProcess}>
          <span className="text-zinc-500">(선택)</span> 상시 감시를 위해 <b>어르신의 음성과 건강정보(민감정보)를 처리하는 것에 동의</b>합니다.
        </Check>
      </div>

      <h3 className="mt-6 text-base font-bold">2. 보호자·의사에게 알림 (제3자 제공)</h3>
      <div className={`mt-2 ${BOX}`}>
        <Item title="받는 분">
          <p><Em>어르신이 연결하신 보호자·의사(마음이음 앱), 어르신이 등록하신 보호자 이메일·메신저 알림 주소</Em></p>
        </Item>
        <Item title="목적">
          <p><Em>위급 상황을 확인하고 도와드리기 위해</Em></p>
        </Item>
        <Item title="보내는 내용">
          <p><Em>어르신 성함, 위급 신호의 단계·종류, 감지 시각 — 민감정보(건강정보)</Em>. 메신저 알림 주소에는 그 말의 일부(최대 200자)도 함께 갑니다. 연결된 의사는 앱에서 위급으로 판정된 말을 볼 수 있습니다.</p>
        </Item>
        <Item title="받는 분의 보관 기간">
          <p><Em>앱에서 보는 기록은 연결이 끊기거나, 이 동의를 철회하시거나, 회원 탈퇴하시면 더는 볼 수 없습니다. 이메일·메신저로 받은 알림은 받는 분이 직접 관리합니다.</Em></p>
        </Item>
        <Item title="동의하지 않으시면">
          <p>위급 신호를 찾아도 알릴 곳이 없어 상시 감시를 쓸 수 없습니다. 다른 기능은 그대로 쓰실 수 있습니다.</p>
        </Item>
      </div>
      <div className="mt-3">
        <Check checked={agreeShare} onChange={setAgreeShare}>
          <span className="text-zinc-500">(선택)</span> 위급 신호가 감지되면 <b>위 내용을 보호자·의사에게 보내는 것에 동의</b>합니다.
        </Check>
      </div>

      <div className="mt-4 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
        <p>※ 함께 사시는 분이나 찾아오시는 분께 상시 감시를 켜 두었다는 것을 미리 알려 주세요.</p>
        <p>※ {SELF_ONLY}</p>
      </div>
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      <button type="button" onClick={submit} disabled={!agreeProcess || !agreeShare || busy}
        className="mt-4 w-full rounded-full bg-[#28a745] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50">
        {busy ? "처리 중..." : "동의하고 상시 감시 준비하기"}
      </button>
      <p className="mt-3 text-center text-xs text-zinc-400">
        자세한 내용은 <Link href="/privacy" className="underline">개인정보처리방침</Link>에 있어요.
      </p>
    </section>
  );
}
