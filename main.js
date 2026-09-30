const {
    app,
    BrowserWindow,
    ipcMain,
    safeStorage,
    screen,
    nativeTheme,
    globalShortcut,
    shell,
    dialog,
    Tray,
    Menu,
    nativeImage
} = require("electron");
const { autoUpdater } = require("electron-updater");
const express = require("express");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");

// Updates are checked explicitly. Nothing is downloaded until the user
// confirms the update in the UI.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
let updateInstallScheduled = false;
let updateCheckInProgress = false;
let updateDownloadInProgress = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
});

autoUpdater.on("update-available", (info) => {
    sendUpdateCheckResult({
        status: "available",
        currentVersion: app.getVersion(),
        latestVersion: info?.version || null
    });
});

autoUpdater.on("update-not-available", (info) => {
    sendUpdateCheckResult({
        status: "up-to-date",
        currentVersion: app.getVersion(),
        latestVersion: info?.version || app.getVersion()
    });
});

autoUpdater.on("download-progress", (progress) => {
    sendUpdateCheckResult({
        status: "downloading",
        currentVersion: app.getVersion(),
        percent: Number.isFinite(progress?.percent) ? progress.percent : null,
        bytesPerSecond: progress?.bytesPerSecond || 0,
        transferred: progress?.transferred || 0,
        total: progress?.total || 0
    });
});

autoUpdater.on("update-cancelled", (info) => {
    updateDownloadInProgress = false;
    updateInstallScheduled = false;
    sendUpdateCheckResult({
        status: "cancelled",
        currentVersion: app.getVersion(),
        latestVersion: info?.version || null,
        error: "Загрузка обновления отменена."
    });
});

autoUpdater.on("update-downloaded", (info) => {
    sendUpdateCheckResult({
        status: "downloaded",
        currentVersion: app.getVersion(),
        latestVersion: info?.version || null
    });

    updateDownloadInProgress = false;
    if (updateInstallScheduled) return;
    updateInstallScheduled = true;

    // Give the renderer a moment to show the status, then let electron-updater
    // close the app, run the NSIS update and relaunch the new version.
    setTimeout(() => {
        try {
            autoUpdater.quitAndInstall(false, true);
        } catch (error) {
            updateInstallScheduled = false;
            sendUpdateCheckResult({
                status: "unavailable",
                currentVersion: app.getVersion(),
                error: `Не удалось установить обновление: ${error?.message || String(error)}`
            });
        }
    }, 1200);
});

autoUpdater.on("error", (error) => {
    sendUpdateCheckResult({
        status: "unavailable",
        currentVersion: app.getVersion(),
        error: error?.message || String(error)
    });
});
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const tmi = require("tmi.js");
const WebSocket = require("ws");

let mainWindow = null;
let overlayWindow = null;
let overlayReady = false;
let overlayEditing = false;
let pendingOverlayMessages = [];
let tray = null;

let twitchClient = null;
let twitchToken = null;
let twitchSessionState = "missing"; // missing | loaded | valid | unavailable | invalid
let connectedChannel = null;

let badgeImagesCache = {};
let badgeImagesCacheChannel = null;
let thirdPartyEmoteCache = { bttv: {}, sevenTv: {} };
let thirdPartyEmoteCacheChannel = null;

const CLIENT_ID = "4u1wcqhcjw7ydzd933olj4yiouic7i";

const TOKEN_FILE = "twitch-token.dat";


/* =========================
   SYSTEM TRAY
========================= */

function getTrayIconPath() {
    return path.join(__dirname, "assets", "tray-icon.png");
}

function showSettingsWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
}

function createTray() {
    if (tray) return;

    try {
        const iconPath = getTrayIconPath();
        const icon = fs.existsSync(iconPath)
            ? nativeImage.createFromPath(iconPath)
            : nativeImage.createEmpty();

        tray = new Tray(icon);
        tray.setToolTip("Twitch Overlay");
        tray.setContextMenu(Menu.buildFromTemplate([
            {
                label: "Открыть настройки",
                click: () => showSettingsWindow()
            },
            {
                label: "Показать / скрыть Overlay",
                click: () => handleHotkeyAction("toggleOverlay")
            },
            {
                type: "separator"
            },
            {
                label: "Закрыть программу",
                click: () => closeApplication()
            }
        ]));

        tray.on("double-click", () => showSettingsWindow());
    } catch (error) {
        console.error("Ошибка создания значка в области уведомлений:", error);
        tray = null;
    }
}

function destroyTray() {
    if (!tray) return;
    try { tray.destroy(); } catch {}
    tray = null;
}

function closeApplication() {
    if (app.isQuitting) return;
    app.isQuitting = true;

    try { globalShortcut.unregisterAll(); } catch {}

    if (autoChatStatusTimer) {
        clearInterval(autoChatStatusTimer);
        autoChatStatusTimer = null;
    }

    if (twitchClient) {
        const client = twitchClient;
        twitchClient = null;
        connectedChannel = null;
        try { client.disconnect().catch(() => {}); } catch {}
    }

    obsDisconnect();

    if (overlayWindow && !overlayWindow.isDestroyed()) {
        try { saveOverlayBounds(); } catch {}
        try { overlayWindow.destroy(); } catch {}
    }
    overlayWindow = null;
    overlayReady = false;
    overlayEditing = false;
    pendingOverlayMessages = [];

    destroyTray();

    if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch {}
    }
    mainWindow = null;

    try { app.quit(); } catch {}
}

/* =========================
   OBS WEBSOCKET
========================= */

const obsSettingsFile = path.join(app.getPath("userData"), "obs-settings.json");
const defaultObsSettings = { host: "127.0.0.1", port: 4455, password: "" };
let obsSettings = loadJsonFile?.(obsSettingsFile, defaultObsSettings) || { ...defaultObsSettings };
let obsSocket = null;
let obsRequestId = 0;
let obsConnected = false;

function saveObsSettings() {
    try { fs.writeFileSync(obsSettingsFile, JSON.stringify(obsSettings, null, 4), "utf8"); return true; }
    catch (error) { console.error("Ошибка сохранения OBS настроек:", error); return false; }
}

function sendObsStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("obs-status", { connected: obsConnected, host: obsSettings.host, port: obsSettings.port });
    }
}

function obsDisconnect() {
    obsConnected = false;
    if (obsSocket) {
        try { obsSocket.close(); } catch {}
        obsSocket = null;
    }
    sendObsStatus();
}

function obsConnect() {
    return new Promise((resolve) => {
        obsDisconnect();
        const host = String(obsSettings.host || "127.0.0.1").trim() || "127.0.0.1";
        const port = Math.max(1, Math.min(65535, Number(obsSettings.port) || 4455));
        obsSettings.host = host;
        obsSettings.port = port;
        saveObsSettings();

        let settled = false;
        const finish = (result) => { if (settled) return; settled = true; resolve(result); };
        try {
            const ws = new WebSocket(`ws://${host}:${port}`);
            obsSocket = ws;
            ws.once("open", () => {});
            ws.on("message", (raw) => {
                let packet;
                try { packet = JSON.parse(raw.toString()); } catch { return; }
                if (packet.op === 0) {
                    const d = packet.d || {};
                    const identify = { rpcVersion: 1 };
                    if (d.authentication && obsSettings.password) {
                        const secret = crypto.createHash("sha256").update(String(obsSettings.password) + d.authentication.salt).digest("base64");
                        const auth = crypto.createHash("sha256").update(secret + d.authentication.challenge).digest("base64");
                        identify.authentication = auth;
                    }
                    ws.send(JSON.stringify({ op: 1, d: identify }));
                } else if (packet.op === 2) {
                    obsConnected = true;
                    finish({ success: true });
                    sendObsStatus();
                } else if (packet.op === 7 && packet.d?.requestType === "GetVersion") {
                    if (packet.d.requestStatus?.result === true) {
                        obsConnected = true;
                        finish({ success: true });
                    } else {
                        finish({ success: false, error: packet.d.requestStatus?.comment || "OBS запрос отклонён" });
                    }
                } else if (packet.op === 9) {
                    // Negotiated event batch; no action needed for the basic connection.
                }
            });
            ws.on("error", (error) => { obsConnected = false; sendObsStatus(); finish({ success: false, error: error?.message || "Не удалось подключиться к OBS" }); });
            ws.on("close", () => { obsConnected = false; if (obsSocket === ws) obsSocket = null; sendObsStatus(); });
            setTimeout(() => finish({ success: false, error: "Время ожидания OBS истекло" }), 5000);
        } catch (error) {
            finish({ success: false, error: error?.message || String(error) });
        }
    });
}

/* =========================
   OBS BROWSER SOURCE
========================= */

let obsWebServer = null;
let obsIo = null;
const OBS_BROWSER_PORT = 3000;

function startObsBrowserSourceServer() {
    if (obsWebServer) return;

    try {
        const webApp = express();
        obsWebServer = http.createServer(webApp);
        obsIo = new SocketIOServer(obsWebServer, {
            cors: { origin: "*" }
        });

        webApp.use(express.static(path.join(__dirname, "public")));

        obsIo.on("connection", (socket) => {
            socket.emit("overlay-settings", overlaySettings);
        });

        obsWebServer.on("error", (error) => {
            console.error("Ошибка OBS Browser Source сервера:", error);
        });

        obsWebServer.listen(OBS_BROWSER_PORT, "127.0.0.1", () => {
            console.log(`OBS Browser Source: http://127.0.0.1:${OBS_BROWSER_PORT}/obs.html`);
        });
    } catch (error) {
        console.error("Не удалось запустить OBS Browser Source:", error);
    }
}

function sendMessageToObsBrowser(message) {
    try {
        obsIo?.emit("twitch-chat-message", message);
    } catch (error) {
        console.error("Ошибка отправки сообщения в OBS Browser Source:", error);
    }
}

function sendSettingsToObsBrowser(settings = overlaySettings) {
    try {
        obsIo?.emit("overlay-settings", settings);
    } catch (error) {
        console.error("Ошибка отправки настроек в OBS Browser Source:", error);
    }
}

/* =========================
   TOKEN
========================= */

function getTokenPath() {
    return path.join(
        app.getPath("userData"),
        TOKEN_FILE
    );
}


function saveTwitchToken(tokenData) {
    try {
        if (!tokenData || typeof tokenData !== "object" || !tokenData.accessToken) {
            throw new Error("Некорректные данные Twitch-сессии");
        }

        const json = JSON.stringify(tokenData);
        let data;

        if (safeStorage.isEncryptionAvailable()) {
            data = safeStorage.encryptString(json);
        } else {
            // Fallback only for environments where Electron secure storage is unavailable.
            data = Buffer.from(json, "utf8");
        }

        fs.writeFileSync(getTokenPath(), data, { mode: 0o600 });
        twitchToken = tokenData;
        twitchSessionState = "loaded";
        return true;
    } catch (error) {
        console.error("Ошибка сохранения Twitch-сессии:", error?.message || error);
        return false;
    }
}

