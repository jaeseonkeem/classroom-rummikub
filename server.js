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
        status: 'waiting',
        backupBoard: null // 검증 실패 시 되돌릴 보드 백업본
    };
}

// ================= [루미큐브 핵심 규칙 검증 알고리즘 엔진] =================

// 1. 그룹(Group) 검증: 같은 숫자, 다른 색상 (3~4장)
function validateGroup(tiles) {
    if (tiles.length < 3 || tiles.length > 4) return false;
    
    // 조커 제외 순수 숫자 추출
    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true; // 조커로만 이뤄진 특수 케이스 예외 통과

    const targetNum = regularTiles[0].number;
    const colors = new Set();

    for (let t of regularTiles) {
        if (t.number !== targetNum) return false; // 숫자가 다르면 탈락
        if (colors.has(t.color)) return false;    // 중복 색상이 있으면 탈락
        colors.add(t.color);
    }
    return true;
}

// 2. 연속(Run) 검증: 같은 색상, 연속된 숫자 (3장 이상, 13 뒤에 1 불가)
function validateRun(tiles) {
    if (tiles.length < 3) return false;

    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true;

    // 모두 같은 색상인지 체크 (조커 제외)
    const targetColor = regularTiles[0].color;
    if (regularTiles.some(t => t.color !== targetColor)) return false;

    // 조커를 포함한 연속숫자 가능 여부 완전 탐색 알고리즘
    return checkRunWithJokers(tiles.map(t => t.isJoker ? 'J' : t.number));
}

function checkRunWithJokers(arr) {
    let jokersCount = arr.filter(v => v === 'J').length;
    let nums = arr.filter(v => v !== 'J').sort((a, b) => a - b);
    
    // 중복된 숫자가 연속 세트에 있으면 안 됨
    for(let i=0; i<nums.length-1; i++) {
        if(nums[i] === nums[i+1]) return false;
    }

    // 최소 숫자와 최대 숫자 사이의 벌어진 간격을 조커로 메울 수 있는지 계산
    let diff = nums[nums.length - 1] - nums[0];
    let neededJokers = diff - (nums.length - 1);
    
    if (neededJokers <= jokersCount) {
        // 숫자 범위를 넘지 않는지 확인 (1~13 범위 제약)
        let totalLength = nums.length + jokersCount;
        if (totalLength <= 13) return true;
    }
    return false;
}

// 전체 보드 유효성 최종 검사 함수
function isBoardValid(boardGroups) {
    // 타일이 하나도 없는 클린 보드는 유효한 상태로 침
    const activeGroups = boardGroups.filter(g => g.length > 0);
    if (activeGroups.length === 0) return true;

    for (let group of activeGroups) {
        // 각 묶음이 그룹 규칙이나 연속 규칙 중 하나라도 만족해야 함
        if (!validateGroup(group) && !validateRun(group)) {
            return false; 
        }
    }
    return true;
}
// =========================================================================

io.on('connection', (socket) => {
    let myRoom = null;

    socket.on('joinGame', ({ name, roomId }) => {
        const roomName = `room-${roomId}`;
        myRoom = roomName;
        if (!rooms[roomName]) rooms[roomName] = createNewRoomState();
        let gameState = rooms[roomName];

        if (gameState.status === 'playing' || gameState.players.length >= 4) {
            socket.emit('errorMsg', '입장할 수 없습니다.');
            return;
        }
        socket.join(roomName);
        gameState.players.push({ id: socket.id, name: name, hand: [], isMeldDone: false, turnSubmittedTiles: [] });
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
            // 새 게임 시작 시 백업 보드 초기화
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

        // 패를 뽑으면 이번 턴에 벌인 조작(보드)을 전부 롤백하고 덱에서 가져옴
        if (gameState.backupBoard) {
            gameState.boardGroups = JSON.parse(gameState.backupBoard);
        }
        
        // 제출했던 리스트 원상복구
        if (currentPlayer.turnSubmittedTiles.length > 0) {
            currentPlayer.turnSubmittedTiles.forEach(tile => {
                if(!currentPlayer.hand.some(t => t.id === tile.id)) {
                    currentPlayer.hand.push(tile);
                }
            });
            currentPlayer.turnSubmittedTiles = [];
        }

        if (gameState.tilePool.length > 0) currentPlayer.hand.push(gameState.tilePool.pop());
        gameState.backupBoard = JSON.stringify(gameState.boardGroups); // 백업 갱신
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

        // 등록 전 가드 규칙 유지
        if (!isComingFromHand && !currentPlayer.isMeldDone && toZone === 'hand') {
            let submittedIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (submittedIdx === -1) {
                socket.emit('errorMsg', '첫 등록 전에는 기존 보드 타일을 손패로 회수할 수 없습니다!');
                let gIdx = parseInt(groupIndex) || 0;
                gameState.boardGroups[gIdx].push(targetTile);
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

    // 턴 마치기 클릭 시 조합 규칙 전면 검증
    socket.on('endTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (currentPlayer.turnSubmittedTiles.length === 0) {
            socket.emit('errorMsg', '타일을 내지 않았다면 [타일 1장 뽑기]를 이용해 주세요.');
            return;
        }

        // [기본 규칙 검증 수행] 공용 보드가 완벽한 루미큐브 족보를 만족하는가?
        if (!isBoardValid(gameState.boardGroups)) {
            socket.emit('errorMsg', '❌ 유효하지 않은 세트가 보드에 존재합니다! (3장 미만, 조합 오류, 조커 위치 확인) 이번 턴의 배치 행동이 롤백됩니다.');
            
            // 보드를 이번 턴 시작 직전 백업 상태로 완전 강제 원상복구
            gameState.boardGroups = JSON.parse(gameState.backupBoard);
            
            // 필드에 냈던 타일들 유저 손패로 복귀
            currentPlayer.turnSubmittedTiles.forEach(tile => {
                if(!currentPlayer.hand.some(t => t.id === tile.id)) {
                    currentPlayer.hand.push(tile);
                }
            });
            currentPlayer.turnSubmittedTiles = [];
            io.to(myRoom).emit('updateGame', gameState);
            return;
        }

        // [등록 30점 조건 체크]
        if (!currentPlayer.isMeldDone) {
            let scoreSum = 0;
            currentPlayer.turnSubmittedTiles.forEach(t => { scoreSum += t.isJoker ? 10 : t.number; });

            if (scoreSum < 30) {
                socket.emit('errorMsg', `첫 등록의 총합이 30점 미만입니다. (${scoreSum}점) 배치가 취소됩니다.`);
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

        // 모든 검증 통과 완료 시 백업본 최신화 및 턴 체인지
        gameState.backupBoard = JSON.stringify(gameState.boardGroups);
        currentPlayer.turnSubmittedTiles = [];
        
        // 누군가 패를 다 털었는지 승리 조건 체크
        if (currentPlayer.hand.length === 0) {
            gameState.status = 'waiting';
            io.to(myRoom).emit('victory', currentPlayer.name);
            delete rooms[myRoom]; // 방 폭파 및 재준비
            return;
        }

        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let gameState = rooms[myRoom];
            gameState.players = gameState.players.filter(p => p.id !== socket.id);
            if (gameState.players.length === 0) delete rooms[myRoom];
            else io.to(myRoom).emit('updateGame', gameState);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`검증 엔진 서버 작동 중: ${PORT}`); });