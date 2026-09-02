const fs = require("fs");
const path = require("path");
const root = __dirname;
const read = p => fs.readFileSync(path.join(root,p), "utf8");
const main = read("main.js"), preload = read("preload.js"), op = read("overlay-preload.js");
const index = read("public/index.html"), overlay = read("public/overlay.html");
let failed = false;
function check(ok,msg){ if(!ok){console.error("FAIL:",msg); failed=true;} }

const on = new Set([...main.matchAll(/ipcMain\.on\(\s*["']([^"']+)["']/g)].map(x=>x[1]));
const handle = new Set([...main.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map(x=>x[1]));
for(const ch of [...preload.matchAll(/ipcRenderer\.(?:send|invoke)\(\s*["']([^"']+)["']/g)].map(x=>x[1]))
  check(on.has(ch)||handle.has(ch),`No main handler for ${ch}`);

for(const api of ["createProfile","selectProfile","updateCurrentProfile","renameProfile","deleteProfile","setHotkeys","getHotkeys","setAppearanceSettings","setOverlaySettings","setGeneralSettings","connectTwitchChat","openOverlay","editOverlay","closeOverlay"])
  check(new RegExp("\\b"+api+"\\s*:").test(preload),`Missing preload API ${api}`);

const ids = new Set([...index.matchAll(/\bid=["']([^"']+)["']/g)].map(x=>x[1]));
for(const id of [...index.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(x=>x[1]))
  check(ids.has(id)||id==="chatHorizontal"||id==="chatVertical",`Missing HTML id ${id}`);

const sends = new Set([...main.matchAll(/\.webContents\.send\(\s*["']([^"']+)["']/g)].map(x=>x[1]));
for(const ev of ["general-settings","overlay-settings","appearance-settings","twitch-chat-message","overlay-edit-mode"])
  check(sends.has(ev),`Main never sends ${ev}`);
for(const ev of ["general-settings","overlay-settings","appearance-settings","twitch-chat-message","overlay-edit-mode"])
  check(new RegExp(`ipcRenderer\\.on\\(\\s*["']${ev}["']`).test(op),`Overlay preload missing listener ${ev}`);

for(const field of ["fontSize","opacity","maxMessages","messageDuration","emoteSize","badgeSize","showTwitchEmotes","showBttvEmotes","show7tvEmotes","animatedEmotes","showUnicodeEmotes","messageEnterEnabled","messageExitEnabled"])
  check(new RegExp("\\b"+field+"\\s*:").test(main),`Overlay setting missing ${field}`);

check(/loadThirdPartyEmotes\(channel\)/.test(main),"Third-party emote loading is not invoked after chat connection");
check(/profiles-create/.test(main)&&/profiles-rename/.test(main)&&/profiles-delete/.test(main),"Profile handlers incomplete");

if(failed) process.exit(1);
console.log("PASS: integration/static audit");
console.log(`IPC on=${on.size}, handle=${handle.size}, HTML ids=${ids.size}`);
