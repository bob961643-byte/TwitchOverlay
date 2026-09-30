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
check(/function createTray\(/.test(main)&&/function closeApplication\(/.test(main),"System tray / close handler missing");
check(/twitch-check-channel/.test(main)&&/checkTwitchChannel/.test(preload),"Twitch channel check incomplete");
check(/obs-connect/.test(main)&&/connectObs/.test(preload),"OBS WebSocket controls incomplete");
check(/id="obsBrowserSourceUrl"/.test(index)&&/id="copyObsBrowserSourceUrl"/.test(index),"OBS Browser Source UI incomplete");
check(/toggleMessageBackdrop/.test(main)&&/hotkeyToggleMessageBackdrop/.test(index),"Backdrop hotkey incomplete");
check(/normalizeTwitchColor/.test(main)&&/saveTwitchUserColor/.test(main),"Twitch username color persistence pipeline missing");
check(/useTwitchUsernameColor/.test(main)&&/message\.color/.test(overlay),"Overlay applies per-message Twitch username color");
check(/manualCheckUpdatesButton/.test(index)&&/checkForUpdates/.test(preload)&&/general-check-updates/.test(main)&&/general-download-update/.test(main),"Manual update check/download pipeline missing");
check(/generalSwitchState\(\s*generalAutoStart/.test(index)&&/generalSwitchState\(\s*generalCheckUpdates/.test(index),"General checkbox persistence handler missing");
check(/autoUpdater\.autoDownload\s*=\s*false/.test(main)&&/update-available/.test(main)&&/update-downloaded/.test(main),"Updater confirmation flow missing");
check(/update-cancelled/.test(main)&&/download-progress/.test(main),"Updater error/progress events missing");
check(/requestSingleInstanceLock/.test(main)&&/second-instance/.test(main),"Single-instance protection missing");
check(/thirdPartyEmotes/.test(overlay) && /twitch-gif/.test(overlay) && /\.gif/.test(overlay),"Animated Twitch/third-party GIF renderer is present");
check(/saveTwitchToken\(twitchToken\);\s*await validateTwitchToken\(\)/.test(main),"New Twitch token is persisted before validation");
check(/twitchSessionState/.test(main) && /sessionPresent/.test(main) && /sessionState/.test(main),"Twitch session state distinguishes saved/offline/invalid sessions");
check(/Migrate older plaintext token files/.test(main) && /\.corrupt-/.test(main),"Twitch token migration/corruption handling is present");
check(/app\.requestSingleInstanceLock\(\)/.test(main) && /second-instance/.test(main),"Single-instance protection missing");


if(failed) process.exit(1);
console.log("PASS: integration/static audit");
console.log(`IPC on=${on.size}, handle=${handle.size}, HTML ids=${ids.size}`);