function loadTwitchToken() {
    try {
        const filePath = getTokenPath();

        if (!fs.existsSync(filePath)) {
            twitchToken = null;
            twitchSessionState = "missing";
            return null;
        }

        const data = fs.readFileSync(filePath);
        let json = null;

        // Migrate older plaintext token files when secure storage is now available.
        // This keeps existing accounts working without weakening the normal storage path.
        const utf8 = data.toString("utf8").trim();
        if (utf8.startsWith("{")) {
            json = utf8;
        } else if (safeStorage.isEncryptionAvailable()) {
            json = safeStorage.decryptString(data);
        } else {
            json = utf8;
        }

        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || !parsed.accessToken) {
            throw new Error("Файл Twitch-сессии не содержит accessToken");
        }

        twitchToken = parsed;
        twitchSessionState = "loaded";

        // Migrate plaintext/legacy data to Electron secure storage when possible.
        if (safeStorage.isEncryptionAvailable() && utf8.startsWith("{")) {
            saveTwitchToken(parsed);
        }

        return twitchToken;
    } catch (error) {
        console.error("Не удалось восстановить Twitch-сессию:", error?.message || error);
        twitchToken = null;
        twitchSessionState = "invalid";

        // Keep the damaged file for diagnostics instead of repeatedly trying it.
        try {
            const filePath = getTokenPath();
            if (fs.existsSync(filePath)) {
                const backupPath = `${filePath}.corrupt-${Date.now()}`;
                fs.renameSync(filePath, backupPath);
            }
        } catch (backupError) {
            console.error("Не удалось переместить повреждённый файл Twitch-сессии:", backupError?.message || backupError);
        }

        return null;
    }
}

function deleteTwitchToken() {
    try {
        const filePath = getTokenPath();

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        twitchToken = null;
        twitchSessionState = "missing";
    } catch (error) {
        console.error("Ошибка удаления Twitch-сессии:", error?.message || error);
    }
}

/* =========================
   TWITCH TOKEN VALIDATION
========================= */

async function refreshTwitchToken() {

    if (!twitchToken?.refreshToken) {
        return false;
    }

    try {
        const response = await fetch(
            "https://id.twitch.tv/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    grant_type: "refresh_token",
                    refresh_token: twitchToken.refreshToken
                })
            }
        );

        const data = await response.json();

        if (!response.ok || !data.access_token) {
            console.error(
                "Не удалось обновить Twitch token:",
                data?.message || data?.error || response.status
            );
            if (response.status === 400 || response.status === 401) {
                twitchSessionState = "invalid";
            } else {
                twitchSessionState = "unavailable";
            }
            return false;
        }

        twitchToken = {
            ...twitchToken,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || twitchToken.refreshToken,
            expiresIn: Number(data.expires_in) || twitchToken.expiresIn || null,
            tokenType: data.token_type || twitchToken.tokenType || "bearer"
        };

        saveTwitchToken(twitchToken);
        twitchSessionState = "loaded";
        return true;
    } catch (error) {
        console.error("Ошибка обновления Twitch token:", error?.message || error);
        twitchSessionState = "unavailable";
        return false;
    }
}


async function validateTwitchToken(options = {}) {

    if (!twitchToken?.accessToken) {
        twitchSessionState = "missing";
        return false;
    }

    try {
        const response = await fetch(
            "https://id.twitch.tv/oauth2/validate",
            {
                headers: {
                    Authorization: `OAuth ${twitchToken.accessToken}`
                }
            }
        );

        const data = await response.json();

        if (!response.ok) {
            if (!options.skipRefresh && twitchToken?.refreshToken) {
                const refreshed = await refreshTwitchToken();
                if (refreshed) {
                    return validateTwitchToken({ skipRefresh: true });
                }
            }

            if (response.status === 400 || response.status === 401) {
                twitchSessionState = "invalid";
            } else {
                twitchSessionState = "unavailable";
            }
            return false;
        }

        if (data.login) {
            twitchToken.username = data.login;
        }

        if (data.user_id) {
            twitchToken.userId = data.user_id;
        }

        if (data.expires_in) {
            twitchToken.expiresIn = Number(data.expires_in);
        }

        saveTwitchToken(twitchToken);
        twitchSessionState = "valid";
        return true;
    } catch (error) {
        console.error("Ошибка проверки Twitch:", error?.message || error);
        twitchSessionState = "unavailable";

        if (!options.skipRefresh && twitchToken?.refreshToken) {
            const refreshed = await refreshTwitchToken();
            if (refreshed) {
                return validateTwitchToken({ skipRefresh: true });
            }
        }

        return false;
    }
}


/* =========================
   TWITCH LOGIN
========================= */

async function startTwitchLogin() {

    try {

        const response =
            await fetch(
                "https://id.twitch.tv/oauth2/device",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/x-www-form-urlencoded"
                    },

                    body:
                        new URLSearchParams({

                            client_id:
                                CLIENT_ID,

                            scopes:
                                "chat:read chat:edit"

                        })
                }
            );


        const data =
            await response.json();


        if (
            !response.ok
        ) {

            throw new Error(
                data.message ||
                "Ошибка авторизации Twitch"
            );

        }


        if (mainWindow) {

            mainWindow.webContents.send(
                "twitch-login-started",
                {

                    userCode:
                        data.user_code,

                    verificationUri:
                        data.verification_uri,

                    expiresIn:
                        data.expires_in

                }
            );

        }

        try {
            await shell.openExternal(data.verification_uri);
        } catch (error) {
            console.error("Не удалось открыть страницу Twitch:", error);
        }


        await pollTwitchToken(
            data.device_code,
            data.interval || 5
        );


    } catch (error) {

        console.error(
            "Twitch login error:",
            error
        );


        if (mainWindow) {

            mainWindow.webContents.send(
                "twitch-login-error",
                error.message
            );

        }

    }
}


async function pollTwitchToken(
    deviceCode,
    interval
) {

    const startTime =
        Date.now();

    const timeout =
        15 * 60 * 1000;


    while (
        Date.now() - startTime <
        timeout
    ) {

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    interval * 1000
                )
        );


        const response =
            await fetch(
                "https://id.twitch.tv/oauth2/token",
                {

                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/x-www-form-urlencoded"
                    },

                    body:
                        new URLSearchParams({

                            client_id:
                                CLIENT_ID,

                            device_code:
                                deviceCode,

                            grant_type:
                                "urn:ietf:params:oauth:grant-type:device_code"

                        })

                }
            );


        const data =
            await response.json();


        if (
            data.access_token
        ) {

            twitchToken = {

                accessToken:
                    data.access_token,

                refreshToken:
                    data.refresh_token,

                expiresIn:
                    Number(data.expires_in) || null,

                tokenType:
                    data.token_type || "bearer"

            };


            // Persist immediately so a temporary Twitch validation/network
            // failure cannot make a newly authorized account disappear after restart.
            saveTwitchToken(twitchToken);
            await validateTwitchToken();
            restartAutoChatStatusCheck();

            if (mainWindow) {

                mainWindow.webContents.send(
                    "twitch-login-success"
                );

            }


            return;

        }


        if (
            data.message ===
            "authorization_pending"
        ) {

            continue;

        }


        if (
            data.message ===
            "slow_down"
        ) {

            interval += 5;

            continue;

        }


        throw new Error(
            data.message ||
            "Авторизация Twitch не удалась"
        );

    }


    throw new Error(
        "Время авторизации Twitch истекло"
    );
}


/* =========================
   OVERLAY
========================= */
/* =========================
   OVERLAY BOUNDS STORAGE
========================= */



const overlayBoundsFile =
    path.join(
        app.getPath("userData"),
        "overlay-bounds.json"
    );


const overlaySettingsFile =
    path.join(
        app.getPath("userData"),
        "overlay-settings.json"
    );

const defaultOverlaySettings = {
    fontSize: 20, opacity: 85, maxMessages: 10, messageDuration: 30,
    usernameColor: "#ffffff", usernameStyle: "bold",
    useTwitchUsernameColor: true, readableUsernameColors: true,
    chatHorizontal: "left", chatVertical: "top",
    messageBackgroundEnabled: false, messageBackgroundOpacity: 70,
    messageBorderRadius: 6, messagePadding: 2, messageGap: 5,
    textShadowEnabled: true, emoteSize: 30, badgeSize: 20,
    emoteSpacing: 2, showTwitchEmotes: true, showBadges: true,
    showBttvEmotes: true, show7tvEmotes: true, animatedEmotes: true, showUnicodeEmotes: true,
    messageEnterEnabled: true, messageEnterType: "fade", messageEnterDuration: 0.2,
    messageExitEnabled: true, messageExitType: "fade", messageExitDuration: 0.25
};

function loadOverlaySettings() {
    try {
        if (!fs.existsSync(overlaySettingsFile)) {
            return { ...defaultOverlaySettings };
        }

        const data = JSON.parse(
            fs.readFileSync(overlaySettingsFile, "utf8")
        );

        return {
            ...defaultOverlaySettings,
            ...(data && typeof data === "object" ? data : {})
        };
    } catch (error) {
        console.error("Ошибка загрузки настроек Overlay:", error);
        return { ...defaultOverlaySettings };
    }
}

function saveOverlaySettings(settings) {
    try {
        fs.writeFileSync(
            overlaySettingsFile,
            JSON.stringify(settings, null, 4),
            "utf8"
        );
    } catch (error) {
        console.error("Ошибка сохранения настроек Overlay:", error);
    }
}

let overlaySettings = loadOverlaySettings();

/* =========================
   GENERAL SETTINGS
========================= */

const generalSettingsFile =
    path.join(
        app.getPath("userData"),
        "general-settings.json"
    );

const defaultGeneralSettings = {
    autoStart: true,
    checkUpdates: true,
    language: "Русский",
    alwaysOnTop: true,
    showMessageTime: true,
    hideEmptyMessages: false,
    autoBackgroundTheme: true,
    backgroundCheckInterval: 1,
    rememberTwitchAccount: true,
    messageFilterEnabled: false,
    messageFilterWords: "",
    autoChatStatus: false,
    messageBackdropEnabled: false
};

function loadGeneralSettings() {
    try {
        if (!fs.existsSync(generalSettingsFile)) {
            return { ...defaultGeneralSettings };
        }

        const data = JSON.parse(
            fs.readFileSync(generalSettingsFile, "utf8")
        );

        const loaded = {
            ...defaultGeneralSettings,
            ...(data && typeof data === "object" ? data : {})
        };
        if (!(data && Object.prototype.hasOwnProperty.call(data, "messageBackdropEnabled"))) {
            loaded.messageBackdropEnabled = overlaySettings.messageBackgroundEnabled === true;
        }
        return loaded;
    } catch (error) {
        console.error("Ошибка загрузки общих настроек:", error);
        return { ...defaultGeneralSettings };
    }
}

function saveGeneralSettings() {
    try {
        fs.writeFileSync(
            generalSettingsFile,
            JSON.stringify(generalSettings, null, 4),
            "utf8"
        );
    } catch (error) {
        console.error("Ошибка сохранения общих настроек:", error);
    }
}

