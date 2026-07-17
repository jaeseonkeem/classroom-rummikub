// Node.js 프로젝트 시작 전 필요 패키지 설치: npm install express socket.io
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } // 학급 내 다양한 기기 접속 허용
});

let gameState = {
    players: [],     // 접속한 플레이어 목록 (최대 4명)
    boardTiles: [],  // 공용 보드에 놓인 타일들
    tilePool: [],    // 남아있는 타일 더미
    currentTurn: 0   // 현재 차례인 플레이어 인덱스
};

// 106장 루미큐브 덱 생성 및 셔플 함수
function initDeck() {
    const colors = ['red', 'blue', 'yellow', 'black'];
    let pool = [];
    for (let i = 0; i < 2; i++) {
        colors.forEach(color => {
            for (let num = 1; num <= 13; num++) {
                pool.push({ id: `tile-${color}-${num}-${i}`, color: color, number: num });
            }
        });
    }
    pool.push({ id: 'joker-1', color: 'joker', number: 'J' });
    pool.push({ id: 'joker-2', color: 'joker', number: 'J' });
    return pool.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    console.log(`유저 접속: ${socket.id}`);

    // 1. 플레이어 게임 참여
    socket.on('joinGame', (name) => {
        if (gameState.players.length >= 4) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }

        // 게임이 처음 시작될 때만 덱 초기화
        if (gameState.players.length === 0) {
            gameState.tilePool = initDeck();
            gameState.boardTiles = [];
        }

        // 새 플레이어에게 14장 나눠주기
        let hand = [];
        for (let i = 0; i < 14; i++) {
            if (gameState.tilePool.length > 0) hand.push(gameState.tilePool.pop());
        }

        gameState.players.push({
            id: socket.id,
            name: name,
            hand: hand
        });

        // 모든 사람에게 갱신된 게임 상태 전송
        io.emit('updateGame', gameState);
    });

    // 2. 누군가 타일을 보드로 드롭했을 때 동기화
    socket.on('moveTileToBoard', ({ tileId }) => {
        let player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        // 플레이어 손패에서 타일 찾아서 제거 후 보드로 이동
        const tileIndex = player.hand.findIndex(t => t.id === tileId);
        if (tileIndex !== -1) {
            const tile = player.hand.splice(tileIndex, 1)[0];
            gameState.boardTiles.push(tile);
            
            // 모든 플레이어에게 화면 갱신 신호 발송
            io.emit('updateGame', gameState);
        }
    });

    // 3. 턴 넘기기
    socket.on('endTurn', () => {
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.emit('updateGame', gameState);
    });

    // 4. 접속 종료 처리
    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        if (gameState.players.length === 0) {
            gameState.boardTiles = [];
        }
        io.emit('updateGame', gameState);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`루미큐브 학급 서버가 ${PORT}번 포트에서 구동 중입니다...`);
});