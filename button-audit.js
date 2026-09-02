const fs = require("fs");
const html = fs.readFileSync("public/index.html", "utf8");
const required = [
  "saveButton", "resetAppearanceButton", "createProfileButton", "saveCurrentProfileButton",
  "resetHotkeysButton", "manualCheckUpdatesButton", "twitchLogin", "connectChatButton", "launchOverlayButton",
  "editOverlayButton", "closeOverlayButton", "twitchTest", "profileModal", "profileModalInput", "profileModalCancel", "profileModalConfirm"
];
for (const id of required) if (!html.includes(`id="${id}"`)) throw new Error(`Missing control ${id}`);
if (html.includes('querySelectorAll(".switch")') && html.includes("switchElement.addEventListener")) throw new Error("Generic switch handler still present");
if (html.includes('querySelectorAll(".checkbox")') && html.includes("checkbox.addEventListener")) throw new Error("Generic checkbox handler still present");
const dedicated = ["appearanceEditBorder","messageBackgroundEnabled","textShadowEnabled","showTwitchEmotes","showBadges","messageEnterEnabled","messageExitEnabled","emotesTwitchEnabled","emotesBttvEnabled","emotes7tvEnabled","emotesAnimatedEnabled","emotesUnicodeEnabled","twitchChatEnabled"];
for (const id of dedicated) if (!new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + ".*addEventListener", "s").test(html)) throw new Error(`No handler for ${id}`);

for (const id of ["generalRememberTwitchAccount","generalMessageFilterEnabled","generalMessageFilterWords","generalAutoChatStatus","generalMessageBackdropEnabled","hotkeyToggleMessageBackdrop"])
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing new control ${id}`);
if (!html.includes("openProfileModal(\"create\")") || !html.includes("openProfileModal(\"rename\"")) throw new Error("Profile modal handlers incomplete");
if (!html.includes("toggleMessageBackdrop: \"CommandOrControl+Shift+B\"")) throw new Error("Backdrop hotkey reset missing");
console.log("PASS: button/switch static audit");