let generalSettings = loadGeneralSettings();

function normalizeGeneralSettings() {
    generalSettings.autoStart =
        Boolean(generalSettings.autoStart);

    generalSettings.checkUpdates =
        Boolean(generalSettings.checkUpdates);

    if (
        !["Русский", "English", "Deutsch", "Українська"]
            .includes(generalSettings.language)
    ) {
        generalSettings.language = "Русский";
    }

    generalSettings.alwaysOnTop =
        Boolean(generalSettings.alwaysOnTop);

    generalSettings.showMessageTime =
        Boolean(generalSettings.showMessageTime);

    generalSettings.hideEmptyMessages =
        Boolean(generalSettings.hideEmptyMessages);

    generalSettings.autoBackgroundTheme =
        Boolean(generalSettings.autoBackgroundTheme);

    generalSettings.backgroundCheckInterval =
        Math.max(
            0.5,
            Math.min(
                60,
                Number(generalSettings.backgroundCheckInterval) || 1
            )
        );

    generalSettings.rememberTwitchAccount =
        Boolean(generalSettings.rememberTwitchAccount);
    generalSettings.messageFilterEnabled =
        Boolean(generalSettings.messageFilterEnabled);
    generalSettings.messageFilterWords =
        String(generalSettings.messageFilterWords || "");
    generalSettings.autoChatStatus =
        Boolean(generalSettings.autoChatStatus);
    generalSettings.messageBackdropEnabled =
        Boolean(generalSettings.messageBackdropEnabled);
}

normalizeGeneralSettings();

function applyAutoStartSetting() {
    try {
        app.setLoginItemSettings({
            openAtLogin: generalSettings.autoStart,
            openAsHidden: false
        });
    } catch (error) {
        console.error("Ошибка настройки автозапуска:", error);
    }
}

function sendGeneralSettings() {
    if (
        !mainWindow ||
        mainWindow.isDestroyed()
    ) {
        return;
    }

    mainWindow.webContents.send(
        "general-settings",
        generalSettings
    );

    if (
        overlayWindow &&
        !overlayWindow.isDestroyed() &&
        overlayReady
    ) {
        overlayWindow.webContents.send(
            "general-settings",
            generalSettings
        );
    }
}

function sendUpdateCheckResult(result) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("update-check-result", result);
}

async function checkForUpdates(force = false) {
    if (!app.isPackaged) {
        console.log("AutoUpdater: development mode, skipped");
        if (force) {
            sendUpdateCheckResult({
                status: "unavailable",
                currentVersion: app.getVersion(),
                error: "Проверка обновлений доступна только в установленной версии приложения."
            });
        }
        return null;
    }

    if (!force && !generalSettings.checkUpdates) {
        console.log("AutoUpdater: проверка отключена в настройках");
        return null;
    }

    if (updateCheckInProgress) {
        sendUpdateCheckResult({
            status: "checking",
            currentVersion: app.getVersion(),
            message: "Проверка уже выполняется."
        });
        return null;
    }

    updateCheckInProgress = true;
    sendUpdateCheckResult({
        status: "checking",
        currentVersion: app.getVersion()
    });

    try {
        const result = await autoUpdater.checkForUpdates();

        if (!result) {
            sendUpdateCheckResult({
                status: "unavailable",
                currentVersion: app.getVersion(),
                error: "Средство обновления недоступно."
            });
            return null;
        }

        // electron-updater emits update-available/update-not-available with
        // the authoritative result. Keep this function focused on starting
        // the check and let those events update the UI.
        return result;
    } catch (error) {
        console.error("AutoUpdater: ошибка проверки:", error);

        sendUpdateCheckResult({
            status: "unavailable",
            currentVersion: app.getVersion(),
            error: error?.message || String(error)
        });
        return null;
    } finally {
        updateCheckInProgress = false;
    }
}
function sendOverlaySettings() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("overlay-settings", overlaySettings);
    }

    if (
        !overlayWindow ||
        overlayWindow.isDestroyed() ||
        !overlayReady
    ) {
        return;
    }

    overlayWindow.setOpacity(
        Math.max(
            0,
            Math.min(
                1,
                (
                    Number.isFinite(
                        Number(overlaySettings.opacity)
                    )
                        ? Number(overlaySettings.opacity)
                        : 85
                ) / 100
            )
        )
    );

    overlayWindow.webContents.send(
        "overlay-settings",
        overlaySettings
    );

    sendSettingsToObsBrowser(overlaySettings);
}


function loadOverlayBounds() {

    try {

        if (
            !fs.existsSync(
                overlayBoundsFile
            )
        ) {

            return null;

        }


        const data =
            fs.readFileSync(
                overlayBoundsFile,
                "utf8"
            );


        const bounds =
            JSON.parse(data);


        if (
            typeof bounds.x !== "number" ||
            typeof bounds.y !== "number" ||
            typeof bounds.width !== "number" ||
            typeof bounds.height !== "number"
        ) {

            return null;

        }


        return bounds;

    } catch (error) {

        console.error(
            "Ошибка загрузки позиции Overlay:",
            error
        );
    return null;

    }

}


/* =========================
   SAVE OVERLAY BOUNDS
========================= */

function saveOverlayBounds() {

    if (
        !overlayWindow ||
        overlayWindow.isDestroyed()
    ) {

        return;

    }


    try {

        const bounds =
            overlayWindow.getBounds();


        fs.writeFileSync(
            overlayBoundsFile,
            JSON.stringify(
                {
                    x:
                        bounds.x,

                    y:
                        bounds.y,

                    width:
                        bounds.width,

                    height:
                        bounds.height
                },
                null,
                4
            ),
            "utf8"
        );


        console.log(
            "Overlay position/size saved:",
            bounds
        );

    } catch (error) {

        console.error(
            "Ошибка сохранения позиции Overlay:",
            error
        );

    }

}


function setOverlayInputPassthrough(enabled) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (enabled) {
        // На Windows полностью пропускаем клики сквозь прозрачный Overlay.
        // forward:true здесь не нужен и в некоторых случаях мешает окну настроек.
        if (process.platform === "win32") {
            overlayWindow.setIgnoreMouseEvents(true);
        } else {
            overlayWindow.setIgnoreMouseEvents(true);
        }
    } else {
        overlayWindow.setIgnoreMouseEvents(false);
    }
}

function createOverlay() {

    if (
        overlayWindow &&
        !overlayWindow.isDestroyed()
    ) {

        overlayWindow.show();

        return;

    }


    const display =
        screen.getPrimaryDisplay();

    const workArea =
        display.workArea;

    const initialWidth = 650;
    const initialHeight = 420;

    const savedOverlayBounds =
        loadOverlayBounds();

    const useSavedBounds =
        savedOverlayBounds &&
        savedOverlayBounds.width >= 300 &&
        savedOverlayBounds.height >= 150;

    const overlayBounds =
        useSavedBounds
            ? savedOverlayBounds
            : {
                x: workArea.x + 30,
                y: workArea.y + 30,
                width: initialWidth,
                height: initialHeight
            };

    overlayReady = false;

    overlayWindow =
        new BrowserWindow({

            title: "Twitch Overlay — Overlay",

            x: overlayBounds.x,
            y: overlayBounds.y,
            width: overlayBounds.width,
            height: overlayBounds.height,

            minWidth:
                300,

            minHeight:
                150,

            frame:
                false,

            transparent:
                true,

            backgroundColor:
                "#00000000",

            hasShadow:
                false,

            resizable:
                false,

            movable:
                false,

            minimizable:
                false,

            maximizable:
                false,

            closable:
                false,

            skipTaskbar:
                true,

            focusable:
                false,

            fullscreenable:
                false,

            alwaysOnTop:
                generalSettings.alwaysOnTop,

            webPreferences: {

                preload:
                    path.resolve(
                        __dirname,
                        "overlay-preload.js"
                    ),

                contextIsolation:
                    true,

                nodeIntegration:
                    false,

                sandbox:
                    false

            }

        });


    overlayWindow.setAlwaysOnTop(
        generalSettings.alwaysOnTop,
        "floating"
    );


    setOverlayInputPassthrough(true);


    overlayWindow.webContents.on(
        "preload-error",
        (
            event,
            preloadPath,
            error
        ) => {

            console.error(
                "ОШИБКА PRELOAD:",
                preloadPath,
                error
            );

        }
    );


    overlayWindow.webContents.on(
        "did-finish-load",
        () => {

            if (
                !overlayWindow ||
                overlayWindow.isDestroyed()
            ) {

                return;

            }


            overlayReady =
                true;

            // Apply edit interactivity immediately if editing was requested
            // before the overlay finished loading.
            if (overlayEditing) {
                setOverlayInputPassthrough(false);
                overlayWindow.setFocusable(true);
                overlayWindow.focus();
            }


            console.log(
                "Overlay полностью загружен"
            );

            sendOverlaySettings();

            overlayWindow.webContents.send(
                "general-settings",
                generalSettings
            );

            overlayWindow.webContents.send(
                "appearance-settings",
                appearanceSettings
            );


            overlayWindow.webContents.send(
                "overlay-edit-mode",
                overlayEditing
            );


            const queued =
                pendingOverlayMessages;

            pendingOverlayMessages =
                [];


            for (
                const queuedMessage
                of queued
            ) {

                overlayWindow.webContents.send(
                    "twitch-chat-message",
                    queuedMessage
                );

            }

        }
    );


    overlayWindow.webContents.on(
        "did-fail-load",
        (
            event,
            errorCode,
            errorDescription
        ) => {

            console.error(
                "Overlay не загрузился:",
                errorCode,
                errorDescription
            );

        }
    );


    overlayWindow.webContents.on(
        "console-message",
        (
            event,
            level,
            message
        ) => {

            console.log(
                "OVERLAY:",
                message
            );

        }
    );


    overlayWindow.loadFile(
        path.join(
            __dirname,
            "public",
            "overlay.html"
        )
    ).catch(
        (error) => {

            console.error(
                "Ошибка загрузки Overlay:",
                error
            );

        }
    );


    overlayWindow.on(
        "closed",
        () => {

            overlayReady =
                false;

            overlayEditing =
                false;

            pendingOverlayMessages =
                [];

            overlayWindow =
                null;

        }
    );

}


/* =========================
   SEND MESSAGE TO OVERLAY
========================= */

function sendMessageToOverlay(
    message
) {

    if (
        !overlayWindow ||
        overlayWindow.isDestroyed()
    ) {

        return;

    }


    if (!overlayReady) {

        pendingOverlayMessages.push(
            message
        );

        while (
            pendingOverlayMessages.length >
            50
        ) {

            pendingOverlayMessages.shift();

        }

        return;

    }


    overlayWindow.webContents.send(
        "twitch-chat-message",
        message
    );
}


/* =========================
   TWITCH BADGES
========================= */


