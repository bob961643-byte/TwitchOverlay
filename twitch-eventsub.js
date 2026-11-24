/* =========================
   TWITCH EVENTSUB (WebSocket)
   Слушает покупки наград за баллы канала:
   channel.channel_points_custom_reward_redemption.add
   https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
   Нужен scope channel:read:redemptions у токена самого стримера.
========================= */

const { EventEmitter } = require("events");

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const HELIX = "https://api.twitch.tv/helix";
const REDEMPTION_TYPE = "channel.channel_points_custom_reward_redemption.add";
const REQUIRED_SCOPE = "channel:read:redemptions";
const RETRY_MS = 10000;

class TwitchEventSub extends EventEmitter {
    /**
     * @param {object} options
     * @param {typeof import("ws")} options.WebSocket
     * @param {string} options.clientId
     * @param {(opts?: {forceValidate?: boolean}) => Promise<{accessToken:string,userId:string,scopes?:string[]}|null>} options.getAuth
     *        Возвращает токен; с forceValidate сначала проверяет и обновляет его.
     */
    constructor({ WebSocket, clientId, getAuth }) {
        super();
        this.WebSocket = WebSocket;
        this.clientId = clientId;
        this.getAuth = getAuth;
        this.ws = null;
        this.running = false;
        this.state = "off"; // off | connecting | connected | no-scope | error
        this.message = "";
        this.keepaliveTimer = null;
        this.keepaliveMs = 0;
        this.retryTimer = null;
        this.seenMessages = new Set();
        this.subscribed = false;
    }

    getStatus() {
        return { state: this.state, message: this.message };
    }

    setStatus(state, message = "") {
        this.state = state;
        this.message = message;
        this.emit("status", this.getStatus());
    }

    async start() {
        if (this.running) return;
        this.running = true;
        await this.connect(EVENTSUB_URL);
    }

    stop() {
        this.running = false;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.dropSocket(this.ws);
        this.ws = null;
        this.subscribed = false;
        this.setStatus("off");
    }

    dropSocket(ws) {
        clearTimeout(this.keepaliveTimer);
        if (!ws) return;
        try { ws.removeAllListeners(); } catch {}
        try { ws.on("error", () => {}); } catch {}
        try { ws.terminate(); } catch {}
    }

