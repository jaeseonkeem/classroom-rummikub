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
        status: 'waiting'
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

        if (gameState.status === 'playing' || gameState.players.length >= 4) {
            socket.emit('errorMsg', '입장할 수 없습니다.');
            return;
        }

        socket.join(roomName);
        // turnSubmittedTiles: 한 턴 동안 낸 타일들을 추적하여 등록 계산에 활용
        gameState.players.push({ 
            id: socket.id, 
            name: name, 
            hand: [], 
            isMeldDone: false, 
            turnSubmittedTiles: [] 
        });
        io.to(roomName).emit('updateGame', gameState);
    });

    socket.on('gameStart', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        if (gameState.players[0].id !== socket.id) return;

        if (gameState.status === 'waiting') {
            gameState.status = 'playing';
            gameState.tilePool = initDeck();
            gameState.boardGroups = [[]];

            gameState.players.forEach(player => {
                player.hand = [];
                player.isMeldDone = false;
                player.turnSubmittedTiles = [];
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
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        // 패를 뽑으면 이번 턴에 필드에 임시로 냈던 타일이 있다면 패로 강제 회수
        if (currentPlayer.turnSubmittedTiles.length > 0) {
            currentPlayer.turnSubmittedTiles.forEach(tile => {
                // 공용 보드에서 제거
                for (let i = 0; i < gameState.boardGroups.length; i++) {
                    let idx = gameState.boardGroups[i].findIndex(t => t.id === tile.id);
                    if (idx !== -1) {
                        gameState.boardGroups[i].splice(idx, 1);
                        break;
                    }
                }
                currentPlayer.hand.push(tile);
            });
            currentPlayer.turnSubmittedTiles = [];
        }

        if (gameState.tilePool.length > 0) {
            currentPlayer.hand.push(gameState.tilePool.pop());
        }
        
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('createNewGroup', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        gameState.boardGroups.push([]);
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('moveTile', ({ tileId, toZone, groupIndex }) => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id || gameState.status !== 'playing') return;

        let targetTile = null;
        let isComingFromHand = false;

        // 1. 기존 위치에서 서칭 및 제거
        let handIdx = currentPlayer.hand.findIndex(t => t.id === tileId);
        if (handIdx !== -1) {
            targetTile = currentPlayer.hand.splice(handIdx, 1)[0];
            isComingFromHand = true;
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

        // [등록 검증 설계] 첫 등록 전에는 남의 카드나 이미 놓인 카드를 마음대로 빼올 수 없음
        if (!isComingFromHand && !currentPlayer.isMeldDone && toZone === 'hand') {
            let submittedIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (submittedIdx === -1) {
                // 이번 턴에 자기가 낸 게 아니라 기존에 있던 타일이면 회수 불가
                socket.emit('errorMsg', '첫 등록 전에는 보드에 기존에 있던 타일을 가져올 수 없습니다!');
                // 원상복구
                let gIdx = parseInt(groupIndex) || 0;
                gameState.boardGroups[gIdx].push(targetTile);
                io.to(myRoom).emit('updateGame', gameState);
                return;
            }
        }

        // 2. 목적지 배치 및 턴 제출 목록 업데이트
        if (toZone === 'hand') {
            playerHandIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (playerHandIdx !== -1) currentPlayer.turnSubmittedTiles.splice(playerHandIdx, 1);
            currentPlayer.hand.push(targetTile);
        } else if (toZone === 'board') {
            if (isComingFromHand) {
                currentPlayer.turnSubmittedTiles.push(targetTile);
            }
            let gIdx = parseInt(groupIndex) || 0;
            while (gameState.boardGroups.length <= gIdx) gameState.boardGroups.push([]);
            gameState.boardGroups[gIdx].push(targetTile);
        }

        gameState.boardGroups = gameState.boardGroups.filter((g, idx) => g.length > 0 || idx === 0);
        if (gameState.boardGroups.length === 0) gameState.boardGroups.push([]);

        io.to(myRoom).emit('updateGame', gameState);
    });

    // 턴 마치기 버튼 누를 시 등록 점수(30점) 계산
    socket.on('endTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        // 카드를 한 장도 안 내고 턴을 마치려고 하면 패널티 안내
        if (currentPlayer.turnSubmittedTiles.length === 0) {
            socket.emit('errorMsg', '타일을 내지 않았다면 [타일 1장 뽑기]를 눌러 차례를 넘기세요.');
            return;
        }

        // [등록 30점 룰 검증 가드]
        if (!currentPlayer.isMeldDone) {
            let scoreSum = 0;
            currentPlayer.turnSubmittedTiles.forEach(t => {
                scoreSum += t.isJoker ? 10 : t.number; // 조커는 일단 10점으로 기본 환산
            });

            if (scoreSum < 30) {
                socket.emit('errorMsg', `첫 등록은 내신 타일의 숫자 합이 30점 이상이어야 합니다! (현재 제출 합: ${scoreSum}점) 내신 타일이 모두 회수됩니다.`);
                
                // 보드에서 임시 제출 타일 모두 롤백
                currentPlayer.turnSubmittedTiles.forEach(tile => {
                    for (let i = 0; i < gameState.boardGroups.length; i++) {
                        let idx = gameState.boardGroups[i].findIndex(t => t.id === tile.id);
                        if (idx !== -1) {
                            gameState.boardGroups[i].splice(idx, 1);
                            break;
                        }
                    }
                    currentPlayer.hand.push(tile);
                });
                currentPlayer.turnSubmittedTiles = [];
                gameState.boardGroups = gameState.boardGroups.filter((g, idx) => g.length > 0 || idx === 0);
                if (gameState.boardGroups.length === 0) gameState.boardGroups.push([]);
                
                io.to(myRoom).emit('updateGame', gameState);
                return;
            } else {
                // 30점 통과 시 파란 딱지(등록 완료) 부여
                currentPlayer.isMeldDone = true;
            }
        }

        // 정상 턴 종료 시 임시 추적 초기화 후 턴 교체
        currentPlayer.turnSubmittedTiles = [];
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
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
http.listen(PORT, () => { console.log(`서버 작동 중: ${PORT}`); });