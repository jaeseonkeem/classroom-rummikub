const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let rooms = {};

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
    pool.push({ id: 'joker-1', color: 'joker', number: 'J', isJoker: true });
    pool.push({ id: 'joker-2', color: 'joker', number: 'J', isJoker: true });
    return pool.sort(() => Math.random() - 0.5);
}

function createNewRoomState() {
    return {
        players: [],
        boardGroups: [[]],
        tilePool: initDeck(),
        currentTurn: 0,
        status: 'waiting' // waiting(대기중) 또는 playing(게임중)
    };
}

io.on('connection', (socket) => {
    let myRoom = null;

    socket.on('joinGame', ({ name, roomId }) => {
        const roomName = `room-${roomId}`;
        myRoom = roomName;

        if (!rooms[roomName]) {
            rooms[roomName] = createNewRoomState();
        }

        let gameState = rooms[roomName];

        if (gameState.status === 'playing') {
            socket.emit('errorMsg', '이미 게임이 시작된 모둠방입니다.');
            return;
        }

        if (gameState.players.length >= 4) {
            socket.emit('errorMsg', '해당 모둠방이 가득 찼습니다.');
            return;
        }

        socket.join(roomName);
        
        // 대기실 입장 시에는 패를 주지 않고 유저 정보만 등록
        gameState.players.push({ id: socket.id, name: name, hand: [] });
        io.to(roomName).emit('updateGame', gameState);
    });

    // [룰 1] 방장의 게임 시작 요청 처리
    socket.on('gameStart', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];

        // 가장 먼저 들어온 방장만 시작 가능무
        if (gameState.players[0].id !== socket.id) return;

        if (gameState.status === 'waiting') {
            gameState.status = 'playing';
            gameState.tilePool = initDeck(); // 시작할 때 덱 셔플
            gameState.boardGroups = [[]];

            // 모든 참여자에게 14장씩 카드 배분
            gameState.players.forEach(player => {
                player.hand = [];
                for (let i = 0; i < 14; i++) {
                    if (gameState.tilePool.length > 0) player.hand.push(gameState.tilePool.pop());
                }
            });

            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('drawTile', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        
        // 내 턴 제어 검증
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('errorMsg', '내 차례가 아닙니다!');
            return;
        }

        let player = gameState.players.find(p => p.id === socket.id);
        if (player && gameState.tilePool.length > 0) {
            player.hand.push(gameState.tilePool.pop());
            // 타일을 한 장 뽑으면 자동으로 턴을 넘겨 루미큐브 룰 적용
            gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('createNewGroup', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('errorMsg', '내 차례가 아닙니다!');
            return;
        }

        gameState.boardGroups.push([]);
        io.to(myRoom).emit('updateGame', gameState);
    });

    // [룰 2] 내 턴일 때만 타일 이동 조작 허용
    socket.on('moveTile', ({ tileId, toZone, groupIndex }) => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        
        // 현재 차례인 사람의 ID가 내 ID와 다르면 조작 차단
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id || gameState.status !== 'playing') {
            socket.emit('errorMsg', '내 차례가 아닙니다! 타일을 움직일 수 없습니다.');
            return;
        }

        let player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        let targetTile = null;

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

        if (toZone === 'hand') {
            player.hand.push(targetTile);
        } else if (toZone === 'board') {
            let gIdx = parseInt(groupIndex) || 0;
            while (gameState.boardGroups.length <= gIdx) {
                gameState.boardGroups.push([]);
            }
            gameState.boardGroups[gIdx].push(targetTile);
        }

        gameState.boardGroups = gameState.boardGroups.filter((g, idx) => g.length > 0 || idx === 0);
        if (gameState.boardGroups.length === 0) gameState.boardGroups.push([]);

        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('endTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('errorMsg', '내 차례가 아닙니다!');
            return;
        }

        if (gameState.players.length > 0) {
            gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let gameState = rooms[myRoom];
            gameState.players = gameState.players.filter(p => p.id !== socket.id);
            if (gameState.players.length === 0) {
                delete rooms[myRoom];
            } else {
                io.to(myRoom).emit('updateGame', gameState);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`멀티 모둠 서버 구동 중... 포트: ${PORT}`); });