    scheduleRetry(message) {
        this.dropSocket(this.ws);
        this.ws = null;
        this.subscribed = false;
        if (!this.running) return;
        this.setStatus("error", message);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect(EVENTSUB_URL);
        }, RETRY_MS);
    }

    async connect(url, { isReconnect = false } = {}) {
        if (!this.running) return;

        const auth = await this.getAuth().catch(() => null);
        // Без входа или без нужного разрешения ждать нечего: останавливаемся,
        // main.js запустит нас снова после повторного входа.
        if (!auth?.accessToken || !auth?.userId) {
            this.running = false;
            this.setStatus("error", "Войдите в Twitch");
            return;
        }
        if (Array.isArray(auth.scopes) && !auth.scopes.includes(REQUIRED_SCOPE)) {
            this.running = false;
            this.setStatus("no-scope", "Нужно заново войти в Twitch, чтобы разрешить чтение наград");
            return;
        }

        if (!isReconnect) this.setStatus("connecting", "Подключение к Twitch EventSub…");

        const oldWs = this.ws;
        const ws = new this.WebSocket(url);
        this.ws = ws;

        ws.on("message", (raw) => {
            let packet;
            try { packet = JSON.parse(String(raw)); } catch { return; }
            this.handlePacket(ws, packet, { oldWs, isReconnect }).catch((error) => {
                console.error("EventSub:", error?.message || error);
            });
        });

        ws.on("error", (error) => {
            console.error("EventSub socket error:", error?.message || error);
        });

        ws.on("close", (code) => {
            if (this.ws !== ws) return;
            // 4003/4004 — Twitch закрыл сессию без подписок или после переезда.
            this.scheduleRetry(`Соединение с Twitch EventSub закрыто (${code})`);
        });
    }

    armKeepalive(ws) {
        clearTimeout(this.keepaliveTimer);
        if (!this.keepaliveMs) return;
        this.keepaliveTimer = setTimeout(() => {
            if (this.ws === ws) this.scheduleRetry("Twitch EventSub перестал отвечать");
        }, this.keepaliveMs + 5000);
    }

    async handlePacket(ws, packet, { oldWs, isReconnect }) {
        const type = packet?.metadata?.message_type;
        const messageId = packet?.metadata?.message_id;

        if (messageId) {
            if (this.seenMessages.has(messageId)) return;
            this.seenMessages.add(messageId);
            if (this.seenMessages.size > 200) {
                this.seenMessages.delete(this.seenMessages.values().next().value);
            }
        }

        if (this.ws === ws) this.armKeepalive(ws);

        if (type === "session_welcome") {
            const session = packet.payload?.session || {};
            this.keepaliveMs = (Number(session.keepalive_timeout_seconds) || 10) * 1000;
            this.armKeepalive(ws);

            if (isReconnect) {
                // При переезде подписки переносятся сами, старое соединение закрываем.
                this.dropSocket(oldWs);
                this.armKeepalive(ws);
                this.setStatus("connected", "Награды за баллы подключены");
                return;
            }

            await this.subscribe(session.id);
            return;
        }

        if (type === "session_reconnect") {
            const url = packet.payload?.session?.reconnect_url;
            if (url) await this.connect(url, { isReconnect: true });
            return;
        }

        if (type === "revocation") {
            this.scheduleRetry("Twitch отозвал подписку на награды");
            return;
        }

        if (type === "notification" && packet.metadata?.subscription_type === REDEMPTION_TYPE) {
            const event = packet.payload?.event || {};
            this.emit("redemption", {
                id: event.id,
                rewardId: event.reward?.id || "",
                rewardTitle: event.reward?.title || "",
                cost: Number(event.reward?.cost) || 0,
                userName: event.user_name || event.user_login || "",
                input: event.user_input || ""
            });
        }
    }

    async helix(method, pathAndQuery, body, retried = false) {
        // При повторе просим заново проверить (и при необходимости обновить) токен.
        const auth = await this.getAuth({ forceValidate: retried });
        if (!auth?.accessToken) throw new Error("Войдите в Twitch");

        const response = await fetch(`${HELIX}${pathAndQuery}`, {
            method,
            headers: {
                "Client-Id": this.clientId,
                Authorization: `Bearer ${auth.accessToken}`,
                ...(body ? { "Content-Type": "application/json" } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (response.status === 401 && !retried) {
            return this.helix(method, pathAndQuery, body, true);
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data?.message || `Twitch API ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    async subscribe(sessionId) {
        const auth = await this.getAuth();
        try {
            await this.helix("POST", "/eventsub/subscriptions", {
                type: REDEMPTION_TYPE,
                version: "1",
                condition: { broadcaster_user_id: String(auth.userId) },
                transport: { method: "websocket", session_id: sessionId }
            });
            this.subscribed = true;
            this.setStatus("connected", "Награды за баллы подключены");
        } catch (error) {
            if (error.status === 403) {
                this.running = false;
                this.dropSocket(this.ws);
                this.ws = null;
                this.setStatus("no-scope", "Нужно заново войти в Twitch, чтобы разрешить чтение наград");
                return;
            }
            this.scheduleRetry(`Не удалось подписаться на награды: ${error.message}`);
        }
    }

    // Список наград канала для выбора в настройках.
    async getRewards() {
        const auth = await this.getAuth();
        if (!auth?.userId) throw new Error("Войдите в Twitch");
        const data = await this.helix(
            "GET",
            `/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(auth.userId)}`
        );
        return (data.data || [])
            .map((r) => ({ id: r.id, title: r.title, cost: Number(r.cost) || 0, enabled: Boolean(r.is_enabled) }))
            .sort((a, b) => a.cost - b.cost);
    }
}

module.exports = { TwitchEventSub, REQUIRED_SCOPE };
