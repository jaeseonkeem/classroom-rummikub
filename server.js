const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let rooms = {};

// 106장 덱 빌드 함수 (조커 2장 다시 고정 반영)
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
        status: 'waiting',
        backupBoard: null
    };
}

function isBoardValid(boardGroups) {
    const activeGroups = boardGroups.filter(g => g.length > 0);
    if (activeGroups.length === 0) return true;

    for (let group of activeGroups) {
        if (!validateGroup(group) && !validateRun(group)) return false;
    }
    return true;
}

function validateGroup(tiles) {
    if (tiles.length < 3 || tiles.length > 4) return false;
    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true;
    const targetNum = regularTiles[0].number;
    const colors = new Set();
    for (let t of regularTiles) {
        if (t.number !== targetNum) return false;
        if (colors.has(t.color)) return false;
        colors.add(t.color);
    }
    return true;
}

function validateRun(tiles) {
    if (tiles.length < 3) return false;
    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true;
    const targetColor = regularTiles[0].color;
    if (regularTiles.some(t => t.color !== targetColor)) return false;
    return checkRunWithJokers(tiles.map(t => t.isJoker ? 'J' : t.number));
}

function checkRunWithJokers(arr) {
    let jokersCount = arr.filter(v => v === 'J').length;
    let nums = arr.filter(v => v !== 'J').sort((a, b) => a - b);
    for(let i=0; i<nums.length-1; i++) {
        if(nums[i] === nums[i+1]) return false;
    }
    let diff = nums[nums.length - 1] - nums[0];
    let neededJokers = diff - (nums.length - 1);
    if (neededJokers <= jokersCount) {
        let totalLength = nums.length + jokersCount;
        if (totalLength <= 13) return true;
    }
    return false;
}

io.on('connection', (socket) => {
    let myRoom = null;
    let myName = null;

    socket.on('joinGame', ({ name, roomId }) => {
        // [수정] 10번 제한 없이 룸 넘버 자유 보장
        const roomName = `room-${roomId}`;
        myRoom = roomName;
        myName = name;

        if (!rooms[roomName]) rooms[roomName] = createNewRoomState();
        let gameState = rooms[roomName];

        socket.join(roomName);

        let existingPlayer = gameState.players.find(p => p.name === name);

        if (existingPlayer) {
            existingPlayer.id = socket.id;
            console.log(`[Reconnection] ${name} -> Room: ${roomId}`);
        } else {
            if (gameState.status === 'playing' || gameState.players.length >= 4) {
                socket.emit('errorMsg', '게임이 이미 진행 중이거나 모둠이 꽉 찼습니다.');
                return;
            }
            gameState.players.push({ id: socket.id, name: name, hand: [], isMeldDone: false, turnSubmittedTiles: [] });
        }

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
            gameState.backupBoard = JSON.stringify(gameState.boardGroups);

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

        // [수정] 제출한 타일이 있을 경우 1장 뽑기 절대 불가 처리
        if (currentPlayer.turnSubmittedTiles.length > 0) {
            socket.emit('errorMsg', '이미 필드에 타일을 냈으므로 1장 뽑기를 진행할 수 없습니다! 낸 카드를 모두 회수하고 회차를 패스하세요.');
            return;
        }

        if (gameState.tilePool.length > 0) currentPlayer.hand.push(gameState.tilePool.pop());
        gameState.backupBoard = JSON.stringify(gameState.boardGroups);
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('createNewGroup', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        if (gameState.players[gameState.currentTurn].id !== socket.id) return;
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

        if (!isComingFromHand && !currentPlayer.isMeldDone && toZone === 'hand') {
            let submittedIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (submittedIdx === -1) {
                socket.emit('errorMsg', '첫 등록 완료 전에는 기존 보드 타일을 가져올 수 없습니다!');
                gameState.boardGroups[parseInt(groupIndex) || 0].push(targetTile);
                io.to(myRoom).emit('updateGame', gameState);
                return;
            }
        }

        if (toZone === 'hand') {
            let sIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (sIdx !== -1) currentPlayer.turnSubmittedTiles.splice(sIdx, 1);
            currentPlayer.hand.push(targetTile);
        } else if (toZone === 'board') {
            if (isComingFromHand) currentPlayer.turnSubmittedTiles.push(targetTile);
            let gIdx = parseInt(groupIndex) || 0;
            while (gameState.boardGroups.length <= gIdx) gameState.boardGroups.push([]);
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
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (currentPlayer.turnSubmittedTiles.length === 0) {
            socket.emit('errorMsg', '타일을 한 장도 내지 않았다면 [타일 1장 뽑기]로 턴을 마쳐야 합니다.');
            return;
        }

        if (!isBoardValid(gameState.boardGroups)) {
            socket.emit('errorMsg', '❌ 보드 위에 완성되지 않은 조합 세트가 존재합니다! 이번 차례 행동이 강제 회수됩니다.');
            gameState.boardGroups = JSON.parse(gameState.backupBoard);
            currentPlayer.turnSubmittedTiles.forEach(tile => {
                if(!currentPlayer.hand.some(t => t.id === tile.id)) currentPlayer.hand.push(tile);
            });
            currentPlayer.turnSubmittedTiles = [];
            io.to(myRoom).emit('updateGame', gameState);
            return;
        }

        if (!currentPlayer.isMeldDone) {
            let scoreSum = 0;
            currentPlayer.turnSubmittedTiles.forEach(t => { scoreSum += t.isJoker ? 10 : t.number; });
            if (scoreSum < 30) {
                socket.emit('errorMsg', `첫 등록은 바닥에 낸 타일 숫자의 총합이 30점 이상이어야 합니다. (현재 내신 점수: ${scoreSum}점)`);
                gameState.boardGroups = JSON.parse(gameState.backupBoard);
                currentPlayer.turnSubmittedTiles.forEach(tile => {
                    if(!currentPlayer.hand.some(t => t.id === tile.id)) currentPlayer.hand.push(tile);
                });
                currentPlayer.turnSubmittedTiles = [];
                io.to(myRoom).emit('updateGame', gameState);
                return;
            } else {
                currentPlayer.isMeldDone = true;
            }
        }

        gameState.backupBoard = JSON.stringify(gameState.boardGroups);
        currentPlayer.turnSubmittedTiles = [];
        
        if (currentPlayer.hand.length === 0) {
            gameState.status = 'playing';
            io.to(myRoom).emit('victory', currentPlayer.name);
            delete rooms[myRoom];
            return;
        }

        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let gameState = rooms[myRoom];
            let activeConnections = io.sockets.adapter.rooms.get(myRoom);
            if (!activeConnections || activeConnections.size === 0) {
                delete rooms[myRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 중: ${PORT}`); });