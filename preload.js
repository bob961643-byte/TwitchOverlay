const { contextBridge, ipcRenderer, desktopCapturer } = require("electron");

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

    installUpdate: () => {
        ipcRenderer.send(
            "general-install-update"
        );
    },

    detectScreenTheme: async () => {
        try {
            const sources = await desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: {
                    width: 48,
                    height: 48
                },
                fetchWindowIcons: false
            });

            const source = sources[0];

            if (!source || !source.thumbnail) {
                return {
                    success: false,
                    theme: "dark"
                };
            }

            const image = source.thumbnail;
            const size = image.getSize();
            const bitmap = image.toBitmap();

            if (!size.width || !size.height || !bitmap.length) {
                return {
                    success: false,
                    theme: "dark"
                };
            }

            let luminanceSum = 0;
            let pixels = 0;

            for (let i = 0; i + 2 < bitmap.length; i += 4) {
                const r = bitmap[i];
                const g = bitmap[i + 1];
                const b = bitmap[i + 2];

                luminanceSum +=
                    0.2126 * r +
                    0.7152 * g +
                    0.0722 * b;

                pixels++;
            }

            const luminance =
                pixels > 0
                    ? luminanceSum / pixels
                    : 0;

            return {
                success: pixels > 0,
                theme: luminance >= 145 ? "light" : "dark",
                luminance
            };
        } catch (error) {
            console.error(
                "Ошибка определения темы по экрану:",
                error
            );

            return {
                success: false,
                theme: "dark"
            };
        }
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

    onUpdateDownloadProgress: (callback) => {
        ipcRenderer.on(
            "update-download-progress",
            (event, progress) => {
                callback(progress);
            }
        );
    },

    onUpdateDownloaded: (callback) => {
        ipcRenderer.on(
            "update-downloaded",
            (event, data) => {
                callback(data);
            }
        );
    },



    /* =========================
       HOTKEYS
    ========================= */
    getHotkeys: () => ipcRenderer.invoke("hotkeys-get-settings"),
    setHotkeys: (settings) => ipcRenderer.send("hotkeys-set-settings", settings),
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