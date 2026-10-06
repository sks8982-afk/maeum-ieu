/**
 * 부적절 발언(성적 농담·욕설·혐오) 1차 필터.
 *
 * 정책:
 * - LLM 호출 전 키워드/패턴 기반으로 명백한 부적절 발언을 감지한다.
 * - 첫 1회는 부드러운 환기, 2회 이상은 단호한 거절로 단계적 대응.
 * - 정상 대화 손상이 없도록 보수적 키워드만 사용. 의학·신체 부위는 의료 맥락이라 제외.
 * - 사용자가 노인이므로 톤은 부드럽되 의지는 분명하게.
 */

// 한국어 조사 공용 helper
import { nameTopic, nameSubj, iGa, eunNeun } from "./korean-particle";

// 명백한 성적/외설 의도 표현. 일반 대화에서 거의 안 쓰이는 강한 표현만.
const SEXUAL_EXPLICIT = [
  // 직접적 외설 (강한 표현) — 전부 한글 경계 필수(死 정규식 클래스):
  //   "처음부터"의 '음부', "감자 위에"의 '자 위', "급성 기관지염"의 '성 기'가 매칭돼
  //   정상 발화가 차단됐음(2026-06-12 100턴 라이브). 뒤는 비한글 또는 조사만 허용.
  /(?<![가-힣])자\s*위(?:(?![가-힣])|[가를는도])/,
  /(?<![가-힣])성\s*기(?:(?![가-힣])|[가를는도에])/,
  /(?<![가-힣])음\s*[경부핵](?:(?![가-힣])|[가를는도에])/,
  // "보지/자지"는 동사 활용형(보지 뭐, 보지 마, 자지 마, 자지러지게…)이 너무 많아 negative lookahead로 다 막기 불가.
  // → 명백한 외설 동반 표현이 있을 때만 매칭하는 positive-context 패턴으로 전환.
  /보지\s*(?:만져|핥|빨|크|작|예쁜|보여|보고\s*싶|크기|구멍|만지|넣)/,
  /자지\s*(?:만져|핥|빨|크|작|발기|딸딸|꼴|보여|넣|만지|크기)/,
  /섹\s*스|s[\W_]*e[\W_]*x(?!\w)/i,
  // "떡을 먹었지" 같은 음식 발화 FP 방지하되 속어 정칙형 "떡(을) 치다/쳤다"는 유지 —
  //   동사 활용(치/쳐)까지 요구하면 음식 문맥은 통과하고 속어만 매칭됨.
  // 떡메질(전통 음식 만들기) 제외 — '설날에 떡을 쳐서 먹었지'가 차단되던 결함.
  /떡\s*을?\s*[치쳐](?!서\s*(?:먹|만|나|드)|주|대|는\s*(?:거|걸)\s*구경)/,
  // "야해" 단독은 동사 어미("가야해/먹어야해/타야해" 등)에 false positive → 제거.
  // 외설 의도는 "야한 거/얘기/이야기/동영상" 같이 "야한" 명사구로 잡으면 충분.
  // "야동"은 한글 경계 필수 — "동네야 동탄이지"의 '야 동'이 매칭돼 정상 발화가 차단됐음(2026-06-12, 死 정규식 클래스).
  //   앞: 한글 비선행(조사 '~야' 제외) / 뒤: 한글 비후행(동탄·동네 제외) 또는 조사·'보다' 동반.
  /(?<![가-힣])야\s*동(?![가-힣])|(?<![가-힣])야동[을를이도만봐보]|야\s*한\s*거|야\s*한\s*[얘이]|야\s*한\s*동영상|야\s*한\s*이야기|야\s*한\s*얘기/,
  /오\s*[르럴]\s*가\s*즘/,
  // "음탕/음란" — 한글 경계 필수(死 정규식 클래스): 경계 없으면 "닭볶음탕"의 '음탕',
  //   "오징어볶음탕" 등 어르신 일상 음식어가 외설로 차단됨(2026-06-15 90턴 라이브 FP).
  //   앞에 한글이 오면(볶음탕) 제외, 단어 시작·공백 뒤("음탕한"·"음란물")만 매칭.
  // 공백 불허 — 음성 STT는 쉼표를 붙이지 않아 필러 '음' + 탕류 음식이 차단됐다("음 탕국 끓였어").
  /(?<![가-힣])[음웅]탕|(?<![가-힣])[음웅]란/,
  // 요청·명령형 필수 — '마늘 껍질 벗겨서 넣었어'(요리), '땀 나서 옷 벗고 씻었어'(위생)가
  //   성적 표현으로 차단되던 결함(2026-10-01).
  /벗\s*겨\s*(?:줘|봐|달|주세|보세|볼래)|벗\s*어\s*(?:봐|달|줘|보세)|옷\s*(?:다\s*)?벗(?:어\s*(?:봐|줘|달)|은\s*(?:거|모습|사진))/,
  /가\s*슴[\s\S]{0,4}(?:만[져지]|주물|보여|보고\s*싶)|가\s*슴\s*크기/,  // "가슴 (좀) 만져/보여" 사이 부사 허용. "가슴이 아파"는 만져/보여 없어 미매칭(의료 안전)
  // 요청형 필수 — '넘어져서 엉덩이 만지면 아파'(낙상 보고)가 차단되던 결함.
  /엉\s*덩\s*이[\s가-힣]{0,4}(?:만[져지]\s*(?:줘|봐|보자|보세|볼래|달|도\s*[돼되]|고\s*싶)|주물|보여\s*(?:줘|봐|달)|보고\s*싶)/,  // "엉덩이 (한번/좀) 만져/보여" 사이 부사 허용
  /수\s*위\s*(높|쎈|센|있)/,
  /19\s*금|성\s*인\s*용/,
];