async function loadBadgeImages(channel) {

    const cleanChannel =
        String(channel || "")
            .replace(/^#/, "")
            .trim()
            .toLowerCase();

    if (
        cleanChannel &&
        badgeImagesCacheChannel === cleanChannel &&
        Object.keys(badgeImagesCache).length > 0
    ) {
        return badgeImagesCache;
    }

    const result = {};

    try {

        const headers = {
            "Client-ID": CLIENT_ID,
            "Authorization":
                `Bearer ${twitchToken.accessToken}`
        };

        /* Global badges */
        const globalResponse =
            await fetch(
                "https://api.twitch.tv/helix/chat/badges/global",
                { headers }
            );

        if (globalResponse.ok) {

            const globalData =
                await globalResponse.json();

            for (
                const badgeSet
                of globalData.data || []
            ) {

                for (
                    const version
                    of badgeSet.versions || []
                ) {

                    result[
                        `${badgeSet.set_id}:${version.id}`
                    ] =
                        version.image_url_2x ||
                        version.image_url_1x ||
                        null;

                }

            }

        }

        /* Channel badges */
        const userResponse =
            await fetch(
                "https://api.twitch.tv/helix/users?login=" +
                encodeURIComponent(cleanChannel),
                { headers }
            );

        if (userResponse.ok) {

            const userData =
                await userResponse.json();

            const broadcasterId =
                userData.data?.[0]?.id;

            if (broadcasterId) {

                const channelResponse =
                    await fetch(
                        "https://api.twitch.tv/helix/chat/badges?broadcaster_id=" +
                        encodeURIComponent(broadcasterId),
                        { headers }
                    );

                if (channelResponse.ok) {

                    const channelData =
                        await channelResponse.json();

                    for (
                        const badgeSet
                        of channelData.data || []
                    ) {

                        for (
                            const version
                            of badgeSet.versions || []
                        ) {

                            result[
                                `${badgeSet.set_id}:${version.id}`
                            ] =
                                version.image_url_2x ||
                                version.image_url_1x ||
                                null;

                        }

                    }

                }

            }

        }

    } catch (error) {

        console.error(
            "Ошибка загрузки Twitch badges:",
            error
        );

    }

    badgeImagesCache =
        result;

    badgeImagesCacheChannel =
        cleanChannel;

    return result;
}



/* =========================
   THIRD-PARTY EMOTES
========================= */

function pickEmoteUrl(host, animated = true) {
    if (!host) return null;
    const base = String(host.url || host || "").replace(/^https?:/, "");
    if (!base) return null;

    const files = Array.isArray(host.files) ? host.files : [];
    const sizeScore = (file) => /3x/i.test(String(file?.name || "")) ? 3 : /2x/i.test(String(file?.name || "")) ? 2 : 1;

    if (animated) {
        const gif = files
            .filter(file => /gif/i.test(String(file?.format || "")) || /\.gif$/i.test(String(file?.name || "")))
            .sort((a, b) => sizeScore(b) - sizeScore(a))[0];
        if (gif?.name) return `https:${base}/${gif.name}`;

        const animatedFile = files
            .filter(file => /webp|avif/i.test(String(file?.format || "")) && /2x|3x/i.test(String(file?.name || "")))
            .sort((a, b) => sizeScore(b) - sizeScore(a))[0];
        if (animatedFile?.name) return `https:${base}/${animatedFile.name}`;
    }

    const fallback = files
        .filter(file => /2x|3x/i.test(String(file?.name || "")))
        .sort((a, b) => sizeScore(b) - sizeScore(a))[0] || files[0];

    if (fallback?.name) return `https:${base}/${fallback.name}`;
    return `https:${base}/2x.webp`;
}

async function loadThirdPartyEmotes(channel) {
    const clean = String(channel || "").replace(/^#/, "").trim().toLowerCase();
    if (!clean || !twitchToken?.userId) return;
    if (thirdPartyEmoteCacheChannel === clean && (Object.keys(thirdPartyEmoteCache.bttv).length || Object.keys(thirdPartyEmoteCache.sevenTv).length)) return;

    const bttv = {};
    const sevenTv = {};
    try {
        const globalBttv = await fetch("https://api.betterttv.net/3/cached/emotes/global");
        if (globalBttv.ok) {
            const data = await globalBttv.json();
            for (const e of data || []) if (e?.code && e?.id) bttv[e.code] = { name:e.code, url:`https://cdn.betterttv.net/emote/${e.id}/3x`, staticUrl:`https://cdn.betterttv.net/emote/${e.id}/3x`, animatedUrl:`https://cdn.betterttv.net/emote/${e.id}/3x`, provider:"bttv", animated:Boolean(e.animated || e.imageType === "gif") };
        }
    } catch (e) { console.error("BTTV global emotes:", e); }
    try {
        const userBttv = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(twitchToken.userId)}`);
        if (userBttv.ok) {
            const data = await userBttv.json();
            for (const e of [...(data.channelEmotes || []), ...(data.sharedEmotes || [])]) if (e?.code && e?.id) bttv[e.code] = { name:e.code, url:`https://cdn.betterttv.net/emote/${e.id}/3x`, staticUrl:`https://cdn.betterttv.net/emote/${e.id}/3x`, animatedUrl:`https://cdn.betterttv.net/emote/${e.id}/3x`, provider:"bttv", animated:Boolean(e.animated || e.imageType === "gif") };
        }
    } catch (e) { console.error("BTTV channel emotes:", e); }
    try {
        const global7 = await fetch("https://7tv.io/v3/emote-sets/global");
        if (global7.ok) {
            const data = await global7.json();
            for (const e of data?.emotes || []) { const id=e?.data?.id; const url=pickEmoteUrl(e?.data?.host, true) || (id ? `https://cdn.7tv.app/emote/${id}/2x.webp` : null); if(e?.name && url) { const staticUrl = pickEmoteUrl(e?.data?.host, false) || (id ? `https://cdn.7tv.app/emote/${id}/2x.webp` : url); sevenTv[e.name]={name:e.name,url,staticUrl,animatedUrl:url,provider:"7tv"}; } }
        }
    } catch (e) { console.error("7TV global emotes:", e); }
    try {
        const user7 = await fetch(`https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchToken.userId)}`);
        if (user7.ok) {
            const data = await user7.json();
            const setId = data?.emote_set_id || data?.emote_set?.id;
            if (setId) {
                const setResponse = await fetch(`https://7tv.io/v3/emote-sets/${encodeURIComponent(setId)}`);
                if (setResponse.ok) {
                    const setData = await setResponse.json();
                    for (const e of setData?.emotes || []) {
                        const id = e?.data?.id;
                        const url = pickEmoteUrl(e?.data?.host, true) || (id ? `https://cdn.7tv.app/emote/${id}/2x.webp` : null);
                        if (e?.name && url) { const staticUrl = pickEmoteUrl(e?.data?.host, false) || (id ? `https://cdn.7tv.app/emote/${id}/2x.webp` : url); sevenTv[e.name] = { name:e.name, url, staticUrl, animatedUrl:url, provider:"7tv" }; }
                    }
                }
            }
        }
    } catch (e) { console.error("7TV channel emotes:", e); }
    thirdPartyEmoteCache = { bttv, sevenTv };
    thirdPartyEmoteCacheChannel = clean;
    mainWindow?.webContents.send("third-party-emotes-loaded", { bttv:Object.keys(bttv).length, sevenTv:Object.keys(sevenTv).length });
}

