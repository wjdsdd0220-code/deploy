import fs from 'fs';
import path from 'path';
import type { InternalPlayer } from '@zeteo/shared-types';
import { RoomInternalState } from './room';
import { tallyBotVoteResults } from './vote';

// 배포 환경(Railway 등)은 컨테이너를 새로 만들 때마다 파일 시스템이 초기화된다.
// 따라서 파일은 로컬에서 바로 확인하는 용도이고, 실제 보관은 웹훅 전송이 담당한다.
// 둘 중 하나가 실패해도 나머지는 진행되도록 서로 독립적으로 처리한다.
const LOG_DIR = process.env.LOG_DIR ?? path.join(__dirname, '../logs');
const WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;

/**
 * 로그가 기준으로 삼는 참가자 명단.
 * 살아있는 room.players 는 설문을 낸 사람부터 하나씩 빠져나가므로,
 * result 진입 때 찍어둔 사본이 있으면 그쪽을 쓴다.
 */
function rosterOf(room: RoomInternalState): InternalPlayer[] {
  return room.finalPlayers ?? room.players;
}

/** 서버 전용 표기. isBot/role 은 클라이언트로 절대 안 나가지만 복기하려면 필요하다. */
function describeSpeaker(room: RoomInternalState, id: string): string {
  if (id === 'system') return '[시스템]';
  const p = rosterOf(room).find((pl) => pl.id === id);
  if (!p) return id;
  const tags = [p.label, p.isBot ? '봇' : null, p.role === 'liar' ? '라이어' : null].filter(
    Boolean,
  );
  return `${p.name}(${tags.join(' · ')})`;
}

// ko-KR 로케일은 "10시 31분 35초"로 풀어써서 표가 넓어진다. 로그는 en-GB(24시간 콜론)가 읽기 편하다.
const hhmmss = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });
const escapeCell = (s: string) => s.replace(/\|/g, '\\|');

/** 한 판 전체를 마크다운 한 장으로. 대화와 설문이 한 파일에 있어야 나중에 짝을 맞출 필요가 없다. */
export function buildGameLog(room: RoomInternalState): string {
  const roster = rosterOf(room);
  const bot = roster.find((p) => p.isBot);
  const liar = roster.find((p) => p.role === 'liar');
  const hits = tallyBotVoteResults(room);
  const humans = roster.filter((p) => !p.isBot);
  const hitCount = Object.values(hits).filter(Boolean).length;

  const lines: string[] = [
    `# [${room.roomId}] 게임 로그`,
    '',
    `- 시작: ${new Date(room.createdAt).toLocaleString('ko-KR')}`,
    `- 주제: ${room.category} / 제시어: ${room.word}`,
    `- 봇: ${bot ? describeSpeaker(room, bot.id) : '없음'}`,
    `- 라이어: ${liar ? describeSpeaker(room, liar.id) : '없음'}`,
    `- 라이어게임 결과: ${room.liarGameResult ?? '미확정'}`,
    `- 봇 적중: ${hitCount} / ${humans.length}`,
    `- 총 라운드: ${room.round}`,
    '',
    '## 대화',
    '',
    '| 시간 | 단계 | 발언자 | 내용 |',
    '|---|---|---|---|',
    ...room.messages.map(
      (m) =>
        `| ${hhmmss(m.at)} | ${m.phase} | ${describeSpeaker(room, m.speakerId)} | ${escapeCell(m.text)} |`,
    ),
    '',
    '## 봇 지목',
    '',
    '| 투표자 | 지목 | 적중 |',
    '|---|---|---|',
    ...Object.entries(room.botVotes).map(([voterId, targetId]) => {
      const target = roster.find((p) => p.id === targetId);
      return `| ${describeSpeaker(room, voterId)} | ${target?.label ?? targetId} | ${target?.isBot ? 'O' : 'X'} |`;
    }),
    '',
    '## 설문 응답',
    '',
  ];

  if (room.surveys.length === 0) {
    lines.push('_응답 없음_');
  } else {
    lines.push('| 응답자 | 선택한 이유(id) | 자유 서술 |', '|---|---|---|');
    for (const s of room.surveys) {
      lines.push(
        `| ${describeSpeaker(room, s.playerId)} | ${s.reasonIds.join(', ') || '-'} | ${escapeCell(s.freeText) || '-'} |`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

function saveToFile(room: RoomInternalState, markdown: string): string | null {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(LOG_DIR, `${room.roomId}_${stamp}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    console.log(`[${room.roomId}] 로그 파일 저장: ${file}`);
    return file;
  } catch (e) {
    console.error(`[${room.roomId}] 로그 파일 저장 실패:`, e);
    return null;
  }
}

async function sendToWebhook(room: RoomInternalState, markdown: string): Promise<void> {
  if (!WEBHOOK_URL) {
    console.warn(`[${room.roomId}] LOG_WEBHOOK_URL 미설정 — 웹훅 전송 건너뜀`);
    return;
  }

  const roster = rosterOf(room);
  const bot = roster.find((p) => p.isBot);
  const hitCount = Object.values(tallyBotVoteResults(room)).filter(Boolean).length;
  const humanCount = roster.filter((p) => !p.isBot).length;
  const summary = [
    `**[${room.roomId}]** 종료 · ${roster.length}인 · ${room.round}라운드`,
    `주제 ${room.category} / 제시어 ${room.word}`,
    `봇 ${bot?.label ?? '?'} · 결과 ${room.liarGameResult ?? '미확정'} · 봇 적중 ${hitCount}/${humanCount} · 설문 ${room.surveys.length}건`,
  ].join('\n');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'Zeteo 로그', content: summary }));
  form.append(
    'file',
    new Blob([markdown], { type: 'text/markdown' }),
    `${room.roomId}_${stamp}.md`,
  );

  try {
    const res = await fetch(WEBHOOK_URL, { method: 'POST', body: form });
    if (!res.ok) {
      // 웹훅이 유일한 영구 보관처라, 실패하면 최소한 콘솔에는 전문을 남겨 복구 가능하게 한다.
      console.error(`[${room.roomId}] 웹훅 전송 실패 (HTTP ${res.status})`);
      console.error(markdown);
      return;
    }
    console.log(`[${room.roomId}] 웹훅 전송 완료`);
  } catch (e) {
    console.error(`[${room.roomId}] 웹훅 전송 오류:`, e);
    console.error(markdown);
  }
}

/**
 * 한 판을 마무리하고 로그를 내보낸다.
 * 설문은 사람마다 따로 도착하므로 result 진입 시점이 아니라
 * "더 이상 응답이 오지 않는 시점"(전원 제출 또는 마지막 퇴장)에 호출한다.
 */
export function exportGameLog(room: RoomInternalState): void {
  if (room.exported) return; // 마지막 퇴장과 전원 제출이 겹칠 수 있어 한 번만
  room.exported = true;

  const markdown = buildGameLog(room);

  console.log(`\n===== [${room.roomId}] 게임 로그 =====`);
  console.log(markdown);
  console.log(`===== [${room.roomId}] 끝 =====\n`);

  saveToFile(room, markdown);
  void sendToWebhook(room, markdown); // 전송을 기다리느라 게임 흐름을 막지 않는다
}
