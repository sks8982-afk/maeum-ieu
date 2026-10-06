"use client";

import { useState } from "react";
import { signOut, useSession } from "next-auth/react";

export default function ConsentPage() {
  // 일반인(general)은 인지 선별 대상이 아니라 마음 건강 자가점검만 한다 —
  //   "어르신의 인지"로 고지하면 실제 수집 항목과 어긋난다(고지 정확성).
  const { data: session } = useSession();
  const isGeneral = session?.user?.screeningMode === "general";

  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleAgree() {
    if (!agreed) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/users/consent", { method: "POST" });
      if (!res.ok) {
        setError("처리에 실패했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      window.location.href = isGeneral ? "/mental" : "/chat";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f0f2f5] px-4 py-8 dark:bg-[#0b0d10]">
      <div className="w-full max-w-lg rounded-2xl bg-white p-7 shadow-lg dark:bg-zinc-900">
        <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">건강정보(민감정보) 수집·이용 동의</h1>
        <p className="mt-2 text-base text-zinc-600 dark:text-zinc-300">
          마음이음은 {isGeneral ? "회원님의 마음 건강" : "어르신의 인지·마음 건강"}을 살피기 위해 <b>건강정보(민감정보)</b>를 수집·이용합니다. 아래 내용을 확인하고 동의해 주세요.
          <span className="mt-1 block text-sm text-zinc-400">개인정보 보호법 제15조·제22조·제23조에 따른 안내</span>
        </p>

        <div className="mt-5 space-y-4 rounded-xl bg-zinc-50 p-4 text-[15px] leading-relaxed text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-200">
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">① 수집·이용 목적</p>
            <p>{isGeneral ? "마음 건강 자가점검 결과 제공과 변화 감지" : "인지·마음 건강 상태의 관찰과 변화 감지"}, 위급(응급) 상황 시 보호자 알림</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">② 수집 항목 <span className="text-rose-600 dark:text-rose-400">(민감정보 포함)</span></p>
            <p>AI와 나눈 대화 내용 · {isGeneral ? "마음 건강 자가점검(우울·불안·성격) 응답과 점수" : "인지/마음 건강 상태 추정 결과"} · 응급(위급) 신호 · 보호자 연락처(선택)</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">③ 보유·이용 기간</p>
            <p>회원 탈퇴 또는 동의 철회 시까지 보관하며, 그 즉시 <b>지체 없이 파기</b>합니다. (연락처 등은 암호화 저장)</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">④ 보호자·전문가 제공(열람) 범위 <span className="text-zinc-500">(중요)</span></p>
            <p>회원이 직접 <b>연결한</b> 보호자·전문가에게 <b>결과 요약과 ‘문제 있는 발화(응급)’만</b> 제공됩니다. <b>일상 대화 원문은 제공되지 않습니다.</b> (연결을 하지 않으면 누구에게도 제공되지 않습니다.)</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">⑤ 동의 거부 권리 및 불이익</p>
            <p>동의를 <b>거부할 권리</b>가 있습니다. 다만 건강정보 수집에 동의하지 않으면 본 서비스(대화·건강 살핌)를 이용하실 수 없습니다.</p>
          </div>
          <div>
            <p className="font-semibold text-zinc-800 dark:text-zinc-100">⑥ 동의 철회</p>
            <p>언제든 마이페이지 또는 문의를 통해 동의를 철회할 수 있습니다.</p>
          </div>
          {/* 2026-10-06: 성문(생체인식정보)·상시 감시는 이 동의 범위 밖 — 선택 기능이라 따로 받는다(제22조⑤·제23조) */}
          {!isGeneral && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              ※ 목소리 등록(목소리 특징값)과 상시 감시는 이 동의에 포함되지 않으며, 그 기능을 켤 때 따로 동의를 받습니다(선택).
            </p>
          )}
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-5 w-5 rounded border-zinc-300 text-[#007bff] focus:ring-2 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800"
          />
          <span className="text-[15px] font-medium text-zinc-800 dark:text-zinc-100">
            <span className="text-rose-600 dark:text-rose-400">(필수)</span> 위 내용을 확인했고, <b>건강정보(민감정보)의 수집·이용 및 연결한 보호자·전문가 제공에 동의</b>합니다.
          </span>
        </label>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

        <button
          type="button"
          onClick={handleAgree}
          disabled={!agreed || loading}
          className="mt-5 w-full rounded-xl bg-[#007bff] py-4 text-lg font-semibold text-white transition hover:bg-[#0069d9] disabled:opacity-50"
        >
          {loading ? "처리 중..." : "동의하고 시작하기"}
        </button>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-3 w-full text-center text-sm text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          동의하지 않고 나가기(로그아웃)
        </button>
      </div>
    </div>
  );
}