function buildThirdPartyMessageEmotes(text) {
    const replacements = [];
    const maps = [];
    if (overlaySettings.showBttvEmotes !== false) maps.push(thirdPartyEmoteCache.bttv);
    if (overlaySettings.show7tvEmotes !== false) maps.push(thirdPartyEmoteCache.sevenTv);
    if (!maps.length || !text) return replacements;
    const combined = Object.assign({}, ...maps);
    const regex = /\S+/g;
    let match;
    while ((match = regex.exec(text))) {
        const raw = match[0];
        const leading = raw.match(/^[^A-Za-z0-9_~:]+/)?.[0] || "";
        const trailing = raw.match(/[^A-Za-z0-9_~:]+$/)?.[0] || "";
        const token = raw.slice(leading.length, raw.length - trailing.length || undefined);
        const emote = combined[token];
        if (!emote) continue;
        const start = match.index + leading.length;
        const end = start + token.length - 1;
        replacements.push({
            start,
            end,
            id: token,
            url: (overlaySettings.animatedEmotes !== false ? emote.animatedUrl : emote.staticUrl) || emote.url,
            name: token,
            provider: emote.provider,
            fallbackUrl: emote.staticUrl && emote.staticUrl !== ((overlaySettings.animatedEmotes !== false ? emote.animatedUrl : emote.staticUrl) || emote.url)
                ? emote.staticUrl
                : null,
            animated: Boolean(emote.animated || /\.(?:gif|webp)(?:$|[?#])/i.test(String((overlaySettings.animatedEmotes !== false ? emote.animatedUrl : emote.staticUrl) || emote.url || "")))
        });
    }
    return replacements;
}


/* =========================
   TWITCH CHAT COLOR
========================= */

const twitchColorLookupCache = new Map();
const twitchColorLookupPending = new Map();

const twitchUserColorsFile = path.join(
    app.getPath("userData"),
    "twitch-user-colors.json"
);
let twitchUserColors = {};

function normalizeTwitchColor(value) {
    const raw = String(value || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
    const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i);
    if (rgb) {
        const [r, g, b] = rgb.slice(1, 4).map(Number);
        const alpha = rgb[4] === undefined ? null : Number(rgb[4]);
        if (
            [r, g, b].every(n => n >= 0 && n <= 255) &&
            (alpha === null || (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1))
        ) {
            if (alpha === null || alpha === 1) {
                return `#${[r, g, b].map(n => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
    }
    return null;
}

function loadTwitchUserColors() {
    try {
        if (!fs.existsSync(twitchUserColorsFile)) {
            twitchUserColors = {};
            return;
        }
        const data = JSON.parse(fs.readFileSync(twitchUserColorsFile, "utf8"));
        twitchUserColors = data && typeof data === "object" ? data : {};
    } catch (error) {
        console.error("Ошибка загрузки цветов пользователей Twitch:", error);
        twitchUserColors = {};
    }
}

function saveTwitchUserColor(userId, username, color) {
    const normalized = normalizeTwitchColor(color);
    if (!normalized) return;

    const id = String(userId || "").trim();
    const name = String(username || "").trim().toLowerCase();
    if (!id && !name) return;

    if (id) twitchUserColors[`id:${id}`] = normalized;
    if (name) twitchUserColors[`name:${name}`] = normalized;

    if (id) twitchColorLookupCache.set(id, normalized);

    try {
        fs.writeFileSync(
            twitchUserColorsFile,
            JSON.stringify(twitchUserColors, null, 2),
            "utf8"
        );
    } catch (error) {
        console.error("Ошибка сохранения цвета пользователя Twitch:", error);
    }
}

function getSavedTwitchUserColor(userId, username) {
    const id = String(userId || "").trim();
    const name = String(username || "").trim().toLowerCase();
    return normalizeTwitchColor(
        (id && twitchUserColors[`id:${id}`]) ||
        (name && twitchUserColors[`name:${name}`]) ||
        null
    );
}

function getStableTwitchColor(userId, username = "") {
    const key = String(userId || username || "unknown").trim().toLowerCase();
    const palette = [
        "#FF6B6B", "#FFA94D", "#FFD43B", "#69DB7C", "#38D9A9",
        "#4DABF7", "#748FFC", "#9775FA", "#DA77F2", "#F783AC",
        "#FF8787", "#20C997", "#15AABF", "#5C7CFA", "#BE4BDB"
    ];
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
}

function resolveTwitchUsernameColor(userId, username, incomingColor = null) {
    const direct = normalizeTwitchColor(incomingColor);
    if (direct) {
        saveTwitchUserColor(userId, username, direct);
        return direct;
    }
    const saved = getSavedTwitchUserColor(userId, username);
    if (saved) return saved;
    const stable = getStableTwitchColor(userId, username);
    if (userId || username) saveTwitchUserColor(userId, username, stable);
    return stable;
}

async function getTwitchUsernameColor(userId, username = "") {
    const id = String(userId || "").trim();
    const savedColor = getSavedTwitchUserColor(id, username);
    if (savedColor) {
        twitchColorLookupCache.set(id, savedColor);
        return savedColor;
    }
    if (!id || !twitchToken?.accessToken) return null;
    if (twitchColorLookupCache.has(id)) return twitchColorLookupCache.get(id) || null;
    if (twitchColorLookupPending.has(id)) return twitchColorLookupPending.get(id);

    const promise = (async () => {
        try {
            const response = await fetch(`https://api.twitch.tv/helix/chat/color?user_id=${encodeURIComponent(id)}`, {
                headers: {
                    "Client-ID": CLIENT_ID,
                    Authorization: `Bearer ${twitchToken.accessToken}`
                }
            });
            if (!response.ok) {
                twitchColorLookupCache.set(id, null);
                return null;
            }
            const data = await response.json();
            const value = data?.data?.[0]?.color;
            const color = normalizeTwitchColor(value);
            twitchColorLookupCache.set(id, color);
            if (color) saveTwitchUserColor(id, username, color);
            return color;
        } catch (error) {
            console.warn("Не удалось получить цвет пользователя Twitch:", error?.message || error);
            twitchColorLookupCache.set(id, null);
            return null;
        } finally {
            twitchColorLookupPending.delete(id);
        }
    })();

    twitchColorLookupPending.set(id, promise);
    return promise;
}

async function connectToTwitchChat(
    channel
) {

    channel = String(channel || twitchToken?.username || "").trim();

    if (!channel) {
        throw new Error("Сначала войдите в Twitch-аккаунт");
    }

    if (
        !twitchToken?.accessToken
    ) {

        throw new Error(
            "Сначала подключите Twitch"
        );

    }


    channel =
        channel
            .replace(
                /^#/,
                ""
            )
            .trim()
            .toLowerCase();


    if (
        !channel
    ) {

        throw new Error(
            "Некорректное название канала"
        );

    }


    if (twitchClient) {

        try {

            await twitchClient.disconnect();

        } catch (_) {}

        twitchClient =
            null;

    }


    twitchClient =
        new tmi.Client({

            options: {
                debug: true
            },

            identity: {

                username:
                    twitchToken.username,

                password:
                    "oauth:" +
                    twitchToken.accessToken

            },

            channels: [
                channel
            ]

        });


    twitchClient.on(
        "connected",
        () => {

            connectedChannel =
                channel;


            console.log(
                "Twitch chat connected:",
                channel
            );


            if (mainWindow) {

                mainWindow.webContents.send(
                    "twitch-chat-connected",
                    {
                        channel
                    }
                );

            }

            // Загружаем BTTV/7TV после успешного подключения.
            loadThirdPartyEmotes(channel).catch((error) => {
                console.error("Ошибка загрузки сторонних эмотов:", error);
            });

        }
    );


    twitchClient.on(
        "message",
        async (
            channelName,
            tags,
            message,
            self
        ) => {

            if (self) {
                return;
            }

            // Фильтр «Общие» проверяем сразу, до загрузки badge/emote данных,
            // чтобы запрещённое сообщение вообще не доходило до Overlay.
            const filterWords = String(generalSettings.messageFilterWords || "")
                .split(/[\s,;]+/)
                .map(word => word.trim().toLowerCase())
                .filter(Boolean);

            if (generalSettings.messageFilterEnabled && filterWords.length) {
                const lowerMessage = String(message || "").toLowerCase();
                if (filterWords.some(word => lowerMessage.includes(word))) {
                    console.log("Message blocked by general filter");
                    return;
                }
            }

            const badges = {
                ...(tags.badges || {})
            };

            const username =
                tags["display-name"] ||
                tags.username ||
                "Unknown";

            const userId = String(tags["user-id"] || "").trim();
            const usernameKey = String(tags["username"] || username || "").trim();
            let twitchChatColor = resolveTwitchUsernameColor(
                userId,
                usernameKey,
                tags.color || tags["color"] || tags["userstate"]?.color
            );

            // Если Twitch не прислал цвет в IRC, обновляем его через Helix
            // в фоне. Сообщение не задерживаем из-за сетевого запроса.
            if (userId && !normalizeTwitchColor(tags.color || tags["color"] || tags["userstate"]?.color)) {
                getTwitchUsernameColor(userId, usernameKey).catch(() => {});
            }

            const isBroadcaster =
                !!(
                    tags.username &&
                    channelName &&
                    tags.username.toLowerCase() ===
                    channelName.replace(/^#/, "").toLowerCase()
                );

            if (isBroadcaster) {
                badges.broadcaster = "1";
            }

            if (
                tags.mod === true ||
                tags.mod === "1"
            ) {
                badges.moderator = "1";
            }

            if (
                tags.vip === true ||
                tags.vip === "1"
            ) {
                badges.vip = "1";
            }

            const badgeImages =
                await loadBadgeImages(
                    channelName
                );

            const resolvedBadgeImages = {};

            for (
                const [name, version]
                of Object.entries(badges)
            ) {

                resolvedBadgeImages[name] =
                    badgeImages[
                        `${name}:${version}`
                    ] || null;

            }

            if (generalSettings.hideEmptyMessages && !String(message || "").trim()) {
                return;
            }

            const chatMessage = {

                channel:
                    channelName,

                username:
                    username,

                message:
                    message,

color: resolveTwitchUsernameColor(
                    userId,
                    usernameKey,
                    twitchChatColor
                ),

                badges:
                    badges,

                badgeImages:
                    resolvedBadgeImages,

                badgeInfo:
                    tags["badge-info"] ||
                    {},

                emotes:
                    tags.emotes ||
                    {},

                thirdPartyEmotes:
                    buildThirdPartyMessageEmotes(message),

                userId:
                    userId ||
                    null,

                messageId:
                    String(tags.id || tags["message-id"] || "").trim() || null,

                moderator:
                    tags.mod === true ||
                    tags.mod === "1",

                broadcaster:
                    isBroadcaster,

                vip:
                    tags.vip === true ||
                    tags.vip === "1",

                timestamp:
                    Date.now()

            };

            console.log(
                `[${chatMessage.username}] ${chatMessage.message}`,
                chatMessage.badges
            );

            if (mainWindow) {

                mainWindow.webContents.send(
                    "twitch-chat-message",
                    chatMessage
                );

            }

            sendMessageToOverlay(
                chatMessage
            );
            sendMessageToObsBrowser(chatMessage);

        }
    );


    const sendChatRemoval = (payload) => {
        if (!payload) return;
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("twitch-chat-message-deleted", payload);
        }
        if (overlayWindow && !overlayWindow.isDestroyed() && overlayReady) {
            overlayWindow.webContents.send("twitch-chat-message-deleted", payload);
        }
        try { obsIo?.emit("twitch-chat-message-deleted", payload); } catch (error) {
            console.error("Ошибка удаления сообщения из OBS Browser Source:", error);
        }
    };

    const sendChatClear = (payload) => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("twitch-chat-cleared", payload || {});
        }
        if (overlayWindow && !overlayWindow.isDestroyed() && overlayReady) {
            overlayWindow.webContents.send("twitch-chat-cleared", payload || {});
        }
        try { obsIo?.emit("twitch-chat-cleared", payload || {}); } catch (error) {
            console.error("Ошибка очистки чата в OBS Browser Source:", error);
        }
    };

    // Удаление одного сообщения модератором/стримером (CLEARMSG).
    twitchClient.on("messagedeleted", (channelName, username, deletedMessage, userstate) => {
        const messageId = String(
            userstate?.["target-msg-id"] || userstate?.["message-id"] || userstate?.id || ""
        ).trim();
        if (messageId) {
            sendChatRemoval({ messageId, username: String(username || "").toLowerCase() });
        }
    });

    // При timeout/ban Twitch также убирает сообщения пользователя из чата.
    twitchClient.on("timeout", (channelName, username, reason, duration, userstate) => {
        sendChatRemoval({
            username: String(username || "").toLowerCase(),
            userId: String(userstate?.["user-id"] || "").trim(),
            removeUser: true,
            reason: "timeout"
        });
    });

    twitchClient.on("ban", (channelName, username, reason, userstate) => {
        sendChatRemoval({
            username: String(username || "").toLowerCase(),
            userId: String(userstate?.["user-id"] || "").trim(),
            removeUser: true,
            reason: "ban"
        });
    });

    // CLEARCHAT без username означает очистку всего чата.
    twitchClient.on("clearchat", (channelName, username, userstate) => {
        const target = String(username || "").trim().toLowerCase();
        if (target) {
            sendChatRemoval({
                username: target,
                userId: String(userstate?.["user-id"] || "").trim(),
                removeUser: true,
                reason: "clearchat"
            });
        } else {
            sendChatClear({ channel: channelName });
        }
    });

    twitchClient.on(
        "disconnected",
        (reason) => {

            console.log(
                "Twitch chat disconnected:",
                reason
            );


            connectedChannel =
                null;

if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
) {

    mainWindow.webContents.send(
        "twitch-chat-disconnected",
        reason
    );

}

        }
    );


    await twitchClient.connect();

}


/* =========================
   DISCONNECT CHAT
========================= */

async function disconnectFromTwitchChat() {

    if (!twitchClient) {
        return;
    }


    try {

        await twitchClient.disconnect();

    } catch (_) {}


    twitchClient =
        null;

    connectedChannel =
        null;

}


/* =========================
   WINDOW IPC
========================= */

ipcMain.on(
    "window-minimize",
    () => {

        if (mainWindow) {
            mainWindow.minimize();
        }

    }
);


ipcMain.on(
    "window-maximize",
    () => {

        if (!mainWindow) {
            return;
        }


        if (
            mainWindow.isMaximized()
        ) {

            mainWindow.unmaximize();

        } else {

            mainWindow.maximize();

        }

    }
);


