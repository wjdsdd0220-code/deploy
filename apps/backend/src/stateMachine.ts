import { Phase } from '@zeteo/shared-types';
import { RoomInternalState, pushSystemMessage } from './room';
import { tallyDebateVotes, tallyLifeVote } from './vote';

type Transition = (room: RoomInternalState) => Phase;

const transitions: Record<Phase, Transition> = {
  lobby: () => 'roleReveal',

  roleReveal: () => 'describe',

   describe: (room) => {
    pushSystemMessage(room, '묘사가 모두 끝났습니다. 토론을 시작합니다.');
    return 'debate';
  },

  debate: (room) => {
    const { accusedId, tie } = tallyDebateVotes(room);

    // 무투표를 동점과 같이 다룬다.
    //
    // 원래는 무지목이면 "라이어 승"을 예약하고 곧장 botVote 로 보냈다. 그 규칙은 토론이
    // 120초일 때 성립했다 — 2분을 다 쓰고도 아무도 지목하지 않았다면 그건 참가자들의
    // 판단이라고 볼 수 있었다. 토론을 60초로 줄인 뒤로는 같은 상태가 "아직 못 했다"를
    // 뜻하게 됐는데, 코드가 그 둘을 구분할 방법이 없다(둘 다 votes 가 비어 있을 뿐이다).
    // 구분할 수 없으면 판을 끝내버리는 쪽보다 한 번 더 돌리는 쪽이 덜 틀린다.
    //
    // 봇이 제한시간 안에 표를 못 던지는 경우도 여기서 같이 걷힌다 — 봇은 매 사이클
    // 확률로 발언과 투표 중 하나를 고르므로(bot/index.ts) 시간이 짧으면 기권으로 끝날 수
    // 있는데, 그 판이 라이어 승으로 처리되지 않는다.
    if (tie || !accusedId) {
      room.round += 1;
      room.votes = {};
      pushSystemMessage(room, '동점입니다. 재투표를 시작합니다.');
      // 화면 문구는 같아도 로그는 갈라둔다 — 표가 갈린 것과 아예 안 들어온 것은
      // 원인이 달라서, 재투표가 잦을 때 어느 쪽인지 알아야 손볼 곳을 찾는다.
      console.log(
        `[${room.roomId}] ${tie ? '동점 발생' : '무투표'} → 전원 재투표 (round ${room.round})`,
      );
      return 'debate';
    }

    room.accusedId = accusedId;

    const accused = room.players.find((p) => p.id === accusedId);
    pushSystemMessage(room, `${accused?.label ?? '누군가'}님이 최다 득표로 지목되었습니다.`);

    return 'finalDefense';
  },

  finalDefense: () => 'lifeVote',

  lifeVote: (room) => {
    const kill = tallyLifeVote(room);

    if (kill) {
      // reveal "진입" 시점에 확정해야 한다 — 이 전이 함수가 끝나면 곧바로 phase가
      // 'reveal'로 바뀌므로, 여기서 채우는 게 곧 진입 시점 세팅이다. reveal 전이 함수
      // 안에서 채우면 그건 reveal을 "나갈 때"(타이머 만료 시점)라서 3초 내내
      // revealedRole이 null로 보이는 문제가 있었다.
      const accused = room.players.find((p) => p.id === room.accusedId);
      if (accused) {
        accused.isAlive = false; // ★ 처형 확정
        room.revealedRole = accused.role; // ★ 역할 공개
      }
      return 'reveal';
    }

    // 살린다 선택 → 횟수 제한 없이 매번 debate로 복귀
    const accused = room.players.find((p) => p.id === room.accusedId);
    pushSystemMessage(room, `${accused?.label ?? '누군가'}님이 살아남았습니다. 토론을 재개합니다.`);

    room.accusedId = null;
    room.votes = {};
    room.lifeVotes = {};
    room.lifeVoteDecided = false;
    room.round += 1;
    room.turnOrder = [];
    room.currentTurnIndex = 0;
    console.log(`[${room.roomId}] 살린다 선택 → debate로 복귀 (round ${room.round})`);
    return 'debate';
  },

  reveal: (room) => {
    // isAlive/revealedRole은 lifeVote → reveal 전이 시점에 이미 채워졌다 (위 참고).

    // 정체 공개 시점엔 승패 미확정 — 라이어를 잡아도 제시어 추측 기회가 남아있다.
    // 게다가 여기서 바로 liarGameResult를 채우면 "결과가 곧장 뜨는지 여부" 자체가
    // 라이어를 잡았는지 아닌지의 스포일러가 된다. 그래서 pendingLiarGameResult에만
    // 예약해두고, 실제 liarGameResult는 result 진입 직전(botVote → result)에만 채운다.
    if (room.revealedRole === 'liar') {
      return 'guessWord';
    }

    room.pendingLiarGameResult = 'liarWin'; // ★ 시민이 처형됨 → 라이어 승
    return 'botVote';
  },

  guessWord: () => 'botVote',
  // 실제 정답 판정(pendingLiarGameResult 설정)은 index.ts의 case "guessWord"에서 처리
  // (제출된 단어를 알아야 판정 가능하므로 여기서는 못 한다)

  botVote: (room) => {
    // result "진입" 직전 — 그동안 예약해둔 pendingLiarGameResult를 여기서만 공개용
    // liarGameResult로 확정한다. 그 전(reveal/guessWord/botVote)까지는 항상 null이다.
    room.liarGameResult = room.pendingLiarGameResult;
    return 'result';
  },

  result: () => 'survey',

  // result에서 넘어온 뒤 survey에 계속 머무는 자기 자신으로의 전이.
  // nextPhase가 survey 단계에서 다시 호출될 일은 없지만(설문 제출은 index.ts의
  // case "survey"가 advancePhase 없이 처리), Record<Phase, Transition> 타입이
  // 모든 Phase 키를 요구하므로 이 항목 자체는 지울 수 없다.
  survey: () => 'survey',
};

export function nextPhase(room: RoomInternalState) {
  const transition = transitions[room.phase];
  room.phase = transition(room);
  console.log(`[${room.roomId}] phase → ${room.phase}`);
}
