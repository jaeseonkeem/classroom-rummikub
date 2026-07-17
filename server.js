const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});
const path = require('path');

// ★ 추가: 웹사이트 접속 시 같은 폴더에 있는 index.html 파일을 보여주는 설정
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let gameState = {
    players: [],
    boardTiles: [],
    tilePool: [],
    currentTurn: 0
};

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

    socket.on('joinGame', (name) => {
        if (gameState.players.length >= 4) {
            socket.emit('errorMsg', '방이 가득 찼습니다.');
            return;
        }

        if (gameState.players.length === 0) {
            gameState.tilePool = initDeck();
            gameState.boardTiles = [];
        }

        let hand = [];
        for (let i = 0; i < 14; i++) {
            if (gameState.tilePool.length > 0) hand.push(gameState.tilePool.pop());
        }

        gameState.players.push({
            id: socket.id,
            name: name,
            hand: hand
        });

        io.emit('updateGame', gameState);
    });

    socket.on('moveTileToBoard', ({ tileId }) => {
        let player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        const tileIndex = player.hand.findIndex(t => t.id === tileId);
        if (tileIndex !== -1) {
            const tile = player.hand.splice(tileIndex, 1)[0];
            gameState.boardTiles.push(tile);
            io.emit('updateGame', gameState);
        }
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
            gameState.boardTiles = [];
        }
        io.emit('updateGame', gameState);
    });
});

// 환경변수 포트(Render용) 적용
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`루미큐브 학급 서버가 ${PORT}번 포트에서 구동 중입니다...`);
});