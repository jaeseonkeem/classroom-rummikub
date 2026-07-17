const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 여러 개의 방(모둠) 상태를 담을 저장소
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

// 새로운 모둠 데이터 세팅 템플릿
function createNewRoomState() {
    return {
        players: [],
        boardGroups: [[]],
        tilePool: initDeck(),
        currentTurn: 0
    };
}

io.on('connection', (socket) => {
    let myRoom = null; // 이 소켓(학생)이 들어간 방 이름 저장용

    // 학생들이 이름과 방 번호를 가지고 입장할 때
    socket.on('joinGame', ({ name, roomId }) => {
        const roomName = `room-${roomId}`;
        myRoom = roomName;

        // 해당 모둠 방이 서버에 아직 없으면 새로 개설
        if (!rooms[roomName]) {
            rooms[roomName] = createNewRoomState();
        }

        let gameState = rooms[roomName];

        if (gameState.players.length >= 4) {
            socket.emit('errorMsg', '해당 모둠방이 가득 찼습니다. 다른 번호를 선택하세요.');
            return;
        }

        // Socket.io의 핵심 기능: 이 학생을 특정 '방구역'에 조인시킴
        socket.join(roomName);

        let hand = [];
        for (let i = 0; i < 14; i++) {
            if (gameState.tilePool.length > 0) hand.push(gameState.tilePool.pop());
        }

        gameState.players.push({ id: socket.id, name: name, hand: hand });
        
        // ★ 중요: io.to(roomName)을 써서 '같은 방'에 있는 친구들에게만 데이터 브로드캐스팅
        io.to(roomName).emit('updateGame', gameState);
    });

    socket.on('drawTile', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let player = gameState.players.find(p => p.id === socket.id);
        if (player && gameState.tilePool.length > 0) {
            player.hand.push(gameState.tilePool.pop());
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('createNewGroup', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        gameState.boardGroups.push([]);
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('moveTile', ({ tileId, toZone, groupIndex }) => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
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
        if (gameState.players.length > 0) {
            gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let gameState = rooms[myRoom];
            gameState.players = gameState.players.filter(p => p.id !== socket.id);
            
            // 모둠에 아무도 남지 않으면 메모리 확보를 위해 방 폭파
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