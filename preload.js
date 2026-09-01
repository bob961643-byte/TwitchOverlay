const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {

    /* =========================
       GENERAL SETTINGS
    ========================= */

    getGeneralSettings: () => {
        return ipcRenderer.invoke(
            "general-get-settings"
        );
    },

    setGeneralSettings: (settings) => {
        ipcRenderer.send(
            "general-set-settings",
            settings
        );
    },

    checkForUpdates: () => {
        ipcRenderer.send(
            "general-check-updates"
        );
    },

    onGeneralSettings: (callback) => {
        ipcRenderer.on(
            "general-settings",
            (event, settings) => {
                callback(settings);
            }
        );
    },

    onUpdateCheckResult: (callback) => {
        ipcRenderer.on(
            "update-check-result",
            (event, result) => {
                callback(result);
            }
        );
    },



    /* =========================
       HOTKEYS
    ========================= */
    getHotkeys: () => ipcRenderer.invoke("hotkeys-get-settings"),
    setHotkeys: (settings) => ipcRenderer.send("hotkeys-set-settings", settings),
    startHotkeyRecording: (action) => ipcRenderer.send("hotkeys-start-recording", action),
    cancelHotkeyRecording: () => ipcRenderer.send("hotkeys-cancel-recording"),
    onHotkeys: (callback) => ipcRenderer.on("hotkeys-settings", (event, settings) => callback(settings)),
    onHotkeysSaveResult: (callback) => ipcRenderer.on("hotkeys-save-result", (event, result) => callback(result)),

    /* =========================
       APPEARANCE
    ========================= */
    getAppearanceSettings: () => ipcRenderer.invoke("appearance-get-settings"),
    setAppearanceSettings: (settings) => ipcRenderer.send("appearance-set-settings", settings),
    onAppearanceSettings: (callback) => ipcRenderer.on("appearance-settings", (event, settings) => callback(settings)),

    /* =========================
       PROFILES
    ========================= */
    getProfiles: () => ipcRenderer.invoke("profiles-get"),
    createProfile: (name) => ipcRenderer.send("profiles-create", name),
    selectProfile: (name) => ipcRenderer.send("profiles-select", name),
    updateCurrentProfile: () => ipcRenderer.send("profiles-update-current"),
    renameProfile: (oldName, newName) => ipcRenderer.send("profiles-rename", oldName, newName),
    deleteProfile: (name) => ipcRenderer.send("profiles-delete", name),
    onProfilesResult: (callback) => ipcRenderer.on("profiles-result", (event, result) => callback(result)),

    /* =========================
       ОКНО
    ========================= */

    minimize: () => {
        ipcRenderer.send("window-minimize");
    },

    maximize: () => {
        ipcRenderer.send("window-maximize");
    },

    close: () => {
        ipcRenderer.send("window-close");
    },

openOverlay: () => {
    ipcRenderer.send("overlay-open");
},

closeOverlay: () => {
    ipcRenderer.send("overlay-close");
},
editOverlay: () => {
    ipcRenderer.send("overlay-edit-toggle");
},

stopEditingOverlay: () => {
    ipcRenderer.send("overlay-edit-stop");
},

getOverlaySettings: () => {
    return ipcRenderer.invoke("overlay-get-settings");
},

setOverlaySettings: (settings) => {
    ipcRenderer.send("overlay-set-settings", settings);
},

onOverlaySettings: (callback) => {
    ipcRenderer.on(
        "overlay-settings",
        (event, settings) => {
            callback(settings);
        }
    );
},
    /* =========================
       TWITCH LOGIN
    ========================= */

    twitchLogin: () => {
        ipcRenderer.send("twitch-login");
    },


    /* =========================
       TWITCH SESSION
    ========================= */

    getTwitchSessionStatus: () => {
        return ipcRenderer.invoke(
            "twitch-session-status"
        );
    },

    twitchLogout: () => {
        ipcRenderer.send("twitch-logout");
    },


    /* =========================
       TWITCH CHAT
    ========================= */

    connectTwitchChat: (channel) => {
        return ipcRenderer.invoke(
            "twitch-connect-chat",
            channel || null
        );
    },

    disconnectTwitchChat: () => {
        return ipcRenderer.invoke(
            "twitch-disconnect-chat"
        );
    },


    /* =========================
       СОБЫТИЯ АВТОРИЗАЦИИ
    ========================= */

    onTwitchLoginStarted: (callback) => {

        ipcRenderer.on(
            "twitch-login-started",
            (event, data) => {
                callback(data);
            }
        );

    },

    onTwitchLoginSuccess: (callback) => {

        ipcRenderer.on(
            "twitch-login-success",
            () => {
                callback();
            }
        );

    },

    onTwitchLoginError: (callback) => {

        ipcRenderer.on(
            "twitch-login-error",
            (event, message) => {
                callback(message);
            }
        );

    },


    /* =========================
       ВОССТАНОВЛЕНИЕ СЕССИИ
    ========================= */

    onTwitchSessionRestored: (callback) => {

        ipcRenderer.on(
            "twitch-session-restored",
            () => {
                callback();
            }
        );

    },

    onTwitchLoggedOut: (callback) => {

        ipcRenderer.on(
            "twitch-logged-out",
            () => {
                callback();
            }
        );

    },


    /* =========================
       СОБЫТИЯ ЧАТА
    ========================= */

    onTwitchChatConnected: (callback) => {

        ipcRenderer.on(
            "twitch-chat-connected",
            (event, data) => {
                callback(data);
            }
        );

    },

    onTwitchChatDisconnected: (callback) => {

        ipcRenderer.on(
            "twitch-chat-disconnected",
            (event, reason) => {
                callback(reason);
            }
        );

    },

    onTwitchChatMessage: (callback) => {

        ipcRenderer.on(
            "twitch-chat-message",
            (event, message) => {
                callback(message);
            }
        );

    },

    onThirdPartyEmotesLoaded: (callback) => {
        ipcRenderer.on("third-party-emotes-loaded", (event, data) => callback(data));
    }

});