ipcMain.on(
    "window-show",
    () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
    }
);

ipcMain.on(
    "window-close",
    () => {

        closeApplication();

    }
);


/* =========================
   TWITCH IPC
========================= */

ipcMain.on(
    "twitch-login",
    () => {

        startTwitchLogin();

    }
);


ipcMain.handle(
    "twitch-session-status",
    async () => {

        const valid =
            await validateTwitchToken();


        return {
            connected: valid,
            sessionPresent: Boolean(twitchToken?.accessToken),
            sessionState: twitchSessionState,
            username: twitchToken?.username || null,
            userId: twitchToken?.userId || null
        };

    }
);


ipcMain.on(
    "twitch-logout",
    async () => {

        await disconnectFromTwitchChat();

        deleteTwitchToken();


        if (mainWindow) {

            mainWindow.webContents.send(
                "twitch-logged-out"
            );

        }

    }
);


ipcMain.handle("twitch-check-channel", async (_event, channel) => {
    const clean = String(channel || twitchToken?.username || "").trim().replace(/^#/, "").toLowerCase();
    if (!clean) return { success: false, found: false, error: "Введите название Twitch-канала" };
    if (!(await validateTwitchToken())) return { success: false, found: false, error: "Сначала войдите в Twitch" };
    try {
        const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(clean)}`, {
            headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${twitchToken.accessToken}` }
        });
        if (response.status === 401) {
            const refreshed = await refreshTwitchToken();
            if (refreshed) {
                const retry = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(clean)}`, { headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${twitchToken.accessToken}` } });
                if (retry.ok) { const retryData = await retry.json(); const retryUser = Array.isArray(retryData?.data) ? retryData.data[0] : null; return retryUser ? { success: true, found: true, username: retryUser.login, displayName: retryUser.display_name } : { success: true, found: false }; }
            }
        }
        if (!response.ok) return { success: false, found: false, error: `Twitch API вернул ${response.status}` };
        const data = await response.json();
        const user = Array.isArray(data?.data) ? data.data[0] : null;
        return user ? { success: true, found: true, username: user.login, displayName: user.display_name } : { success: true, found: false };
    } catch (error) {
        return { success: false, found: false, error: error?.message || String(error) };
    }
});

ipcMain.handle(
    "twitch-connect-chat",
    async (
        event,
        channel
    ) => {

        try {

            await connectToTwitchChat(
                channel
            );


            return {
                success: true
            };

        } catch (error) {

            console.error(error);


            return {
                success: false,

                error:
                    error.message
            };

        }

    }
);


ipcMain.handle(
    "twitch-disconnect-chat",
    async () => {

        await disconnectFromTwitchChat();


        return {
            success: true
        };

    }
);



/* =========================
   GENERAL SETTINGS IPC
========================= */

ipcMain.handle(
    "general-get-settings",
    () => generalSettings
);
ipcMain.handle("app-get-version", () => app.getVersion());
ipcMain.on(
    "general-set-settings",
    (event, incoming) => {

        if (
            incoming &&
            typeof incoming === "object"
        ) {
            generalSettings = {
                ...defaultGeneralSettings,
                ...generalSettings,
                ...incoming
            };
        }

        normalizeGeneralSettings();
        saveGeneralSettings();
        applyAutoStartSetting();

        if (
            overlayWindow &&
            !overlayWindow.isDestroyed()
        ) {
            overlayWindow.setAlwaysOnTop(
                generalSettings.alwaysOnTop,
                "floating"
            );
        }

        if (twitchToken?.accessToken) {
            saveTwitchToken(twitchToken);
        }

        // Подложка для читаемости сообщений управляется из «Общие»,
        // но использует существующую настройку Overlay.
        overlaySettings.messageBackgroundEnabled =
            generalSettings.messageBackdropEnabled;
        saveOverlaySettings(overlaySettings);
        sendOverlaySettings();
        restartAutoChatStatusCheck();
        sendGeneralSettings();
    }
);

ipcMain.on(
    "general-check-updates",
    (event, force) => {
        checkForUpdates(Boolean(force));
    }
);

ipcMain.on("general-download-update", async () => {
    if (!app.isPackaged) {
        sendUpdateCheckResult({
            status: "unavailable",
            currentVersion: app.getVersion(),
            error: "Скачивание обновления доступно только в установленной версии приложения."
        });
        return;
    }

    if (updateDownloadInProgress || updateInstallScheduled) {
        return;
    }

    updateDownloadInProgress = true;
    try {
        sendUpdateCheckResult({
            status: "downloading",
            currentVersion: app.getVersion()
        });
        await autoUpdater.downloadUpdate();
    } catch (error) {
        updateDownloadInProgress = false;
        updateInstallScheduled = false;
        console.error("AutoUpdater: ошибка загрузки:", error);
        sendUpdateCheckResult({
            status: "unavailable",
            currentVersion: app.getVersion(),
            error: `Не удалось скачать обновление: ${error?.message || String(error)}`
        });
    }
});

/* =========================
   OVERLAY IPC
========================= */

ipcMain.handle(
    "overlay-get-settings",
    () => overlaySettings
);

ipcMain.on(
    "overlay-set-settings",
    (event, settings) => {

        const incoming =
            settings && typeof settings === "object"
                ? settings
                : {};

        overlaySettings = {
            ...defaultOverlaySettings,
            ...overlaySettings,
            ...incoming
        };

        {
            const n = Number(overlaySettings.fontSize);
            overlaySettings.fontSize = Number.isFinite(n)
                ? Math.max(10, Math.min(100, n))
                : 20;
        }

        {
            const opacity =
                Number(overlaySettings.opacity);

            overlaySettings.opacity =
                Number.isFinite(opacity)
                    ? Math.max(
                        0,
                        Math.min(100, opacity)
                    )
                    : 85;
        }

        {
            const n = Number(overlaySettings.maxMessages);
            overlaySettings.maxMessages = Number.isFinite(n)
                ? Math.max(1, Math.min(100, n))
                : 10;
        }

        {
            const n = Number(overlaySettings.messageDuration);
            overlaySettings.messageDuration = Number.isFinite(n)
                ? Math.max(1, Math.min(600, n))
                : 30;
        }

        if (!["left", "center", "right"].includes(overlaySettings.chatHorizontal)) {
            overlaySettings.chatHorizontal = "left";
        }

        if (!["top", "center", "bottom"].includes(overlaySettings.chatVertical)) {
            overlaySettings.chatVertical = "top";
        }

        overlaySettings.messageBackgroundEnabled = Boolean(overlaySettings.messageBackgroundEnabled);
        { const n = Number(overlaySettings.messageBackgroundOpacity); overlaySettings.messageBackgroundOpacity = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 70; }
        { const n = Number(overlaySettings.messageBorderRadius); overlaySettings.messageBorderRadius = Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : 6; }
        { const n = Number(overlaySettings.messagePadding); overlaySettings.messagePadding = Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : 2; }
        { const n = Number(overlaySettings.messageGap); overlaySettings.messageGap = Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : 5; }
        overlaySettings.textShadowEnabled = Boolean(overlaySettings.textShadowEnabled);
        {
            const n = Number(overlaySettings.emoteSize);
            overlaySettings.emoteSize = Number.isFinite(n)
                ? Math.max(16, Math.min(100, n))
                : 30;
        }
        {
            const n = Number(overlaySettings.badgeSize);
            overlaySettings.badgeSize = Number.isFinite(n)
                ? Math.max(12, Math.min(60, n))
                : 20;
        }
        { const n = Number(overlaySettings.emoteSpacing); overlaySettings.emoteSpacing = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 2; }
        overlaySettings.showTwitchEmotes = Boolean(overlaySettings.showTwitchEmotes);
        overlaySettings.showBadges = Boolean(overlaySettings.showBadges);
        overlaySettings.showBttvEmotes = Boolean(overlaySettings.showBttvEmotes);
        overlaySettings.show7tvEmotes = Boolean(overlaySettings.show7tvEmotes);
        overlaySettings.animatedEmotes = Boolean(overlaySettings.animatedEmotes);
        overlaySettings.showUnicodeEmotes = Boolean(overlaySettings.showUnicodeEmotes);

        overlaySettings.messageEnterEnabled = Boolean(overlaySettings.messageEnterEnabled);
        overlaySettings.messageExitEnabled = Boolean(overlaySettings.messageExitEnabled);

        if (!["fade", "left", "right", "top", "bottom", "scale", "none"].includes(overlaySettings.messageEnterType)) {
            overlaySettings.messageEnterType = "fade";
        }

        if (!["fade", "left", "right", "top", "bottom", "scale", "none"].includes(overlaySettings.messageExitType)) {
            overlaySettings.messageExitType = "fade";
        }

        overlaySettings.messageEnterDuration = Math.max(
            0.1,
            Math.min(2, Number(overlaySettings.messageEnterDuration) || 0.2)
        );

        overlaySettings.messageExitDuration = Math.max(
            0.1,
            Math.min(2, Number(overlaySettings.messageExitDuration) || 0.25)
        );

        if (!/^#[0-9a-fA-F]{6}$/.test(String(overlaySettings.usernameColor))) {
            overlaySettings.usernameColor = "#ffffff";
        }
        overlaySettings.useTwitchUsernameColor = overlaySettings.useTwitchUsernameColor !== false;
        overlaySettings.readableUsernameColors = overlaySettings.readableUsernameColors !== false;

        if (!["normal", "bold", "italic", "bold-italic"].includes(overlaySettings.usernameStyle)) {
            overlaySettings.usernameStyle = "bold";
        }

        saveOverlaySettings(overlaySettings);
        if (profiles?.profiles && profiles.activeProfile) {
            profiles.profiles[profiles.activeProfile] = { ...overlaySettings };
            saveProfiles();
        }
        sendOverlaySettings();
    }
);


ipcMain.on(
    "overlay-open",
    () => {

        createOverlay();

    }
);


