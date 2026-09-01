const {
    BrowserWindow,
    screen,
    ipcMain
} = require("electron");

const path = require("path");

let overlayWindow = null;


/* =========================
   СОЗДАНИЕ OVERLAY
========================= */

function createOverlay() {

    const primaryDisplay =
        screen.getPrimaryDisplay();

    const {
        width,
        height
    } = primaryDisplay.bounds;


    overlayWindow =
        new BrowserWindow({

            x: 0,
            y: 0,

            width,
            height,

            frame: false,

            transparent: true,

            backgroundColor: "#00000000",

            hasShadow: false,

            resizable: false,

            movable: false,

            minimizable: false,

            maximizable: false,

            closable: false,

            skipTaskbar: true,

            alwaysOnTop: true,

            focusable: false,

            fullscreenable: false,

            webPreferences: {

                contextIsolation: true,

                nodeIntegration: false,

                sandbox: false

            }

        });


    /* =========================
       ПОВЕРХ ВСЕХ ОКОН
    ========================= */

    overlayWindow.setAlwaysOnTop(
        true,
        "screen-saver"
    );


    overlayWindow.setIgnoreMouseEvents(
        true,
        {
            forward: true
        }
    );


    /* =========================
       ЗАГРУЗКА OVERLAY
    ========================= */

    overlayWindow.loadFile(
        path.join(
            __dirname,
            "public",
            "overlay.html"
        )
    );


    /* =========================
       ЗАКРЫТИЕ
    ========================= */

    overlayWindow.on(
        "closed",
        () => {

            overlayWindow = null;

        }
    );

}


/* =========================
   ЗАПУСК
========================= */

module.exports = {
    createOverlay
};