// 욕설/혐오 — 일반 노인 화법에서 잘 안 쓰는 강한 욕설만
const STRONG_PROFANITY = [
  // 선행 한글 경계 필수 — '고추씨 팔러'의 '씨 팔'이 욕설로 잡히던 결함(2026-10-01)
  /(?<![가-힣])(?:씨\s*발|씨\s*팔|시\s*발|쓰\s*발)/,
  // 선행 한글 경계 필수 — '당뇨병 신경'·'지병 신경'·'심장병 신약'이 차단되던 결함.
  //   당뇨 신경병증은 이 사용자층의 핵심 화제다.
  /(?<![가-힣])(?:병\s*신|븅\s*신)/,
  // '개 새끼'(띄어쓰기)는 강아지를 뜻하는 일상어 — 붙여 쓴 형태만 욕설로 본다.
  /(?<![가-힣])개(?:새\s*끼|세\s*끼)/,
  /좆\s*같|좆\s*까|좆\s*만/,
  /[지짖]\s*랄/,
  // "꺼져"는 사물 서술("불이 꺼져서", "TV가 꺼져 있어")에 false positive
  // → 욕설 문맥만 매칭하는 positive-context: 발화 시작·감탄/지시 선행어(단독 토큰)·명령 종결형.
  //   "불이야 꺼져"의 '이야'는 토큰 내부라 선행어 (?:^|\s)야 에 안 걸림. "꺼져버려서"(사물)는 (?!서)로 제외.
  /닥\s*쳐|^\s*꺼\s*져|(?:^|\s)(?:너|당신|저리|빨리|야|아|에이|좀|제발|그냥)\s*,?\s*꺼\s*져|꺼\s*져\s*버려(?!서)|꺼\s*져\s*라(?![가-힣])|꺼\s*지(?:라고|란)/,
];

// 자살·자해 유도 — 별도 대응 (전문 도움 권유)
const SELF_HARM = [
  /자\s*살\s*(하|할|하고\s*싶|방법)/,
  /죽\s*고\s*싶/,
  /목\s*매|뛰\s*어\s*내려/,
];

export type ModerationCategory = "sexual" | "profanity" | "self_harm" | "ok";

export interface ModerationResult {
  category: ModerationCategory;
  matched?: string;
}

