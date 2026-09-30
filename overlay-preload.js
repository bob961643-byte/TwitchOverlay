const {
    contextBridge,
    ipcRenderer
} = require("electron");


contextBridge.exposeInMainWorld(
    "overlayAPI",
    {

        /* =========================
           TWITCH CHAT
        ========================= */

        onMessage: (callback) => {

            ipcRenderer.on(
                "twitch-chat-message",
                (event, message) => {
                    callback(message);
                }
            );

        },

        onMessageDeleted: (callback) => {
            ipcRenderer.on(
                "twitch-chat-message-deleted",
                (event, payload) => callback(payload)
            );
        },

        onChatCleared: (callback) => {
            ipcRenderer.on(
                "twitch-chat-cleared",
                (event, payload) => callback(payload)
            );
        },


        /* =========================
           EDIT MODE
        ========================= */

        onEditMode: (callback) => {

            ipcRenderer.on(
                "overlay-edit-mode",
                (event, enabled) => {

                    callback(
                        Boolean(enabled)
                    );

                }
            );

        },


        stopEditMode: () => {

            ipcRenderer.send(
                "overlay-edit-stop"
            );

        },


        /* =========================
           MOVE OVERLAY
        ========================= */

        move: (
            deltaX,
            deltaY
        ) => {

            ipcRenderer.send(
                "overlay-move",
                Number(deltaX) || 0,
                Number(deltaY) || 0
            );

        },


        /* =========================
           RESIZE OVERLAY
        ========================= */

        resize: (
            direction,
            deltaX,
            deltaY
        ) => {

            ipcRenderer.send(
                "overlay-resize",
                String(direction || ""),
                Number(deltaX) || 0,
                Number(deltaY) || 0
            );

        },


        /* =========================
           CHAT FONT SIZE
        ========================= */

        setChatFontSize: (
            size
        ) => {

            ipcRenderer.send(
                "chat-font-size",
                Number(size) || 20
            );

        },


        /* =========================
           RECEIVE CHAT FONT SIZE
        ========================= */

        onChatFontSize: (
            callback
        ) => {

            ipcRenderer.on(
                "chat-font-size",
                (event, size) => {

                    callback(
                        Number(size) || 20
                    );

                }
            );

        },

        onGeneralSettings: (callback) => {
            ipcRenderer.on(
                "general-settings",
                (event, settings) => callback(settings)
            );
        },

        onSettings: (callback) => {

            ipcRenderer.on(
                "overlay-settings",
                (event, settings) => {
                    callback(settings);
                }
            );

        },

        onAppearanceSettings: (callback) => {
            ipcRenderer.on(
                "appearance-settings",
                (event, settings) => callback(settings)
            );
        }

    }
);