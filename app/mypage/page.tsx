"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../LogoutButton";
import MedicationEditor from "../components/MedicationEditor";

interface Profile {
  id: string;
  name: string | null;
  email: string;
  age: number | null;
  gender: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianRelation: string | null;
  guardianEmail: string | null;
  guardianWebhookUrl: string | null;
  companionName: string | null;
  companionRelation: string | null;
  userHonorific: string | null;
  screeningMode: string | null;
  createdAt: string;
}

export default function MyPage() {
  const { status, update: updateSession } = useSession();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianWebhookUrl, setGuardianWebhookUrl] = useState("");
  const [companionName, setCompanionName] = useState("");
  const [companionRelation, setCompanionRelation] = useState("");
  const [userHonorific, setUserHonorific] = useState("");
  const [screeningMode, setScreeningMode] = useState<"user" | "pro" | "guardian" | "general">("user");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [expertCodeInput, setExpertCodeInput] = useState("");
  const [linkingExpert, setLinkingExpert] = useState(false);
  const [expertLinkMsg, setExpertLinkMsg] = useState("");
  const [linkedExperts, setLinkedExperts] = useState<{ expertUserId: string; name: string }[]>([]);
  const [accessLogs, setAccessLogs] = useState<{ expertName: string; action: string; at: string }[]>([]);
  const [showAccessLogs, setShowAccessLogs] = useState(false);

  async function loadAccessLogs() {
    try {
      const res = await fetch("/api/users/access-log");
      if (res.ok) {
        const d = await res.json();
        setAccessLogs(d.logs ?? []);
        setShowAccessLogs(true);
      }
    } catch { /* noop */ }
  }

  async function loadLinkedExperts() {
    try {
      const res = await fetch("/api/users/linked-experts");
      if (res.ok) {
        const d = await res.json();
        setLinkedExperts(d.experts ?? []);
      }
    } catch { /* noop */ }
  }

  async function unlinkExpert(expertUserId: string) {
    try {
      const res = await fetch("/api/users/linked-experts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertUserId }),
      });
      if (res.ok) {
        setExpertLinkMsg("연결을 해제했어요.");
        loadLinkedExperts();
      }
    } catch { /* noop */ }
  }

  async function linkExpert() {
    if (!expertCodeInput.trim()) return;
    setLinkingExpert(true);
    setExpertLinkMsg("");
    try {
      const res = await fetch("/api/users/link-expert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: expertCodeInput.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setExpertLinkMsg(`✓ ${data.expertName}님과 연결되었어요.`);
        setExpertCodeInput("");
        loadLinkedExperts();
      } else {
        setExpertLinkMsg(data.error ?? "연결에 실패했어요.");
      }
    } catch {
      setExpertLinkMsg("연결에 실패했어요. 잠시 후 다시 시도해주세요.");
    }
    setLinkingExpert(false);
  }

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
      return;
    }
    if (status === "authenticated") {
      loadLinkedExperts();
      fetch("/api/users/profile")
        .then((r) => r.json())
        .then((data: Profile) => {
          setProfile(data);
          setName(data.name ?? "");
          setAge(data.age != null ? String(data.age) : "");
          setGender(data.gender ?? "");
          setGuardianName(data.guardianName ?? "");
          setGuardianPhone(data.guardianPhone ?? "");
          setGuardianRelation(data.guardianRelation ?? "");
          setGuardianEmail(data.guardianEmail ?? "");
          setGuardianWebhookUrl(data.guardianWebhookUrl ?? "");
          setCompanionName(data.companionName ?? "");
          setCompanionRelation(data.companionRelation ?? "");
          setUserHonorific(data.userHonorific ?? "");
          setScreeningMode(data.screeningMode === "pro" || data.screeningMode === "guardian" || data.screeningMode === "general" ? data.screeningMode : "user");
        })
        .catch(() => setError("프로필을 불러올 수 없습니다."));
    }
  }, [status, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");

    if (newPassword && newPassword !== newPasswordConfirm) {
      setError("새 비밀번호가 일치하지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        name: name || null,
        age: age === "" ? null : parseInt(age, 10),
        gender: gender || null,
        guardianName: guardianName || null,
        guardianPhone: guardianPhone || null,
        guardianRelation: guardianRelation || null,
        guardianEmail: guardianEmail || null,
        guardianWebhookUrl: guardianWebhookUrl || null,
        companionName: companionName || null,
        companionRelation: companionRelation || null,
        userHonorific: userHonorific || null,
        // screeningMode는 전송하지 않음 — 가입 시 고정, 서버도 무시(악용 방지)
      };
      if (newPassword) {
        body.currentPassword = currentPassword;
        body.newPassword = newPassword;
      }

      const res = await fetch("/api/users/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "수정에 실패했습니다.");
        return;
      }

      setProfile({ ...profile!, ...data });
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      // 세션 갱신 — 헤더의 이름 등이 즉시 반영됨
      await updateSession({ name: data.name });
      setMessage("저장되었습니다.");
    } catch {
      setError("처리 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  if (status === "loading" || (!profile && !error)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5] dark:bg-[#0b0d10]">
        <p className="text-base text-zinc-600 dark:text-zinc-300">불러오는 중…</p>
      </div>
    );
  }
  // 프로필 로드 실패 — 무한 로딩 대신 명확한 에러 + 재시도(기존엔 error가 set돼도 로딩 화면에 가려 '먹통' 인상)
  if (!profile) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f0f2f5] px-6 text-center dark:bg-[#0b0d10]">
        <p className="text-base text-zinc-700 dark:text-zinc-200">{error || "프로필을 불러올 수 없습니다."}</p>
        <div className="flex gap-3">
          <button type="button" onClick={() => location.reload()} className="rounded-lg bg-blue-600 px-5 py-3 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2">다시 시도</button>
          <button type="button" onClick={() => router.push("/chat")} className="rounded-lg bg-zinc-200 px-5 py-3 text-base font-medium text-zinc-700 hover:bg-zinc-300">대화로</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f0f2f5] px-4 py-8 dark:bg-[#0b0d10]">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100">마이페이지</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link href="/chat" className="text-sm text-[#007bff] hover:underline dark:text-blue-400">
              ← 대화
            </Link>
            <LogoutButton />
          </div>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-lg dark:bg-zinc-900 dark:shadow-black/40">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* 이메일 (수정 불가) */}
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">이메일</label>
              <input
                type="email"
                value={profile.email}
                disabled
                className="w-full rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500"
              />
            </div>

            {/* 계정 유형(모드) — 가입 시 고정, 변경 불가(권한 상승·검사 모드 스푸핑 악용 차단) */}
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">계정 유형</label>
              <div className={`rounded-xl border px-3 py-2.5 ${screeningMode === "pro" ? "border-teal-600 bg-teal-50 dark:bg-teal-900/30" : screeningMode === "guardian" ? "border-amber-500 bg-amber-50 dark:bg-amber-900/30" : screeningMode === "general" ? "border-violet-600 bg-violet-50 dark:bg-violet-900/30" : "border-[#007bff] bg-blue-50 dark:bg-blue-900/30"}`}>
                <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                  {screeningMode === "pro" ? "🩺 의사·전문가" : screeningMode === "guardian" ? "👨‍👩‍👧 보호자·가족" : screeningMode === "general" ? "🧠 일반인" : "👵 어르신"}
                </span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                  {screeningMode === "pro" ? "검진 시행·상세 열람" : screeningMode === "guardian" ? "결과 요약·위급 알림" : screeningMode === "general" ? "마음 건강 자가점검" : "일상 대화형 선별"}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">계정 유형은 가입 시 정해지며 변경할 수 없어요. 바꾸려면 새 계정으로 가입해 주세요.</p>
              {(screeningMode === "pro" || screeningMode === "guardian") && (
                <Link href="/expert" className={`mt-2 block rounded-xl border px-3 py-2 text-center text-sm font-semibold ${screeningMode === "guardian" ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100 dark:border-teal-700 dark:bg-teal-900/30 dark:text-teal-200"}`}>
                  {screeningMode === "guardian" ? "👨‍👩‍👧 가족 상태 보기 →" : "🩺 환자 관리 페이지 열기 →"}
                </Link>
              )}
              {/* 목소리 등록(화자식별) — 베타. 어르신 본인 계정만: 서버가 동의한 어르신만 등록·대조를 받는다
                  (app/api/voiceprint). 다른 역할에 보이면 30초 낭독을 다 마친 뒤에야 403을 받는다. */}
              {screeningMode === "user" && (
                <Link href="/voiceprint" className="mt-2 block rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-center text-sm font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                  🎙 목소리 등록·확인 (베타) →
                </Link>
              )}
              {/* 라이브 음성 대화(베타) — 헤더에서 설정으로 통합(2026-09-08). 어르신 계정 + 노출 플래그일 때만 */}
              {screeningMode === "user" && process.env.NEXT_PUBLIC_SHOW_LIVE_BETA === "1" && (
                <Link href="/live" className="mt-2 block rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-center text-sm font-semibold text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                  🎙 라이브 음성 대화 (베타) →
                </Link>
              )}
            </div>

            {/* 마음 건강 체크 — T3 본인용 결과 (일반인 계정 전용 — 모드 간 플로우 비혼합) */}
            {screeningMode === "general" && (
              <Link href="/mental" className="block rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-center text-sm font-semibold text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-200">
                🧠 마음 건강 체크 결과 보기 →
              </Link>
            )}

            {/* 전문가 연결 — 인지 선별(사용자) 계정 전용. 환자 본인이 전문가 코드를 입력해 연결(=본인 동의). 채점·요약만 공유, 대화 원문 비공개 */}
            <div className={screeningMode === "user" ? "" : "hidden"}>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">보호자·전문가 연결 (가족·담당자 코드)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="보호자·전문가 코드 8자리"
                  value={expertCodeInput}
                  onChange={(e) => setExpertCodeInput(e.target.value.toUpperCase())}
                  maxLength={12}
                  className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 font-mono tracking-widest text-zinc-900 outline-none focus:border-teal-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <button
                  type="button"
                  onClick={linkExpert}
                  disabled={linkingExpert || expertCodeInput.trim().length < 6}
                  className="rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-40"
                >
                  {linkingExpert ? "연결 중…" : "연결"}
                </button>
              </div>
              {expertLinkMsg && <p className="mt-1 text-xs text-teal-700 dark:text-teal-300">{expertLinkMsg}</p>}
              <p className="mt-1 text-[11px] text-zinc-400">연결하면 보호자·전문가가 인지 등급·추세 요약만 볼 수 있어요. 어르신 본인에게는 결과가 보이지 않고, 대화 내용도 공개되지 않아요.</p>
              {linkedExperts.length > 0 && (
                <div className="mt-2 space-y-1">
                  {linkedExperts.map((e) => (
                    <div key={e.expertUserId} className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-1.5 text-xs dark:bg-zinc-800">
                      <span className="text-zinc-700 dark:text-zinc-200">🩺 {e.name}님과 연결됨</span>
                      <button type="button" onClick={() => unlinkExpert(e.expertUserId)} className="text-red-500 hover:underline">연결 해제</button>
                    </div>
                  ))}
                </div>
              )}

              {/* 열람 내역 — 내 데이터를 누가 언제 봤는지 본인이 확인(프라이버시 투명성) */}
              <button type="button" onClick={() => (showAccessLogs ? setShowAccessLogs(false) : loadAccessLogs())} className="mt-2 text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300">
                {showAccessLogs ? "열람 내역 닫기" : "내 기록을 누가 봤는지 확인하기"}
              </button>
              {showAccessLogs && (
                <div className="mt-1 space-y-1">
                  {accessLogs.length === 0 && <p className="text-[11px] text-zinc-400">아직 열람 기록이 없어요.</p>}
                  {accessLogs.map((l, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-1.5 text-[11px] dark:bg-zinc-800">
                      <span className="text-zinc-600 dark:text-zinc-300">🩺 {l.expertName} — {l.action}</span>
                      <span className="text-zinc-400">{l.at}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 이름 */}
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">이름</label>
              <input
                type="text"
                placeholder="이름"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>

            {/* 나이, 성별 */}
            <div className="flex gap-2">
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">나이</label>
                <input
                  type="number"
                  placeholder="나이"
                  min={1}
                  max={120}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">성별</label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">선택 안 함</option>
                  <option value="male">남성</option>
                  <option value="female">여성</option>
                  <option value="other">기타</option>
                </select>
              </div>
            </div>

            {/* 구분선 */}
            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* 보호자 정보 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">보호자 정보 (선택)</p>
            <input
              type="text"
              placeholder="보호자 이름"
              value={guardianName}
              onChange={(e) => setGuardianName(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="tel"
              placeholder="보호자 연락처 (010-0000-0000)"
              value={guardianPhone}
              onChange={(e) => setGuardianPhone(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <select
              value={guardianRelation}
              onChange={(e) => setGuardianRelation(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">보호자 관계 (선택)</option>
              <option value="son">아들</option>
              <option value="daughter">딸</option>
              <option value="spouse">배우자</option>
              <option value="grandchild">손자/손녀</option>
              <option value="other">기타</option>
            </select>
            <div>
              <input
                type="email"
                placeholder="보호자 이메일 (응급 알림 수신)"
                value={guardianEmail}
                onChange={(e) => setGuardianEmail(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              {/* 2026-10-07: 이 칸에 이메일만 적으면 보호자 앱으로는 알림이 가지 않는다(앱 알림은 코드 연결이 있어야 함).
                  역할마다 사실이 다르다 — 알림은 응급이 감지된 **본인 계정**의 이 칸을 쓴다. 보호자·전문가 계정은 대화를 하지 않아
                  이 칸이 쓰일 일이 없고, 일반인 계정엔 코드 연결 칸이 없다(재검토 지적) */}
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                {screeningMode === "user"
                  ? <>이 주소로는 이메일만 가요. 보호자가 휴대폰 앱으로도 받으려면 보호자 계정의 코드를 위 &lsquo;보호자·전문가 연결&rsquo;에 입력해 주세요.</>
                  : screeningMode === "general"
                  ? "응급 신호가 감지되면 이 주소로 메일이 가요."
                  : "위급 알림 이메일은 어르신 계정의 마이페이지에서 정해요. 이 계정의 이 칸은 알림에 쓰이지 않아요."}
              </p>
            </div>
            <div>
              <input
                type="url"
                placeholder="Webhook URL (Discord/Slack/IFTTT/Zapier 등)"
                value={guardianWebhookUrl}
                onChange={(e) => setGuardianWebhookUrl(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                응급 상황(L2/L3) 감지 시 이 URL로 POST 알림이 전송됩니다. 1시간 내 같은 카테고리는 중복 발송 차단됩니다.
              </p>
            </div>

            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* AI 동반자 설정 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">AI 동반자 설정 (비우면 &quot;민지 / 손녀&quot;)</p>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">AI가 나를 부를 호칭</label>
              <select
                value={userHonorific}
                onChange={(e) => setUserHonorific(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">자동 (나이/성별로 추천)</option>
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
            </div>
            <input
              type="text"
              placeholder="AI 이름 (예: 민지, 수진, 지훈)"
              value={companionName}
              onChange={(e) => setCompanionName(e.target.value)}
              maxLength={10}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <select
              value={companionRelation}
              onChange={(e) => setCompanionRelation(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">AI 관계 선택</option>
              <option value="손녀">손녀</option>
              <option value="손자">손자</option>
              <option value="딸">딸</option>
              <option value="아들">아들</option>
              <option value="며느리">며느리</option>
              <option value="사위">사위</option>
              <option value="조카">조카</option>
              <option value="친구">친구</option>
            </select>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">* 변경 후 첫 1~2턴은 이전 호칭이 유지될 수 있어요.</p>

            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* 복약/일과 알림 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">복약/일과 알림</p>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              지정한 시간이 되면 채팅에 접속해 있을 때 AI가 먼저 말을 걸어 알려드려요.
              놓치셔도 정시 후 30분까지는 알림이 유지됩니다.
            </p>
            <MedicationEditor persist={true} />

            <hr className="my-2 border-zinc-100 dark:border-zinc-700" />

            {/* 비밀번호 변경 */}
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">비밀번호 변경 (선택)</p>
            <input
              type="password"
              placeholder="현재 비밀번호"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="password"
              placeholder="새 비밀번호 (8자 이상)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              type="password"
              placeholder="새 비밀번호 확인"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              minLength={8}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-[#007bff] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />

            {error && <p className="text-sm text-red-500">{error}</p>}
            {message && <p className="text-sm text-green-600">{message}</p>}

            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-[#007bff] py-3 font-medium text-white transition hover:bg-[#0069d9] disabled:opacity-60"
            >
              {loading ? "저장 중..." : "저장"}
            </button>
          </form>

          {/* 가입일 */}
          <p className="mt-4 text-center text-xs text-zinc-400">
            가입일: {new Date(profile.createdAt).toLocaleDateString("ko-KR")}
          </p>
        </div>
      </div>
    </div>
  );
}