/**
 * 자해 표현 뒤에 부정이 붙으면 위기 아님 — emergency.ts와 같은 규칙 (2026-09-30).
 *
 * 배경: PHQ-9 9번 문항이 "죽고 싶다거나…"를 문항으로 제시하므로 **부정으로 답해도**
 *   ("죽고 싶다는 생각은 없었어요") self_harm으로 잡혀 109 안내가 나가고 대화가 끊겼다.
 *   일상 대화에서도 "죽고 싶다는 생각은 없어"는 위기가 아니다.
 * ⚠ 창을 12자로 짧게 두고 지속 표지가 있으면 적용하지 않는다(진짜 신호 보존).
 */
function isNegatedSelfHarm(text: string, m: RegExpMatchArray | null): boolean {
  if (!m || m.index === undefined) return false;
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
  const NEGATED = /(?:은|는|이|가|도)?\s*없(?:었|어|다|습니|네|고|을)|안\s*(?:해|했|드|들)|아니(?:에|야|다|라|고|)|지\s*않|(?:한|그런)\s*적\s*(?:은|도)?\s*없/;
  const STILL_DISTRESSED = /지금도|아직도|여전히|자꾸|계속|또\s*죽|다시\s*죽/;
  return NEGATED.test(after) && !STILL_DISTRESSED.test(text);
}

/**
 * 과거의 자살 생각을 "지금은 괜찮다"며 말하는가 — B9(2026-10-06 사용자 결정).
 *
 * 직접 운전: "예전엔 죽고 싶었는데, 지금은 친구들이 있어서 괜찮아" → "지금 바로 109에 전화" 위기 안내 →
 *   어르신 "아이고 아니야, 걱정 마". 해소된 과거를 털어놓았는데 위기 취급하면 다음엔 말하지 않게 된다.
 *   과거 자살 생각은 여전히 위험 요인이라 **기록(L2)·보호자 알림은 그대로** 두고, 말만 공감·후속 확인·상담 번호로 바꾼다.
 * 판정(전부 만족할 때만 — 하나라도 빠지면 기존 위기 안내, 애매하면 안전한 쪽):
 *   ① 모든 자해 표현이 과거형("죽고 싶었…") ② 그 앞에 과거 표지 ③ 그 뒤에 지금의 해소 진술 ④ 지속·재발 표지 없음
 */
const PAST_MARKER_SH = /예전|옛날|한동안|그때|그\s*당시|젊었을|젊을\s*때|한창\s*때|작년|몇\s*년\s*전|오래\s*전/;
const NOW_RESOLVED_SH = /(?:지금은|이제는|이젠|요즘은|요새는)[^.!?]{0,20}?(?:괜찮|나아졌|나아|편해졌|편안|살\s*만|좋아졌|견딜\s*만)/;
const STILL_SH = /지금도|아직도|여전히|요즘도|요새도|자꾸|계속|또\s*(?:그런|그래|죽)|다시\s*(?:그런|죽)/;
export function isPastResolvedSelfHarm(text: string): boolean {
  const t = (text || "").trim();
  if (!t || STILL_SH.test(t)) return false;
  const matches = SELF_HARM.flatMap((p) => [...t.matchAll(new RegExp(p.source, "g"))]);
  if (matches.length === 0) return false;
  for (const m of matches) {
    const idx = m.index ?? 0;
    // 과거형이어야 한다 — 하나라도 현재형("죽고 싶어")이면 지금의 위기다
    if (!/^(?:었|였)/.test(t.slice(idx + m[0].length, idx + m[0].length + 2))) return false;
    if (!PAST_MARKER_SH.test(t.slice(0, idx))) return false;
  }
  const end = Math.max(...matches.map((m) => (m.index ?? 0) + m[0].length));
  return NOW_RESOLVED_SH.test(t.slice(end));
}

/** 과거 해소 자살 생각에 대한 응답 — 공감 + 후속 확인(다시 그런 마음이 들면 말해 달라) + 상담 번호 한 줄 */
export function buildPastSelfHarmReply(honorific: string, companionName: string): string {
  return `${honorific}, 그때 정말 많이 힘드셨겠어요. 지금은 괜찮으시다니 ${companionName}도 마음이 놓여요. 혹시 다시 그런 마음이 드시면 혼자 견디지 마시고 꼭 ${companionName}한테나 가족분께 말씀해 주세요. 힘드실 땐 자살예방상담전화 109도 24시간 열려 있어요.`;
}

