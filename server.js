const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let gameState = {
    players: [],
    boardGroups: [[]], // 타일 묶음들을 담는 2차원 배열
    tilePool: [],
    currentTurn: 0
};

// [조커 부활] 1~13 타일 4색 2세트 + 조커 2장 (총 106장) 생성
function initDeck() {
    const colors = ['red', 'blue', 'yellow', 'black'];
    let pool = [];
    for (let i = 0; i < 2; i++) {
        colors.forEach(color => {
            for (let num = 1; num <= 13; num++) {
                pool.push({ id: `tile-${color}-${num}-${i}`, color: color, number: num, isJoker: false });
            }
        });
    }
    // 조커 2장 다시 투입
    pool.push({ id: 'joker-1', color: 'joker', number: 'J', isJoker: true });
    pool.push({ id: 'joker-2', color: 'joker', number: 'J', isJoker: true });
    
    return pool.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        if (gameState.players.length >= 4) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }
        if (gameState.players.length === 0) {
            gameState.tilePool = initDeck();
            gameState.boardGroups = [[]];
        }

        let hand = [];
        for (let i = 0; i < 14; i++) {
            if (gameState.tilePool.length > 0) hand.push(gameState.tilePool.pop());
        }

        gameState.players.push({ id: socket.id, name: name, hand: hand });
        io.emit('updateGame', gameState);
    });

    socket.on('drawTile', () => {
        let player = gameState.players.find(p => p.id === socket.id);
        if (player && gameState.tilePool.length > 0) {
            player.hand.push(gameState.tilePool.pop());
            io.emit('updateGame', gameState);
        }
    });

    socket.on('createNewGroup', () => {
        gameState.boardGroups.push([]);
        io.emit('updateGame', gameState);
    });

    // 양방향 및 그룹별 타일 이동 로직
    socket.on('moveTile', ({ tileId, toZone, groupIndex }) => {
        let player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        let targetTile = null;

        // 1. 기존 위치에서 타일 찾아서 제거하기
        let handIdx = player.hand.findIndex(t => t.id === tileId);
        if (handIdx !== -1) {
            targetTile = player.hand.splice(handIdx, 1)[0];
        } else {
            for (let i = 0; i < gameState.boardGroups.length; i++) {
                let boardIdx = gameState.boardGroups[i].findIndex(t => t.id === tileId);
                if (boardIdx !== -1) {
                    targetTile = gameState.boardGroups[i].splice(boardIdx, 1)[0];
                    break;
                }
            }
        }

        if (!targetTile) return;

        // 2. 목적지에 타일 집어넣기
        if (toZone === 'hand') {
            player.hand.push(targetTile);
        } else if (toZone === 'board') {
            let gIdx = parseInt(groupIndex) || 0;
            while (gameState.boardGroups.length <= gIdx) {
                gameState.boardGroups.push([]);
            }
            gameState.boardGroups[gIdx].push(targetTile);
        }

        // 빈 그룹 정리
        gameState.boardGroups = gameState.boardGroups.filter((g, idx) => g.length > 0 || idx === 0);
        if (gameState.boardGroups.length === 0) gameState.boardGroups.push([]);

        io.emit('updateGame', gameState);
    });

    socket.on('endTurn', () => {
        if (gameState.players.length > 0) {
            gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
            io.emit('updateGame', gameState);
        }
    });

    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        if (gameState.players.length === 0) {
            gameState.boardGroups = [[]];
        }
        io.emit('updateGame', gameState);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 구동 중... 포트: ${PORT}`); });