"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { BrandLogo, CompanyLogo } from "../BrandLogo";
import { LATEST_APP_VERSION, isOlderVersion } from "@/lib/app-version";
import { AppDownload } from "./AppDownload";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null); // RN 앱이 주입한 설치 버전(알 수 없으면 null)
  // RN 앱(WebView) 안에서 실행 중인지 — null은 아직 모름(서버 렌더·첫 그리기). 알기 전엔 앱 받기 영역을 그리지 않는다(2026-10-08 10차):
  //   예전엔 false(브라우저)로 시작해, Play로 받은 앱 웹뷰에도 하이드레이션 전까지 웹 APK 링크가 보였다(AppDownload Play 정책 주석)
  const [inApp, setInApp] = useState<boolean | null>(null);
  const [updateNeeded, setUpdateNeeded] = useState(false);

  // 저장된 아이디(이메일) 자동 채움
  useEffect(() => {
    const saved = localStorage.getItem("savedEmail");
    if (saved) { setEmail(saved); setRemember(true); }
  }, []);

  // 설치 앱 버전 확인 → 최신과 비교해 업데이트 안내
  //  - 앱이 버전 주입(window.MAEUM_APP_VERSION): 그 값으로 비교
  //  - 앱(ReactNativeWebView)인데 버전 미주입: 버전표시 이전 '구버전' → 업데이트 권장
  //  - 일반 브라우저: 해당 없음
  useEffect(() => {
    const w = window as unknown as { MAEUM_APP_VERSION?: string; ReactNativeWebView?: unknown };
    const isApp = !!w.ReactNativeWebView;
    setInApp(isApp);
    const v = w.MAEUM_APP_VERSION;
    if (typeof v === "string") {
      setAppVersion(v);
      setUpdateNeeded(isOlderVersion(v, LATEST_APP_VERSION));
    } else if (isApp) {
      setAppVersion(null);      // 버전 확인 불가(구버전)
      setUpdateNeeded(true);    // 업데이트 권장
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (res?.error) {
        setError("이메일 또는 비밀번호를 확인해 주세요.");
        return;
      }
      // 아이디 저장 — 체크 시 이메일 보관, 해제 시 삭제
      if (remember) localStorage.setItem("savedEmail", email);
      else localStorage.removeItem("savedEmail");
      // 역할별 랜딩은 홈(/)이 서버에서 결정 — pro는 /expert, 그 외 /chat. /chat 깜빡임 방지.
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 dark:bg-[#0b0d10]">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-zinc-900 dark:shadow-black/40">
        <div className="flex justify-center"><BrandLogo size="lg" /></div>
        <p className="mt-3 text-center text-base text-zinc-600 dark:text-zinc-300">로그인</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
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
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base text-zinc-900 outline-none focus:border-[#007bff] focus:ring-2 focus:ring-blue-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            required
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-[#007bff] focus:ring-2 focus:ring-blue-400 dark:border-zinc-600 dark:bg-zinc-800"
            />
            아이디 저장
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[#007bff] py-4 text-base font-medium text-white transition hover:bg-[#0069d9] focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 disabled:opacity-60"
          >
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
        {/* 업데이트 안내 + 앱 받기 버튼 + 버전 줄 — Play 배포 스위치에 따라 APK/Play, 앱 안에선 Play만(AppDownload 주석).
            앱인지 알기 전(서버 렌더)엔 그리지 않는다 — 앱 웹뷰에 APK 링크가 잠깐이라도 보이지 않게 */}
        {inApp !== null && <AppDownload updateNeeded={updateNeeded} appVersion={appVersion} inApp={inApp} />}
        <p className="mt-6 text-center text-base text-zinc-600 dark:text-zinc-300">
          계정이 없으신가요?{" "}
          <Link href="/signup" className="font-medium text-[#007bff] dark:text-blue-400">
            회원가입
          </Link>
        </p>
        <p className="mt-3 text-center text-xs text-zinc-400">
          <Link href="/privacy" className="hover:underline">개인정보처리방침</Link>
        </p>
      </div>
      <div className="mt-6"><CompanyLogo /></div>
    </div>
  );
}