ipcMain.on(
    "overlay-close",
    () => {

        overlayEditing =
            false;

        overlayReady =
            false;


        if (
            overlayWindow &&
            !overlayWindow.isDestroyed()
        ) {

            saveOverlayBounds();

            overlayWindow.setIgnoreMouseEvents(
                true,
                {
                    forward: true
                }
            );

            overlayWindow.destroy();

        }


        overlayWindow =
            null;

    }
);
ipcMain.on(
    "overlay-edit-toggle",
    () => {

        if (overlayEditing) {

            overlayEditing = false;

            if (
                !overlayWindow ||
                overlayWindow.isDestroyed()
            ) {
                return;
            }

            setOverlayInputPassthrough(true);

            overlayWindow.setAlwaysOnTop(
                generalSettings.alwaysOnTop,
                "floating"
            );

            overlayWindow.setFocusable(false);

            if (overlayReady) {
                overlayWindow.webContents.send(
                    "overlay-edit-mode",
                    false
                );
            }

            return;
        }

        // The first click must create the overlay and enter edit mode.
        overlayEditing = true;

        if (
            !overlayWindow ||
            overlayWindow.isDestroyed()
        ) {
            createOverlay();
            return;
        }

        overlayWindow.show();
        setOverlayInputPassthrough(false);
        overlayWindow.setFocusable(true);
        overlayWindow.focus();

        if (overlayReady) {
            overlayWindow.webContents.send(
                "overlay-edit-mode",
                true
            );
        }

    }
);
ipcMain.on(
    "overlay-edit",
    () => {

        overlayEditing = true;

        if (
            !overlayWindow ||
            overlayWindow.isDestroyed()
        ) {
            // Direct edit command also works when the overlay is not open yet.
            createOverlay();
            return;
        }

        overlayWindow.show();
        setOverlayInputPassthrough(false);
        overlayWindow.setFocusable(true);
        overlayWindow.focus();

        if (overlayReady) {
            overlayWindow.webContents.send(
                "overlay-edit-mode",
                true
            );
        }

    }
);
ipcMain.on(
    "overlay-edit-stop",
    () => {

        overlayEditing =
            false;


        if (
            !overlayWindow ||
            overlayWindow.isDestroyed()
        ) {

            return;

        }


        overlayWindow.setIgnoreMouseEvents(
            true,
            {
                forward:
                    true
            }
        );

        overlayWindow.setFocusable(
            false
        );


        if (overlayReady) {

            overlayWindow.webContents.send(
                "overlay-edit-mode",
                false
            );

        }

    }
);


/* =========================
   MOVE OVERLAY
========================= */
ipcMain.on(
    "overlay-move",
    (
        event,
        deltaX,
        deltaY
    ) => {

        if (
            !overlayEditing ||
            !overlayWindow ||
            overlayWindow.isDestroyed()
        ) {

            return;

        }


        const bounds =
            overlayWindow.getBounds();


        overlayWindow.setPosition(
            Math.round(
                bounds.x +
                Number(deltaX)
            ),
            Math.round(
                bounds.y +
                Number(deltaY)
            )
        );
saveOverlayBounds();
    }
);


/* =========================
   RESIZE OVERLAY
========================= */

ipcMain.on(
    "overlay-resize",
    (
        event,
        direction,
        deltaX,
        deltaY
    ) => {

        if (
            !overlayEditing ||
            !overlayWindow ||
            overlayWindow.isDestroyed()
        ) {
            return;
        }

        const bounds =
            overlayWindow.getBounds();

        const minWidth = 300;
        const minHeight = 150;

        let x = bounds.x;
        let y = bounds.y;
        let width = bounds.width;
        let height = bounds.height;

        const dx = Number(deltaX) || 0;
        const dy = Number(deltaY) || 0;
        const dir = String(direction || "");

        if (dir.includes("e")) {
            width = Math.max(
                minWidth,
                bounds.width + dx
            );
        }

        if (dir.includes("s")) {
            height = Math.max(
                minHeight,
                bounds.height + dy
            );
        }

        if (dir.includes("w")) {
            const proposedWidth =
                bounds.width - dx;

            if (proposedWidth >= minWidth) {
                x = bounds.x + dx;
                width = proposedWidth;
            } else {
                x = bounds.x +
                    bounds.width -
                    minWidth;
                width = minWidth;
            }
        }

        if (dir.includes("n")) {
            const proposedHeight =
                bounds.height - dy;

            if (proposedHeight >= minHeight) {
                y = bounds.y + dy;
                height = proposedHeight;
            } else {
                y = bounds.y +
                    bounds.height -
                    minHeight;
                height = minHeight;
            }
        }

        overlayWindow.setBounds({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height)
        });
saveOverlayBounds();
    }
);



/* =========================
   HOTKEYS / PROFILES / APPEARANCE
========================= */

const hotkeysFile = path.join(app.getPath("userData"), "hotkeys.json");
const profilesFile = path.join(app.getPath("userData"), "profiles.json");
const appearanceFile = path.join(app.getPath("userData"), "appearance-settings.json");

const defaultHotkeys = {
    toggleOverlay: "CommandOrControl+Shift+O",
    showSettings: "CommandOrControl+Shift+S",
    editOverlay: "CommandOrControl+Shift+M",
    toggleMessageBackdrop: "CommandOrControl+Shift+B"
};

const defaultAppearanceSettings = {
    primaryColor: "#9147ff",
    textScale: "medium",
    theme: "dark",
    overlayEditBorder: true
};

let hotkeySettings = normalizeHotkeySettings(loadJsonFile(hotkeysFile, defaultHotkeys));
let appearanceSettings = loadJsonFile(appearanceFile, defaultAppearanceSettings);
let profiles = loadJsonFile(profilesFile, {
    activeProfile: "Основной профиль",
    profiles: {
        "Основной профиль": { ...overlaySettings },
        "Игровой профиль": { ...overlaySettings }
    }
});

function loadJsonFile(file, fallback) {
    try {
        if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(fallback));
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return data && typeof data === "object"
            ? { ...JSON.parse(JSON.stringify(fallback)), ...data }
            : JSON.parse(JSON.stringify(fallback));
    } catch (error) {
        console.error("Ошибка загрузки JSON:", file, error);
        return JSON.parse(JSON.stringify(fallback));
    }
}

function saveJsonFile(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 4), "utf8");
        return true;
    } catch (error) {
        console.error("Ошибка сохранения JSON:", file, error);
        return false;
    }
}

function normalizeAccelerator(value) {
    let key = String(value || "").trim();
    if (process.platform === "win32") {
        key = key.replace(/CommandOrControl/gi, "Ctrl");
    }
    return key;
}

function normalizeHotkeySettings(settings) {
    const result = { ...defaultHotkeys, ...(settings || {}) };
    for (const action of Object.keys(result)) {
        result[action] = normalizeAccelerator(result[action]);
    }
    return result;
}

function registerHotkeys(settings = hotkeySettings) {
    const requested = normalizeHotkeySettings(settings);
    const registered = {};
    const failed = [];

    globalShortcut.unregisterAll();

    for (const [action, accelerator] of Object.entries(requested)) {
        const key = normalizeAccelerator(accelerator);
        if (!key) continue;
        try {
            const ok = globalShortcut.register(key, () => handleHotkeyAction(action));
            if (!ok) {
                console.error("Не удалось зарегистрировать горячую клавишу:", action, key);
                failed.push({ action, key });
                continue;
            }
            registered[action] = key;
        } catch (error) {
            console.error("Ошибка регистрации горячей клавиши:", action, key, error);
            failed.push({ action, key, error: String(error?.message || error) });
        }
    }

    return { success: failed.length === 0, failed, registered };
}

function registerChangedHotkeys(previousSettings, requestedSettings) {
    const previous = normalizeHotkeySettings(previousSettings);
    const requested = normalizeHotkeySettings(requestedSettings);
    const changed = Object.keys(requested).filter(
        action => normalizeAccelerator(previous[action]) !== normalizeAccelerator(requested[action])
    );

    const registeredNew = [];
    const failed = [];

    // Only touch the shortcuts that actually changed. Existing working
    // shortcuts belonging to other actions stay registered.
    for (const action of changed) {
        const oldKey = normalizeAccelerator(previous[action]);
        if (oldKey) {
            try { globalShortcut.unregister(oldKey); } catch {}
        }
    }

    for (const action of changed) {
        const key = normalizeAccelerator(requested[action]);
        if (!key) continue;
        try {
            const ok = globalShortcut.register(key, () => handleHotkeyAction(action));
            if (!ok) {
                failed.push({ action, key });
                break;
            }
            registeredNew.push({ action, key });
        } catch (error) {
            failed.push({ action, key, error: String(error?.message || error) });
            break;
        }
    }

    if (failed.length) {
        for (const item of registeredNew) {
            try { globalShortcut.unregister(item.key); } catch {}
        }
        for (const action of changed) {
            const oldKey = normalizeAccelerator(previous[action]);
            if (!oldKey) continue;
            try {
                globalShortcut.register(oldKey, () => handleHotkeyAction(action));
            } catch {}
        }
        return { success: false, failed, changed };
    }

    return { success: true, failed: [], changed };
}

function persistAndSyncHotkeys() {
    saveJsonFile(hotkeysFile, hotkeySettings);
    mainWindow?.webContents.send("hotkeys-settings", hotkeySettings);
}

function handleHotkeyAction(action) {
    if (action === "toggleOverlay") {
        if (!overlayWindow || overlayWindow.isDestroyed()) {
            createOverlay();
            return;
        }
        if (overlayWindow.isVisible()) overlayWindow.hide();
        else overlayWindow.show();
        return;
    }

    if (action === "showSettings") {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
        return;
    }

    if (action === "editOverlay") {
        // Горячая клавиша редактирования работает как переключатель:
        // первое нажатие открывает Overlay и включает режим редактирования,
        // следующее нажатие выключает режим редактирования, оставляя Overlay открытым.
        if (!overlayWindow || overlayWindow.isDestroyed()) {
            createOverlay();
            overlayEditing = true;
            return;
        }

        if (!overlayWindow.isVisible()) {
            overlayWindow.show();
            overlayEditing = true;
            overlayWindow.setIgnoreMouseEvents(false);
            overlayWindow.setFocusable(true);
            overlayWindow.focus();
            if (overlayReady) overlayWindow.webContents.send("overlay-edit-mode", true);
            return;
        }

        overlayEditing = !overlayEditing;

        if (overlayEditing) {
            overlayWindow.setIgnoreMouseEvents(false);
            overlayWindow.setFocusable(true);
            overlayWindow.focus();
        } else {
            overlayWindow.setIgnoreMouseEvents(true);
            overlayWindow.setFocusable(false);
        }

        if (overlayReady) {
            overlayWindow.webContents.send("overlay-edit-mode", overlayEditing);
        }
        return;
    }

    if (action === "toggleMessageBackdrop") {
        overlaySettings.messageBackgroundEnabled = !Boolean(overlaySettings.messageBackgroundEnabled);
        generalSettings.messageBackdropEnabled = overlaySettings.messageBackgroundEnabled;
        saveOverlaySettings(overlaySettings);
        saveGeneralSettings();
        sendOverlaySettings();
        sendGeneralSettings();
        mainWindow?.webContents.send("overlay-backdrop-hotkey-state", overlaySettings.messageBackgroundEnabled);
    }
}

function normalizeAppearanceSettings() {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(appearanceSettings.primaryColor))) {
        appearanceSettings.primaryColor = defaultAppearanceSettings.primaryColor;
    }
    if (!['small', 'medium', 'large'].includes(appearanceSettings.textScale)) {
        appearanceSettings.textScale = 'medium';
    }
    if (!['dark', 'light', 'system'].includes(appearanceSettings.theme)) {
        appearanceSettings.theme = 'dark';
    }
    appearanceSettings.overlayEditBorder = Boolean(appearanceSettings.overlayEditBorder);
    saveJsonFile(appearanceFile, appearanceSettings);
}
normalizeAppearanceSettings();

