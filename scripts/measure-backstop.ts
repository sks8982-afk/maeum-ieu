/**
 * 백스톱 발화율·지연 실측 (A) — 실제 user 발화 로그 대상.
 *   - 발화율: 정규식 L2 미만(none·L1) + 사전필터 통과(=백스톱 호출)가 전체 user 발화의 몇 %인지, before/after 비교
 *   - 지연: 실제 트리거되는 발화 일부에 detectEmergencyLLM을 호출해 왕복 시간 측정
 * 실행: npx tsx scripts/measure-backstop.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { detectEmergency } from "../lib/chat/emergency";
import { detectEmergencyLLM, passesBackstopPrefilter } from "../lib/chat/emergency-llm";

// 변경 전(a0f7f87) 트리거 — 발화율 절감 효과 비교용
const OLD_SOFT = /약|수면제|죽|자살|목(?:이라도|을|에)?\s*[매졸]|매달|올가미|끈\s|뛰어내|투신|번개탄|연탄|손목|그어|칼\s*[들로써맞]|면도날|동맥|자해|목숨|세상\s*[뜨떠]|저\s*세상|먼저\s*[가갈]|따라\s*[가갈]|곁으로|조용히\s*[가갈떠]|떠날|떠나려|떠나야|하직|없어야|없으면\s*(?:편|낫|좋)|나\s*없으면|가\s*[뿌뿔삐불]|살\s*맛|폐[\s가-힣]{0,4}끼|짐\s*(?:만|이|덩)|그만\s*살|살기\s*(?:가|를)?\s*싫|사라[지져]|짐[\s가-힣]{0,6}정리|빠져\s*주|살아야\s*할\s*(?:까닭|이유)|살아갈\s*(?:이유|까닭)|살\s*(?:까닭|이유)\s*(?:가|이)?\s*없|살아서\s*[뭐뭣]|마지막일|잘\s*있으[란라]|이만\s*[가갈]|이만\s*정리|나눠\s*[줬줄주]|갈\s*때가\s*[됐되왔]|잘\s*지내[라요]|그동안\s*고마|더는\s*안\s*[봐볼]|없어졌으면|없어져|없어지고|눈\s*감|눈\s*안\s*[뜨떠떴]|안\s*깨|깨어나|영원|편하게\s*[가갈]|편히\s*[가갈]|(?:죽는|가는|편한)\s*방법|고통\s*없이|갈\s*수\s*있는\s*방법|끝내|끝장|못\s*견디|고통스러|모[아았]|털어|들이[켜키]|삼[키켜켰]|먹어버|먹어불|입에\s*[넣털]|두\s*번|두\s*알|세\s*알|한\s*알|또\s*먹|또\s*한\s*번|한\s*번\s*더|안\s*먹은\s*줄|섞어|헷갈|착각|움큼|한\s*통|숨|가슴|쓰러|넘어|미끄러|자빠|나자빠|삐끗|엎어|고꾸라|못\s*일어|일어나지\s*(?:를\s*)?못|일어날\s*수가?\s*없|주저앉|폭삭|허리를?\s*못\s*[쓰써]|피[가\s]|출혈|어지|핑\s*도|식은\s*땀|손\s*(?:이|을)?\s*떨|떨려|떨린|마비|경련|발작|거품|뻣뻣|떨면서|경기들|의식|정신이\s*[흐혼아가]|캄캄|아득|가물가물|혼미|안\s*올라가|헛나|어눌|혀\s*꼬|부들부들|벌벌\s*떨|덜덜\s*떨|거품\s*물|까무러|까무라|기절|혼절|삐[뚤뚜]|비뚤|감각\s*(?:이|도)?\s*(?:없|둔)|(?:한|왼|오른|반)\s*[쪽짝편]\s*(?:팔|다리|손|발|몸|얼굴|눈|입)|반신\s*마|기운\s*(?:이|을)?\s*(?:없|빠)|기력|당뇨|혈압|토[하해]|구역|메스|데[였여어]|화상|끓는|뜨거운\s*물|물집|살갗|부러|골절|삐[었어]|쥐\s*나|저[려린릿]|열이\s*(?:나|많|펄)|힘들|외로|혼자|괴로|우울|허전|보고\s*싶|그립|눈물/;

const pct = (n: number, d: number) => d === 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`;

async function main() {
  const rows = await prisma.message.findMany({
    where: { role: "user" },
    select: { content: true },
  });
  const msgs = rows.map(r => (r.content || "").trim()).filter(t => t.length > 0);
  const total = msgs.length;

  let regexCaught = 0;     // fast 정규식이 직접 잡음(level≥2) — 백스톱 불필요
  let fireNew = 0;          // 현재: 정규식 L2 미만(none·L1, 2026-10-19부터) + 새 트리거 → 백스톱 호출
  let fireOld = 0;          // 이전: 정규식 L2 미만 + 옛 트리거 → 백스톱 호출
  const newlyFiring: string[] = [];   // 새로 트리거되는 발화(샘플)
  const dropped: string[] = [];       // 옛날엔 트리거됐으나 이제 skip되는 발화(샘플)

  for (const t of msgs) {
    const lvl = detectEmergency(t).level;
    if (lvl >= 2) { regexCaught++; continue; }
    const oldHit = OLD_SOFT.test(t);
    const newHit = passesBackstopPrefilter(t); // 운영(detectEmergencyLLM)과 같은 사전필터 — SOFT_SIGNAL + 화상 말(2026-10-23)
    if (newHit) { fireNew++; if (newlyFiring.length < 6) newlyFiring.push(t); }
    if (oldHit) fireOld++;
    if (oldHit && !newHit && dropped.length < 12) dropped.push(t);
  }

  console.log(`\n===== 백스톱 발화율 (실제 user 발화 ${total}건) =====`);
  console.log(`fast 정규식 직접 감지(백스톱 불필요): ${regexCaught} (${pct(regexCaught, total)})`);
  console.log(`백스톱 호출 — 변경 전(옛 트리거): ${fireOld} (${pct(fireOld, total)})`);
  console.log(`백스톱 호출 — 변경 후(현 트리거): ${fireNew} (${pct(fireNew, total)})`);
  console.log(`→ 백스톱 호출 절감: ${fireOld - fireNew}건 (${pct(fireOld - fireNew, fireOld || 1)} 감소)`);

  console.log(`\n── 이제 skip되는(옛날엔 백스톱 불렀던) 일상 발화 샘플 ──`);
  dropped.forEach(t => console.log(`  · ${t.slice(0, 40)}`));

  console.log(`\n── 여전히 백스톱 호출되는 발화 샘플 ──`);
  newlyFiring.forEach(t => console.log(`  ! ${t.slice(0, 40)}`));

  // 실제 백스톱 지연 측정(최대 5건)
  const latencySamples = newlyFiring.slice(0, 5);
  if (latencySamples.length && process.env.GEMINI_API_KEY) {
    console.log(`\n===== 백스톱 실제 지연(왕복) — ${latencySamples.length}건 =====`);
    const times: number[] = [];
    for (const t of latencySamples) {
      const s = Date.now();
      const r = await detectEmergencyLLM(t);
      const ms = Date.now() - s;
      times.push(ms);
      console.log(`  ${ms}ms → ${r ? `${r.category} L${r.level}` : "none"} | ${t.slice(0, 28)}`);
    }
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(`  평균 ${avg}ms (이 지연은 위험-의심 발화에서만 발생)`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
