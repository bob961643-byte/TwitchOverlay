const fs = require("fs");
const html = fs.readFileSync("public/index.html", "utf8");
const required = [
  "saveButton", "resetAppearanceButton", "createProfileButton", "saveCurrentProfileButton",
  "resetHotkeysButton", "twitchLogin", "connectChatButton", "launchOverlayButton",
  "editOverlayButton", "closeOverlayButton", "twitchTest", "profileModalCancel", "profileModalConfirm"
];
for (const id of required) if (!html.includes(`id="${id}"`)) throw new Error(`Missing control ${id}`);
if (html.includes('querySelectorAll(".switch")') && html.includes("switchElement.addEventListener")) throw new Error("Generic switch handler still present");
const dedicated = ["appearanceEditBorder","messageBackgroundEnabled","textShadowEnabled","showTwitchEmotes","showBadges","messageEnterEnabled","messageExitEnabled","emotesTwitchEnabled","emotesBttvEnabled","emotes7tvEnabled","emotesAnimatedEnabled","emotesUnicodeEnabled","twitchChatEnabled"];
for (const id of dedicated) if (!new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + ".*addEventListener", "s").test(html)) throw new Error(`No handler for ${id}`);
console.log("PASS: button/switch static audit");