function saveProfiles() { return saveJsonFile(profilesFile, profiles); }

function normalizeProfiles() {
    if (!profiles.profiles || typeof profiles.profiles !== "object") profiles.profiles = {};
    if (!profiles.profiles["Основной профиль"]) profiles.profiles["Основной профиль"] = { ...overlaySettings };
    if (!profiles.profiles["Игровой профиль"]) profiles.profiles["Игровой профиль"] = { ...overlaySettings };
    if (!profiles.profiles[profiles.activeProfile]) profiles.activeProfile = "Основной профиль";
    saveProfiles();
}
normalizeProfiles();

ipcMain.handle("hotkeys-get-settings", () => hotkeySettings);
ipcMain.on("hotkeys-start-recording", (event, action) => {
    const current = normalizeAccelerator(hotkeySettings?.[action]);
    if (current) {
        try { globalShortcut.unregister(current); } catch {}
    }
});

ipcMain.on("hotkeys-cancel-recording", () => {
    registerHotkeys();
    persistAndSyncHotkeys();
});

ipcMain.on("hotkeys-set-settings", (event, incoming) => {
    if (!incoming || typeof incoming !== "object") return;

    const requested = normalizeHotkeySettings(incoming);
    const unique = new Set();
    for (const [action, accelerator] of Object.entries(requested)) {
        const value = normalizeAccelerator(accelerator).toLowerCase();
        if (value && unique.has(value)) {
            event.sender.send("hotkeys-save-result", {
                success: false,
                error: "Одна комбинация назначена нескольким действиям.",
                settings: hotkeySettings
            });
            registerHotkeys();
            return;
        }
        if (value) unique.add(value);
    }

    const previous = normalizeHotkeySettings(hotkeySettings);
    const result = registerChangedHotkeys(previous, requested);

    if (!result.success) {
        console.error("Hotkey save failed:", result.failed);
        event.sender.send("hotkeys-save-result", {
            success: false,
            error: result.failed?.[0]?.key
                ? `Не удалось назначить «${result.failed[0].key}». Эта глобальная комбинация сейчас недоступна в Windows.`
                : "Не удалось зарегистрировать выбранную горячую клавишу.",
            settings: hotkeySettings
        });
        return;
    }

    hotkeySettings = requested;
    persistAndSyncHotkeys();
    event.sender.send("hotkeys-save-result", {
        success: true,
        settings: hotkeySettings
    });
});

ipcMain.handle("appearance-get-settings", () => appearanceSettings);
ipcMain.on("appearance-set-settings", (event, incoming) => {
    if (incoming && typeof incoming === "object") appearanceSettings = { ...appearanceSettings, ...incoming };
    normalizeAppearanceSettings();
    mainWindow?.webContents.send("appearance-settings", appearanceSettings);
    overlayWindow?.webContents.send("appearance-settings", appearanceSettings);
});

ipcMain.handle("profiles-get", () => profiles);

function sendProfilesResult(event, success, error = undefined) {
    event.sender.send("profiles-result", {
        success,
        error,
        profiles
    });
}

ipcMain.on("profiles-create", (event, name) => {
    const clean = String(name || "").trim();
    if (!clean || clean.length > 40) {
        return sendProfilesResult(event, false, "Название профиля должно содержать от 1 до 40 символов.");
    }
    if (profiles.profiles[clean]) {
        return sendProfilesResult(event, false, "Профиль с таким именем уже существует.");
    }

    profiles.profiles[clean] = JSON.parse(JSON.stringify(overlaySettings));
    profiles.activeProfile = clean;

    const saved = saveProfiles();
    if (!saved) return sendProfilesResult(event, false, "Не удалось сохранить новый профиль.");

    sendOverlaySettings();
    sendProfilesResult(event, true);
});

ipcMain.on("profiles-select", (event, name) => {
    const clean = String(name || "").trim();
    if (!profiles.profiles[clean]) {
        return sendProfilesResult(event, false, "Профиль не найден.");
    }

    overlaySettings = {
        ...defaultOverlaySettings,
        ...JSON.parse(JSON.stringify(profiles.profiles[clean]))
    };
    profiles.activeProfile = clean;

    saveOverlaySettings(overlaySettings);
    const saved = saveProfiles();
    if (!saved) return sendProfilesResult(event, false, "Не удалось сохранить выбранный профиль.");

    sendOverlaySettings();
    sendProfilesResult(event, true);
});

ipcMain.on("profiles-update-current", (event) => {
    const active = profiles.activeProfile || "Основной профиль";
    profiles.profiles[active] = JSON.parse(JSON.stringify(overlaySettings));
    const saved = saveProfiles();
    sendProfilesResult(event, saved, saved ? undefined : "Не удалось сохранить профиль.");
});

ipcMain.on("profiles-rename", (event, oldName, newName) => {
    const oldClean = String(oldName || "").trim();
    const newClean = String(newName || "").trim();

    if (!profiles.profiles[oldClean]) {
        return sendProfilesResult(event, false, "Профиль не найден.");
    }
    if (!newClean || newClean.length > 40) {
        return sendProfilesResult(event, false, "Название профиля должно содержать от 1 до 40 символов.");
    }
    if (oldClean !== newClean && profiles.profiles[newClean]) {
        return sendProfilesResult(event, false, "Профиль с таким именем уже существует.");
    }

    if (oldClean !== newClean) {
        profiles.profiles[newClean] = profiles.profiles[oldClean];
        delete profiles.profiles[oldClean];
        if (profiles.activeProfile === oldClean) profiles.activeProfile = newClean;
    }

    const saved = saveProfiles();
    sendProfilesResult(event, saved, saved ? undefined : "Не удалось переименовать профиль.");
});

ipcMain.on("profiles-delete", (event, name) => {
    const clean = String(name || "").trim();
    if (clean === "Основной профиль") {
        return sendProfilesResult(event, false, "Основной профиль удалить нельзя.");
    }
    if (!profiles.profiles[clean]) {
        return sendProfilesResult(event, false, "Профиль не найден.");
    }

    delete profiles.profiles[clean];

    if (profiles.activeProfile === clean) {
        profiles.activeProfile = "Основной профиль";
        overlaySettings = {
            ...defaultOverlaySettings,
            ...JSON.parse(JSON.stringify(profiles.profiles[profiles.activeProfile] || {}))
        };
        saveOverlaySettings(overlaySettings);
        sendOverlaySettings();
    }

    const saved = saveProfiles();
    sendProfilesResult(event, saved, saved ? undefined : "Не удалось удалить профиль.");
});


ipcMain.handle("obs-get-settings", () => obsSettings);
ipcMain.on("obs-set-settings", (_event, incoming) => {
    if (incoming && typeof incoming === "object") obsSettings = { ...obsSettings, ...incoming };
    obsSettings.host = String(obsSettings.host || "127.0.0.1").trim() || "127.0.0.1";
    obsSettings.port = Math.max(1, Math.min(65535, Number(obsSettings.port) || 4455));
    obsSettings.password = String(obsSettings.password || "");
    saveObsSettings();
    sendObsStatus();
});
ipcMain.handle("obs-connect", () => obsConnect());
ipcMain.handle("obs-disconnect", () => { obsDisconnect(); return { success: true }; });

/* =========================
   AUTO CHAT STATUS
========================= */

let autoChatStatusTimer = null;
let lastAutoChatLive = false;

async function checkAutoChatStatus() {
    if (!generalSettings.autoChatStatus || !twitchToken?.accessToken || !twitchToken?.userId) {
        return;
    }

    try {
        const response = await fetch(
            `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(twitchToken.userId)}`,
            {
                headers: {
                    "Client-ID": CLIENT_ID,
                    Authorization: `Bearer ${twitchToken.accessToken}`
                }
            }
        );

        if (!response.ok) {
            console.error("Авто-проверка статуса чата: Twitch вернул", response.status);
            return;
        }

        const data = await response.json();
        const isLive = Array.isArray(data?.data) && data.data.length > 0;

        if (isLive && !lastAutoChatLive) {
            createOverlay();
            try {
                await connectToTwitchChat(twitchToken.username);
            } catch (error) {
                console.error("Не удалось автоматически подключить чат:", error);
            }
        }

        lastAutoChatLive = isLive;
    } catch (error) {
        console.error("Ошибка авто-проверки статуса стрима:", error);
    }
}

function restartAutoChatStatusCheck() {
    if (autoChatStatusTimer) {
        clearInterval(autoChatStatusTimer);
        autoChatStatusTimer = null;
    }

    if (!generalSettings.autoChatStatus) {
        lastAutoChatLive = false;
        return;
    }

    checkAutoChatStatus();
    autoChatStatusTimer = setInterval(checkAutoChatStatus, 30000);
}

/* =========================
   APP START
========================= */
app.whenReady().then(
    async () => {

        // Twitch-сессия хранится между перезапусками приложения.
        // Выход через кнопку «Выйти из Twitch» удаляет сохранённый токен.
        loadTwitchToken();
        loadTwitchUserColors();

        applyAutoStartSetting();
        startObsBrowserSourceServer();

        createWindow();
        createTray();
        registerHotkeys();

        setTimeout(
            () => {
                checkForUpdates();
            },
            1500
        );


        const valid =
            await validateTwitchToken();


        if (
            valid &&
            mainWindow
        ) {

            mainWindow.webContents.send(
                "twitch-session-restored"
            );

        }

        restartAutoChatStatusCheck();


        app.on(
            "activate",
            () => {

                if (
                    BrowserWindow
                        .getAllWindows()
                        .length === 0
                ) {

                    createWindow();

                }

            }
        );

    }
);


/* =========================
   MAIN WINDOW
========================= */

function createWindow() {

    mainWindow =
        new BrowserWindow({

            title: "Twitch Overlay — Настройки",

            width: 1280,

            height: 720,

            minWidth: 900,

            minHeight: 600,

            frame: false,

            backgroundColor:
                "#0e1016",

            resizable: true,

            maximizable: true,

            minimizable: true,

            webPreferences: {

                preload:
                    path.join(
                        __dirname,
                        "preload.js"
                    ),

                contextIsolation:
                    true,

                nodeIntegration:
                    false,

                sandbox:
                    false

            }

        });


    mainWindow.loadFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );


    mainWindow.on("close", () => {
        if (!app.isQuitting) {
            closeApplication();
        }
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

}


/* =========================
   CLOSE ALL WINDOWS
========================= */

app.on("before-quit", () => {
    app.isQuitting = true;
    if (autoChatStatusTimer) {
        clearInterval(autoChatStatusTimer);
        autoChatStatusTimer = null;
    }
    try { globalShortcut.unregisterAll(); } catch {}
    if (twitchClient) {
        const client = twitchClient;
        twitchClient = null;
        connectedChannel = null;
        try { client.disconnect().catch(() => {}); } catch {}
    }
    obsDisconnect();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        try { overlayWindow.destroy(); } catch {}
    }
    destroyTray();
});

app.on("will-quit", () => {
    try { globalShortcut.unregisterAll(); } catch {}
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
