/* =========================
   VEADOTUBE MINI
   Клиент WebSocket API veadotube mini (https://veado.tube/docs/tech/api/).
   Находит запущенный экземпляр через %USERPROFILE%\.veadotube\instances,
   держит соединение, знает список состояний аватара и по очереди
   проигрывает реакции: состояние включается на время и снимается.
========================= */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const NODE_ID = "mini";
const RECONNECT_MS = 3000;
const REQUEST_TIMEOUT_MS = 4000;
const QUEUE_LIMIT = 20;
const REACTION_GAP_MS = 300;

function getInstancesDir() {
    return path.join(os.homedir(), ".veadotube", "instances");
}

// Файлы экземпляров — JSON, но в документации допускаются комментарии «//».
function parseInstanceFile(text) {
    const cleaned = String(text || "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\/\/.*$/, ""))
        .join("\n");
    return JSON.parse(cleaned);
}

function listInstances() {
    const dir = getInstancesDir();
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }

    const result = [];
    for (const name of names) {
        // Нам нужен только veadotube mini: id вида mini-<время>-<pid>.
        if (!name.startsWith("mini-")) continue;
        try {
            const info = parseInstanceFile(fs.readFileSync(path.join(dir, name), "utf8"));
            if (!info || typeof info.server !== "string" || !info.server) continue;
            result.push({
                id: String(info.id || name),
                name: String(info.name || "veadotube mini"),
                version: String(info.version || ""),
                server: info.server,
                time: Number(info.time) || 0
            });
        } catch {
            // Повреждённые файлы экземпляров документация велит пропускать.
        }
    }

    return result.sort((a, b) => b.time - a.time);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VeadotubeClient extends EventEmitter {
    constructor({ WebSocket, clientName = "Twitch Overlay" }) {
        super();
        this.WebSocket = WebSocket;
        this.clientName = clientName;
        this.ws = null;
        this.running = false;
        this.connected = false;
        this.instance = null;
        this.states = [];
        this.current = null;
        this.lastError = null;
        this.reconnectTimer = null;
        this.candidateIndex = 0;
        this.pending = new Map();
        this.queue = [];
        this.processing = false;
        this.activeReaction = null;
    }

    getStatus() {
        return {
            running: this.running,
            connected: this.connected,
            instance: this.instance
                ? { name: this.instance.name, version: this.instance.version, server: this.instance.server }
                : null,
            states: this.states.slice(),
            current: this.current,
            queueLength: this.queue.length + (this.activeReaction ? 1 : 0),
            error: this.lastError
        };
    }

    emitStatus() {
        this.emit("status", this.getStatus());
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.queue = [];
        this.closeSocket();
        this.emitStatus();
    }

    closeSocket() {
        const ws = this.ws;
        this.ws = null;
        this.connected = false;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error("Соединение с veadotube закрыто"));
        }
        this.pending.clear();
        if (ws) {
            try { ws.removeAllListeners(); } catch {}
            try { ws.on("error", () => {}); } catch {}
            try { ws.terminate(); } catch {}
        }
    }

    scheduleReconnect() {
        if (!this.running || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_MS);
    }

    connect() {
        if (!this.running || this.ws) return;

        const instances = listInstances();
        if (!instances.length) {
            this.instance = null;
            this.lastError = "veadotube mini не запущен";
            this.emitStatus();
            this.scheduleReconnect();
            return;
        }

        // После старого вылета в папке может остаться файл мёртвого экземпляра,
        // поэтому при неудаче по кругу пробуем следующий.
        const instance = instances[this.candidateIndex % instances.length];
        const url = `ws://${instance.server}?n=${encodeURIComponent(this.clientName)}`;

        let ws;
        try {
            ws = new this.WebSocket(url, { handshakeTimeout: REQUEST_TIMEOUT_MS });
        } catch (error) {
            this.lastError = error?.message || String(error);
            this.candidateIndex++;
            this.emitStatus();
            this.scheduleReconnect();
            return;
        }

        this.ws = ws;

        ws.on("open", () => {
            this.connected = true;
            this.instance = instance;
            this.lastError = null;
            this.candidateIndex = 0;
            this.emitStatus();
            this.sendState({ event: "listen", token: "twitch-overlay" });
            this.refreshStates().catch(() => {});
        });

        ws.on("message", (data) => this.handleMessage(String(data)));

        ws.on("error", (error) => {
            this.lastError = error?.message || String(error);
        });

        ws.on("close", () => {
            const wasConnected = this.connected;
            if (this.ws === ws) this.closeSocket();
            if (!wasConnected) this.candidateIndex++;
            this.current = null;
            if (wasConnected) this.lastError = "Соединение с veadotube потеряно";
            this.emitStatus();
            this.scheduleReconnect();
        });
    }

    send(channel, object) {
        if (!this.ws || !this.connected) return false;
        try {
            this.ws.send(`${channel}:${JSON.stringify(object)}`);
            return true;
        } catch {
            return false;
        }
    }

    sendState(payload) {
        return this.send("nodes", { event: "payload", type: "stateEvents", id: NODE_ID, payload });
    }

    // Ответ ждём по имени события: у veadotube нет id запросов.
    requestState(payload, expectEvent) {
        return new Promise((resolve, reject) => {
            if (!this.sendState(payload)) {
                reject(new Error("veadotube не подключён"));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(expectEvent);
                reject(new Error("veadotube не ответил"));
            }, REQUEST_TIMEOUT_MS);
            const previous = this.pending.get(expectEvent);
            if (previous) {
                clearTimeout(previous.timer);
                previous.reject(new Error("Запрос заменён новым"));
            }
            this.pending.set(expectEvent, { resolve, reject, timer });
        });
    }

    handleMessage(text) {
        const colon = text.indexOf(":");
        if (colon < 0) return;
        const channel = text.slice(0, colon).trim();
        if (channel !== "nodes") return;

        let message;
        try {
            message = JSON.parse(text.slice(colon + 1));
        } catch {
            return;
        }

        if (message?.event !== "payload" || message.type !== "stateEvents" || message.id !== NODE_ID) return;
        const payload = message.payload || {};

        if (payload.event === "list" && Array.isArray(payload.states)) {
            this.states = payload.states
                .filter((s) => s && s.id != null)
                .map((s) => ({ id: String(s.id), name: String(s.name ?? s.id) }));
            this.emitStatus();
        } else if (payload.event === "peek") {
            this.current = payload.state != null ? String(payload.state) : null;
            this.emitStatus();
        }

        const waiter = this.pending.get(payload.event);
        if (waiter) {
            clearTimeout(waiter.timer);
            this.pending.delete(payload.event);
            waiter.resolve(payload);
        }
    }

    async refreshStates() {
        await this.requestState({ event: "list" }, "list");
        await this.requestState({ event: "peek" }, "peek").catch(() => {});
        return this.getStatus();
    }

    /* ---------- реакции ---------- */

    // Ставит реакцию в очередь: состояние stateId на durationMs, затем возврат.
    enqueueReaction(stateId, durationMs, label = "") {
        const state = String(stateId || "").trim();
        const duration = Math.max(500, Math.min(600000, Number(durationMs) || 0));
        if (!state) return { success: false, error: "Не выбрано состояние аватара" };
        if (!this.connected) return { success: false, error: "veadotube mini не подключён" };
        if (this.queue.length >= QUEUE_LIMIT) return { success: false, error: "Очередь реакций переполнена" };

        this.queue.push({ state, duration, label });
        this.emitStatus();
        this.processQueue();
        return { success: true };
    }

    // Держит состояние stateId durationMs миллисекунд и снимает его.
    // Используется и собственной очередью, и общей очередью реакций в main.js.
    async holdState(stateId, durationMs) {
        const state = String(stateId || "");
        if (!state || !this.connected) {
            await delay(durationMs);
            return;
        }

        // Если это состояние уже на вершине (стример включил его сам),
        // не трогаем стек, чтобы не снять его по окончании реакции.
        let top = null;
        try {
            top = (await this.requestState({ event: "peek" }, "peek")).state;
        } catch {}
        const alreadyOn = top != null && String(top) === state;

        if (!alreadyOn) this.sendState({ event: "push", state });
        await delay(durationMs);
        if (!alreadyOn) this.sendState({ event: "pop", state });

        this.requestState({ event: "peek" }, "peek").catch(() => {});
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.queue.length && this.running) {
                const reaction = this.queue.shift();
                this.activeReaction = reaction;
                this.emitStatus();

                if (!this.connected) continue;

                this.emit("reaction", { ...reaction, phase: "start" });
                await this.holdState(reaction.state, reaction.duration);
                this.emit("reaction", { ...reaction, phase: "end" });
                await delay(REACTION_GAP_MS);
            }
        } finally {
            this.activeReaction = null;
            this.processing = false;
            this.emitStatus();
        }
    }
}

module.exports = { VeadotubeClient, listInstances };