/**
 * 의료 문맥 가드 — 신체 부위 언급이 진료·검사·통증 맥락이면 성적 표현이 아니다.
 *   "가슴 사진 보여줬어"(흉부 X-ray)가 sexual로 차단되던 결함(2026-10-01 확증).
 *   이 사용자층에서 흉부 촬영·심장 검사·유방 검진은 일상 화제이므로 차단 피해가 크다.
 */
const MEDICAL_CONTEXT = /사진|엑스레이|x-?ray|씨티|CT|초음파|검사|검진|촬영|병원|의사|진료|통증|아[프파퍼]|멍울|욕창|수술|약|저리|결과/i;

/** 입력 발화 검사. 매칭되면 카테고리 반환. */
export function detectInappropriate(userText: string): ModerationResult {
  if (!userText) return { category: "ok" };
  const text = userText.trim();
  for (const p of SELF_HARM) {
    const m = text.match(p);
    if (m && !isNegatedSelfHarm(text, m)) return { category: "self_harm", matched: m[0] };
  }
  const medical = MEDICAL_CONTEXT.test(text);
  for (const p of SEXUAL_EXPLICIT) {
    if (!p.test(text)) continue;
    // 신체 부위 + 의료 맥락이면 성적 표현이 아니다 — 노골적 어휘 패턴은 이 가드를 타지 않는다.
    if (medical && /가\s*슴|엉\s*덩|허벅|다리|몸/.test(text)) continue;
    return { category: "sexual", matched: text.match(p)?.[0] };
  }
  for (const p of STRONG_PROFANITY) if (p.test(text)) return { category: "profanity", matched: text.match(p)?.[0] };
  return { category: "ok" };
}

/**
 * 단계적 거절 멘트. 같은 세션 내 동일 카테고리 N번째 발생인지에 따라 톤 조절.
 */
export function buildModerationReply(
  category: Exclude<ModerationCategory, "ok">,
  occurrence: number, // 1=첫 번째, 2이상=재발
  honorific: string,
  companionName: string,
): string {
  if (category === "self_harm") {
    return `${honorific}, 그런 말씀하시면 ${nameTopic(companionName)} 정말 마음이 아파요. 혼자 끙끙 앓지 마시고, 가족이나 보호자분께 꼭 말씀해 주세요. 도움이 정말 필요하시면 자살예방상담전화 109번이나 정신건강위기상담 1577-0199에 바로 전화하실 수 있어요. ${companionName}도 ${honorific} 걱정돼요.`;
  }

  if (category === "sexual") {
    if (occurrence <= 1) {
      const first = [
        `${honorific}, ${nameTopic(companionName)} 그런 이야기는 좀 부담스러워요. 다른 이야기 해요~`,
        `에이 ${honorific}, ${companionName} 손녀딸 같은데 그런 말씀은 좀 그렇잖아요. 다른 얘기 해요.`,
        `${honorific}, ${nameTopic(companionName)} 그런 농담은 받아드릴 수 없어요. 차라리 오늘 식사 얘기나 해요.`,
      ];
      return first[Math.floor(Math.random() * first.length)];
    }
    return `${honorific}, ${nameSubj(companionName)} 아까도 말씀드렸는데 그런 말씀은 정말 하지 말아주세요. 듣고 싶지 않아요. 다른 이야기로 넘어가요.`;
  }

  // profanity
  if (occurrence <= 1) {
    const first = [
      `${honorific}, 말씀이 좀 거치시네요. 무슨 일 있으세요?`,
      `${honorific}, ${nameTopic(companionName)} 그런 말 들으면 마음이 좀 그래요. 무슨 일이세요?`,
      `에이 ${honorific}, 화나는 일 있으세요? 차분히 말씀해주시면 ${nameSubj(companionName)} 들어드릴게요.`,
    ];
    return first[Math.floor(Math.random() * first.length)];
  }
  return `${honorific}, ${companionName}한테 그런 말씀 자꾸 하시면 속상해요. 화나신 게 있으면 그 얘기를 해주세요.`;
}
