const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Раздаём файлы из папки public
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
    console.log("Клиент подключился:", socket.id);

    socket.on("chatMessage", (message) => {
        console.log("Сообщение:", message);

        // Отправляем сообщение всем подключённым клиентам
        io.emit("chatMessage", message);
    });

    socket.on("disconnect", () => {
        console.log("Клиент отключился:", socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Twitch Overlay запущен: http://localhost:${PORT}`);
});