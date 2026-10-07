"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { BrandLogo, CompanyLogo } from "../BrandLogo";
import MedicationEditor from "../components/MedicationEditor";

interface MedicationDraft { label: string; times: string[]; enabled: boolean }

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [age, setAge] = useState<string>("");
  const [gender, setGender] = useState<string>("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const [companionName, setCompanionName] = useState("");
  const [companionRelation, setCompanionRelation] = useState("");
  const [userHonorific, setUserHonorific] = useState("");
  // 계정 유형 4종. user=어르신 / pro=의사·전문가 / guardian=보호자·가족 / general=일반인
  const [screeningMode, setScreeningMode] = useState<"user" | "pro" | "guardian" | "general">("user");
  const [medicationDrafts, setMedicationDrafts] = useState<MedicationDraft[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== passwordConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          passwordConfirm,
          name: name || undefined,
          age: age === "" ? undefined : parseInt(age, 10),
          gender: gender || undefined,
          guardianName: guardianName || undefined,
          guardianPhone: guardianPhone || undefined,
          guardianRelation: guardianRelation || undefined,
          companionName: companionName || undefined,
          companionRelation: companionRelation || undefined,
          userHonorific: userHonorific || undefined,
          screeningMode,
          medicationDrafts: medicationDrafts.length > 0 ? medicationDrafts : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "회원가입에 실패했습니다.");
        return;
      }
      router.push("/login?registered=1");
    } catch {
      setError("회원가입 처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 py-8 dark:bg-[#0b0d10]">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-zinc-900 dark:shadow-black/40">
        <div className="flex justify-center"><BrandLogo size="lg" /></div>
        <p className="mt-3 text-center text-sm text-zinc-500 dark:text-zinc-400">회원가입</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          {/* 계정 유형 — 가입 후 변경 불가에 가까운 핵심 선택 */}
          <div>
            <p className="mb-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200">계정 유형</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScreeningMode("user")}
                className={`rounded-xl border px-3 py-2.5 text-left transition ${screeningMode === "user" ? "border-[#007bff] bg-blue-50 dark:bg-blue-900/30" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800"}`}
              >
                <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">👵 어르신</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">본인 · 대화만</span>
              </button>
              <button
                type="button"
                onClick={() => setScreeningMode("guardian")}
                className={`rounded-xl border px-3 py-2.5 text-left transition ${screeningMode === "guardian" ? "border-amber-500 bg-amber-50 dark:bg-amber-900/30" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800"}`}
              >
                <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">👨‍👩‍👧 보호자·가족</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">결과 요약 · 알림</span>
              </button>
              <button
                type="button"
                onClick={() => setScreeningMode("pro")}
                className={`rounded-xl border px-3 py-2.5 text-left transition ${screeningMode === "pro" ? "border-teal-600 bg-teal-50 dark:bg-teal-900/30" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800"}`}
              >
                <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">🩺 의사·전문가</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">검진 · 상세 열람</span>
              </button>
              <button
                type="button"
                onClick={() => setScreeningMode("general")}
                className={`rounded-xl border px-3 py-2.5 text-left transition ${screeningMode === "general" ? "border-violet-600 bg-violet-50 dark:bg-violet-900/30" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800"}`}
              >
                <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">🧠 일반인</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">마음 건강 자가점검</span>
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              {screeningMode === "user"
                ? "어르신은 대화만 하시고, 인지 결과는 본인에게 보이지 않아요. 결과는 연결된 보호자·의사가 열람합니다."
                : screeningMode === "guardian"
                ? "가입 후 발급되는 코드를 어르신께 전달해 연결하면, 어르신 상태의 결과 요약과 위급 알림을 받을 수 있어요. 휴대폰 알림은 안드로이드 마음이음 앱에 이 계정으로 로그인해 두어야 와요. (질문 내역·점수 등 상세 평가는 의사만 열람)"
                : screeningMode === "pro"
                ? "가입 후 발급되는 코드를 어르신께 전달해 연결하면, 검진 시행과 문항별 채점·평가 기준 등 상세 내역까지 열람할 수 있어요."
                : "본인의 마음 건강을 스스로 점검하고, 결과 요약을 확인하는 계정이에요."}
            </p>
          </div>
          <input
            type="text"
            placeholder="이름 (선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
          />
          <input
            type="password"
            placeholder="비밀번호 (8자 이상)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
            minLength={8}
          />
          <input
            type="password"
            placeholder="비밀번호 재확인"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
            minLength={8}
          />
          {/* 환자(어르신) 전용 정보 — 의사·보호자·일반인 계정은 본인이 검진 대상이 아니므로 입력 불필요 */}
          {screeningMode === "user" && (<>
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="나이 (선택)"
              min={1}
              max={120}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="w-24 rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            />
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
            >
              <option value="">성별 (선택)</option>
              <option value="male">남성</option>
              <option value="female">여성</option>
              <option value="other">기타</option>
            </select>
          </div>
          <hr className="border-zinc-100 dark:border-zinc-700" />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">보호자 정보 (선택)</p>
          <input
            type="text"
            placeholder="보호자 이름"
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <input
            type="tel"
            placeholder="보호자 연락처 (010-0000-0000)"
            value={guardianPhone}
            onChange={(e) => setGuardianPhone(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <select
            value={guardianRelation}
            onChange={(e) => setGuardianRelation(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">보호자 관계 (선택)</option>
            <option value="son">아들</option>
            <option value="daughter">딸</option>
            <option value="spouse">배우자</option>
            <option value="grandchild">손자/손녀</option>
            <option value="other">기타</option>
          </select>
          <hr className="border-zinc-100 dark:border-zinc-700" />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">AI 동반자 설정 (선택 — 비우면 기본값 &quot;민지 / 손녀&quot;)</p>
          <input
            type="text"
            placeholder="AI 이름 (예: 민지, 수진, 지훈)"
            value={companionName}
            onChange={(e) => setCompanionName(e.target.value)}
            maxLength={10}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <select
            value={userHonorific}
            onChange={(e) => setUserHonorific(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">AI가 나를 부를 호칭 (선택, 비우면 자동)</option>
            <option value="할아버지">할아버지</option>
            <option value="할머니">할머니</option>
            <option value="아버지">아버지</option>
            <option value="어머니">어머니</option>
            <option value="아빠">아빠</option>
            <option value="엄마">엄마</option>
            <option value="아저씨">아저씨</option>
            <option value="이모">이모</option>
            <option value="삼촌">삼촌</option>
            <option value="고모">고모</option>
          </select>
          <select
            value={companionRelation}
            onChange={(e) => setCompanionRelation(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">AI 관계 (선택)</option>
            <option value="손녀">손녀</option>
            <option value="손자">손자</option>
            <option value="딸">딸</option>
            <option value="아들">아들</option>
            <option value="며느리">며느리</option>
            <option value="사위">사위</option>
            <option value="조카">조카</option>
            <option value="친구">친구</option>
          </select>

          {/* 복약/일과 알림 (선택) */}
          <details className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800">
            <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">
              복약/일과 알림 미리 등록 (선택)
            </summary>
            <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              지정한 시간이 되면 AI가 먼저 말을 걸어 약 드실 시간이라고 알려드려요. 나중에 마이페이지에서도 추가/수정 가능합니다.
            </p>
            <div className="mt-3">
              <MedicationEditor persist={false} onChange={setMedicationDrafts} />
            </div>
          </details>
          </>)}

          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#007bff] py-3 font-medium text-white transition hover:bg-[#0069d9] disabled:opacity-60"
          >
            {loading ? "가입 중..." : "회원가입"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          이미 계정이 있으신가요?{" "}
          <Link href="/login" className="font-medium text-[#007bff] dark:text-blue-400">
            로그인
          </Link>
        </p>
      </div>
      <div className="mt-6"><CompanyLogo /></div>
    </div>
  );
}
