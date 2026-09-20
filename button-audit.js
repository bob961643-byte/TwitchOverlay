const fs = require("fs");
const html = fs.readFileSync("public/index.html", "utf8");

const required = [
  "saveButton",
  "resetAppearanceButton",
  "createProfileButton",
  "saveCurrentProfileButton",
  "resetHotkeysButton",
  "manualCheckUpdatesButton",
  "twitchLogin",
  "connectChatButton",
  "launchOverlayButton",
  "editOverlayButton",
  "closeOverlayButton",
  "twitchTest"
];

for (const id of required) {
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Missing control ${id}`);
  }
}

const dedicated = [
  "appearanceEditBorder",
  "messageBackgroundEnabled",
  "textShadowEnabled",
  "showTwitchEmotes",
  "showBadges",
  "messageEnterEnabled",
  "messageExitEnabled",
  "emotesTwitchEnabled",
  "emotesBttvEnabled",
  "emotes7tvEnabled",
  "emotesAnimatedEnabled",
  "emotesUnicodeEnabled",
  "twitchChatEnabled"
];

for (const id of dedicated) {
  if (!new RegExp(
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    ".*addEventListener",
    "s"
  ).test(html)) {
    throw new Error(`No handler for ${id}`);
  }
}

if (!html.includes("window.electronAPI?.checkForUpdates?.(true)")) {
  throw new Error("Manual update button is not connected to checkForUpdates");
}
if (!html.includes("window.electronAPI?.downloadUpdate?.()")) {
  throw new Error("Update confirmation is not connected to downloadUpdate");
}

console.log("PASS: button/switch static audit");
