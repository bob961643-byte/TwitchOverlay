/* =========================
   OBS WEBSOCKET 5 CLIENT
   https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
   Подключение с авторизацией, запросы с ответами и автопереподключение.
========================= */

const crypto = require("crypto");
const { EventEmitter } = require("events");

const RECONNECT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

// Коды закрытия, после которых повторять бессмысленно без смены настроек.
const FATAL_CLOSE_CODES = {
    4009: "Неверный пароль OBS WebSocket",
    4010: "Версия OBS WebSocket не поддерживается"
};

class ObsClient extends EventEmitter {
    constructor({ WebSocket }) {
        super();
        this.WebSocket = WebSocket;
        this.ws = null;
        this.settings = { host: "127.0.0.1", port: 4455, password: "" };
        this.wanted = false;
        this.connected = false;
        this.error = "";
        this.pending = new Map();
        this.requestId = 0;
        this.reconnectTimer = null;
    }

    getStatus() {
        return {
            connected: this.connected,
            connecting: this.wanted && !this.connected && !this.error,
            host: this.settings.host,
            port: this.settings.port,
            error: this.error
        };
    }

    emitStatus() {
        this.emit("status", this.getStatus());
    }

    configure(settings) {
        this.settings = {
            host: String(settings?.host || "127.0.0.1").trim() || "127.0.0.1",
            port: Math.max(1, Math.min(65535, Number(settings?.port) || 4455)),
            password: String(settings?.password || "")
        };
    }

    // Подключиться и держать соединение, пока не вызван disconnect().
    connect() {
        this.wanted = true;
        this.error = "";
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.closeSocket();
        this.open();
        this.emitStatus();
    }

    disconnect() {
        this.wanted = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.closeSocket();
        this.error = "";
        this.emitStatus();
    }

    closeSocket() {
        const ws = this.ws;
        this.ws = null;
        const wasConnected = this.connected;
        this.connected = false;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error("Соединение с OBS закрыто"));
        }
        this.pending.clear();
        if (ws) {
            try { ws.removeAllListeners(); } catch {}
            try { ws.on("error", () => {}); } catch {}
            try { ws.terminate(); } catch {}
        }
        if (wasConnected) this.emit("disconnected");
    }

    scheduleReconnect() {
        if (!this.wanted || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.open();
        }, RECONNECT_MS);
    }

    open() {
        if (!this.wanted || this.ws) return;
        const { host, port } = this.settings;

        let ws;
        try {
            ws = new this.WebSocket(`ws://${host}:${port}`, { handshakeTimeout: REQUEST_TIMEOUT_MS });
        } catch (error) {
            this.error = error?.message || String(error);
            this.emitStatus();
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.on("message", (raw) => {
            let packet;
            try { packet = JSON.parse(String(raw)); } catch { return; }
            this.handlePacket(ws, packet);
        });

        ws.on("error", (error) => {
            if (this.ws === ws && !this.connected) {
                this.error = error?.code === "ECONNREFUSED"
                    ? "OBS не запущен или WebSocket-сервер выключен"
                    : (error?.message || "Не удалось подключиться к OBS");
            }
        });

        ws.on("close", (code) => {
            if (this.ws !== ws) return;
            this.closeSocket();
            if (FATAL_CLOSE_CODES[code]) {
                this.error = FATAL_CLOSE_CODES[code];
                this.wanted = false;
            } else if (!this.error) {
                this.error = "Соединение с OBS потеряно";
            }
            this.emitStatus();
            this.scheduleReconnect();
        });
    }

    handlePacket(ws, packet) {
        const d = packet?.d || {};

        if (packet.op === 0) {
            // Hello: при включённой авторизации OBS присылает challenge и salt.
            const identify = { rpcVersion: 1, eventSubscriptions: 0 };
            if (d.authentication) {
                if (!this.settings.password) {
                    this.error = "OBS требует пароль WebSocket";
                    this.wanted = false;
                    this.closeSocket();
                    this.emitStatus();
                    return;
                }
                const secret = crypto.createHash("sha256")
                    .update(this.settings.password + d.authentication.salt).digest("base64");
                identify.authentication = crypto.createHash("sha256")
                    .update(secret + d.authentication.challenge).digest("base64");
            }
            ws.send(JSON.stringify({ op: 1, d: identify }));
            return;
        }

        if (packet.op === 2) {
            this.connected = true;
            this.error = "";
            this.emitStatus();
            this.emit("connected");
            return;
        }

        if (packet.op === 7) {
            const waiter = this.pending.get(d.requestId);
            if (!waiter) return;
            clearTimeout(waiter.timer);
            this.pending.delete(d.requestId);
            if (d.requestStatus?.result) {
                waiter.resolve(d.responseData || {});
            } else {
                const error = new Error(d.requestStatus?.comment || `OBS отклонил ${d.requestType}`);
                error.code = d.requestStatus?.code;
                waiter.reject(error);
            }
        }
    }

    request(requestType, requestData = {}) {
        return new Promise((resolve, reject) => {
            if (!this.ws || !this.connected) {
                reject(new Error("OBS не подключён"));
                return;
            }
            const requestId = `to-${++this.requestId}`;
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`OBS не ответил на ${requestType}`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error);
            }
        });
    }

    // Запрос без ожидания ответа — для частых кадров анимации.
    fire(requestType, requestData = {}) {
        this.request(requestType, requestData).catch(() => {});
    }
}

module.exports = { ObsClient };
