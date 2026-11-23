/* =========================
   AVATAR EFFECTS (OBS)
   Анимирует источник аватара в текущей сцене OBS без новых артов
   аватара: тряска, прыжки, вращение, масштаб — и эффекты с рукой
   (погладить по голове, утащить за кадр). Рука — отдельный источник-
   картинка в сцене, оверлей создаёт его сам и прячет после эффекта.
   После эффекта положение, поворот и масштаб аватара возвращаются как были.
========================= */

const FRAME_MS = 33;
const HAND_INPUT_NAME = "Twitch Overlay — рука";
// Фильтр цвета из прошлой версии: убираем его с аватара, если остался.
const LEGACY_COLOR_FILTER = "Twitch Overlay — цвет";

const EFFECTS = {
    shake: { label: "Тряска" },
    jump: { label: "Прыжки" },
    wobble: { label: "Покачивание" },
    spin: { label: "Вращение" },
    flip: { label: "Вверх ногами" },
    grow: { label: "Раздуться" },
    shrink: { label: "Сжаться" },
    pat: { label: "Погладить по голове", hand: true, minSec: 1.6 },
    drag: { label: "Утащить за кадр", hand: true, minSec: 3.2 }
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);
const easeIn = (v) => v * v * v;
const easeOut = (v) => 1 - Math.pow(1 - v, 3);
// Плавный вход и выход эффекта за edge секунд.
const envelope = (t, T, edge) => easeInOut(clamp01(t / edge)) * easeInOut(clamp01((T - t) / edge));
const lerp = (a, b, u) => a + (b - a) * u;

const NO_MOVE = { dx: 0, dy: 0, rot: 0, k: 1 };

/**
 * Кадр эффекта в момент t из T секунд.
 * avatar — смещение, доп. поворот и множитель масштаба аватара;
 * hand — центр, поворот и направление руки или null, если рука скрыта.
 */
function frameAt(effect, t, T, ctx) {
    const { box } = ctx;
    switch (effect) {
        case "shake": {
            const a = 16 * envelope(t, T, 0.15);
            return { avatar: { dx: a * Math.sin(t * 71), dy: a * 0.45 * Math.sin(t * 53 + 1), rot: 2.5 * (a / 16) * Math.sin(t * 61), k: 1 } };
        }
        case "jump": {
            const period = 0.55;
            const hop = Math.abs(Math.sin((Math.PI * t) / period));
            const squash = 1 + 0.06 * Math.cos((2 * Math.PI * t) / period);
            return { avatar: { dx: 0, dy: -box.h * 0.22 * hop * envelope(t, T, 0.1), rot: 0, k: 1 + (squash - 1) * envelope(t, T, 0.1) } };
        }
        case "wobble":
            return { avatar: { dx: 0, dy: 0, rot: 14 * Math.sin(2 * Math.PI * 2 * t) * envelope(t, T, 0.25), k: 1 } };
        case "spin": {
            const turns = Math.max(1, Math.round(T / 1.2));
            return { avatar: { dx: 0, dy: 0, rot: 360 * turns * easeInOut(clamp01(t / T)), k: 1 } };
        }
        case "flip":
            return { avatar: { dx: 0, dy: 0, rot: 180 * envelope(t, T, 0.35), k: 1 } };
        case "grow":
            return { avatar: { dx: 0, dy: 0, rot: 0, k: 1 + 0.35 * envelope(t, T, 0.3) + 0.03 * Math.sin(t * 9) * envelope(t, T, 0.3) } };
        case "shrink":
            return { avatar: { dx: 0, dy: 0, rot: 0, k: 1 - 0.4 * envelope(t, T, 0.3) } };
        case "pat":
            return patFrame(t, T, ctx);
        case "drag":
            return dragFrame(t, T, ctx);
        default:
            return { avatar: NO_MOVE };
    }
}

// Точка, где ладонь лежит на голове, и точка за верхним краем экрана.
function handAnchors(ctx) {
    const { box, cx, cy, hand } = ctx;
    const headY = cy - box.h / 2 + box.h * ctx.headOffset;
    return {
        restX: cx,
        // Низ руки (кончики пальцев) заходит на голову на 18% высоты руки.
        restY: headY + hand.h * 0.18 - hand.h / 2,
        offY: -hand.h * 0.7
    };
}

// Погладить: рука спускается сверху, несколько раз гладит голову и уходит.
function patFrame(t, T, ctx) {
    const { hand, cx, box } = ctx;
    const a = handAnchors(ctx);
    const enter = 0.45;
    const exit = 0.45;
    const strokeEnd = T - exit;

    if (t < enter) {
        const u = easeOut(clamp01(t / enter));
        return { avatar: NO_MOVE, hand: { x: a.restX, y: lerp(a.offY, a.restY - hand.h * 0.12, u), rot: 8 * ctx.dir } };
    }
    if (t < strokeEnd) {
        const s = t - enter;
        // Рука поднимается и опускается; в момент касания аватар чуть приседает.
        const lift = Math.abs(Math.sin(Math.PI * 2.2 * s + Math.PI / 2));
        const press = 1 - lift;
        return {
            avatar: { dx: 0, dy: box.h * 0.025 * press, rot: 2 * ctx.dir * Math.sin(s * 6), k: 1 - 0.025 * press },
            hand: { x: cx + hand.w * 0.08 * Math.sin(s * 5), y: a.restY - hand.h * 0.12 * lift, rot: 8 * ctx.dir + 4 * Math.sin(s * 5) }
        };
    }
    // Уходим вверх с той высоты, где рука была в последний момент поглаживания.
    const sEnd = Math.max(0, strokeEnd - enter);
    const liftEnd = Math.abs(Math.sin(Math.PI * 2.2 * sEnd + Math.PI / 2));
    const u = easeIn(clamp01((t - strokeEnd) / exit));
    return {
        avatar: NO_MOVE,
        hand: {
            x: cx + hand.w * 0.08 * Math.sin(sEnd * 5) * (1 - u),
            y: lerp(a.restY - hand.h * 0.12 * liftEnd, a.offY, u),
            rot: 8 * ctx.dir + 4 * Math.sin(sEnd * 5) * (1 - u)
        }
    };
}

// Утащить: рука хватает за голову, тащит аватара за ближний край экрана,
// аватар какое-то время отсутствует и прибегает обратно вприпрыжку.
function dragFrame(t, T, ctx) {
    const { hand, box, cx, canvas, dir } = ctx;
    const a = handAnchors(ctx);
    const tIn = 0.45;
    const tGrab = 0.3;
    const tPull = 0.9;
    const tBack = 1.3;
    const tAway = Math.max(0.2, T - tIn - tGrab - tPull - tBack);
    const t1 = tIn;
    const t2 = t1 + tGrab;
    const t3 = t2 + tPull;
    const t4 = t3 + tAway;

    // Насколько сдвинуть аватар, чтобы он целиком ушёл за край вместе с рукой.
    const reach = Math.max(box.w, box.h) * 0.75 + hand.w;
    const distance = dir > 0 ? canvas.w - cx + reach : cx + reach;
    const lift = -box.h * 0.1;

    if (t < t1) {
        const u = easeOut(clamp01(t / tIn));
        return { avatar: NO_MOVE, hand: { x: a.restX, y: lerp(a.offY, a.restY, u), rot: 0 } };
    }
    if (t < t2) {
        // Хватает: рука сжимает, аватар чуть приподнимается и клонится в сторону рывка.
        const u = easeInOut(clamp01((t - t1) / tGrab));
        return {
            avatar: { dx: 0, dy: lift * u, rot: 6 * dir * u, k: 1 - 0.04 * u },
            hand: { x: a.restX, y: a.restY + (lift + hand.h * 0.04) * u, rot: 10 * dir * u }
        };
    }
    if (t < t3) {
        // Тащат за голову: верх аватара наклонён туда, куда его уносят.
        const u = easeIn(clamp01((t - t2) / tPull));
        const dx = dir * distance * u;
        const dy = lift - box.h * 0.04 * Math.sin(u * Math.PI);
        const swing = 6 * dir + 10 * dir * Math.min(1, u * 3);
        return {
            avatar: { dx, dy, rot: swing, k: 0.96 },
            hand: { x: a.restX + dx, y: a.restY + dy + hand.h * 0.04, rot: 10 * dir }
        };
    }
    if (t < t4) {
        return { avatar: { dx: dir * distance, dy: 0, rot: 0, k: 1 }, hand: null };
    }
    const u = clamp01((t - t4) / tBack);
    const run = easeOut(u);
    const hops = Math.abs(Math.sin(Math.PI * u * 5));
    return {
        avatar: {
            dx: dir * distance * (1 - run),
            dy: -box.h * 0.07 * hops * (1 - u * 0.6),
            rot: -dir * 6 * Math.sin(Math.PI * u * 10) * (1 - u),
            k: 1
        },
        hand: null
    };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AvatarEffects {
    constructor({ obs }) {
        this.obs = obs;
        this.cleanedSources = new Set();
    }

    static list() {
        return Object.entries(EFFECTS).map(([id, e]) => ({ id, label: e.label, hand: Boolean(e.hand) }));
    }

    async getProgramSceneName() {
        const data = await this.obs.request("GetCurrentProgramScene");
        return data.sceneName || data.currentProgramSceneName;
    }

    // Источники текущей сцены — для выбора аватара в настройках.
    async listSources() {
        const sceneName = await this.getProgramSceneName();
        const data = await this.obs.request("GetSceneItemList", { sceneName });
        return {
            sceneName,
            sources: (data.sceneItems || [])
                .filter((item) => item.sourceName !== HAND_INPUT_NAME)
                .map((item) => ({ name: item.sourceName, kind: item.inputKind || (item.isGroup ? "group" : "scene") }))
                .reverse()
        };
    }

    async findItem(sourceName, sceneName) {
        const scene = sceneName || await this.getProgramSceneName();
        try {
            const { sceneItemId } = await this.obs.request("GetSceneItemId", { sceneName: scene, sourceName });
            return { sceneName: scene, sceneItemId };
        } catch {
            throw new Error(`В сцене «${scene}» нет источника «${sourceName}»`);
        }
    }

    async removeLegacyColorFilter(sourceName) {
        if (this.cleanedSources.has(sourceName)) return;
        this.cleanedSources.add(sourceName);
        await this.obs.request("RemoveSourceFilter", { sourceName, filterName: LEGACY_COLOR_FILTER }).catch(() => {});
    }

    /**
     * Проигрывает эффект и ждёт его окончания.
     * Ошибки OBS не пробрасываются наружу — эффект просто пропускается.
     * options.handImage — абсолютный путь к PNG руки (для эффектов с рукой).
     * options.headOffset — где голова: доля высоты аватара от верхнего края.
     */
    async play(effect, durationMs, sourceName, options = {}) {
        const spec = EFFECTS[effect];
        if (!spec) return { success: false, error: "Неизвестный эффект" };
        if (!sourceName) return { success: false, error: "Не выбран источник аватара в OBS" };
        if (!this.obs.connected) return { success: false, error: "OBS не подключён" };
        if (spec.hand && !options.handImage) return { success: false, error: "Нет картинки руки" };

        try {
            await this.removeLegacyColorFilter(sourceName);
            const durationSec = Math.max(spec.minSec || 0.3, durationMs / 1000);
            await this.playTransform(effect, durationSec, sourceName, options);
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    }

    /* ---------- рука ---------- */

    // Создаёт (или находит) источник руки в сцене, выше аватара, и скрывает его.
    async prepareHand(sceneName, avatarItemId, handImage) {
        let exists = true;
        try {
            await this.obs.request("GetInputSettings", { inputName: HAND_INPUT_NAME });
        } catch {
            exists = false;
        }

        if (!exists) {
            await this.obs.request("CreateInput", {
                sceneName,
                inputName: HAND_INPUT_NAME,
                inputKind: "image_source",
                inputSettings: { file: handImage, unload: false },
                sceneItemEnabled: false
            });
        } else {
            await this.obs.request("SetInputSettings", {
                inputName: HAND_INPUT_NAME,
                inputSettings: { file: handImage, unload: false }
            });
        }

        let sceneItemId;
        try {
            ({ sceneItemId } = await this.obs.request("GetSceneItemId", { sceneName, sourceName: HAND_INPUT_NAME }));
        } catch {
            // Источник руки уже есть, но в другой сцене — добавляем его и сюда.
            ({ sceneItemId } = await this.obs.request("CreateSceneItem", {
                sceneName,
                sourceName: HAND_INPUT_NAME,
                sceneItemEnabled: false
            }));
        }
        await this.obs.request("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: false });

        // Рука должна быть поверх аватара.
        const [{ sceneItemIndex: avatarIndex }, { sceneItemIndex: handIndex }] = await Promise.all([
            this.obs.request("GetSceneItemIndex", { sceneName, sceneItemId: avatarItemId }),
            this.obs.request("GetSceneItemIndex", { sceneName, sceneItemId })
        ]);
        if (handIndex < avatarIndex) {
            await this.obs.request("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: avatarIndex });
        }

        // Картинка грузится асинхронно — ждём, пока OBS узнает её размер.
        let size = null;
        for (let i = 0; i < 20; i++) {
            const { sceneItemTransform: tr } = await this.obs.request("GetSceneItemTransform", { sceneName, sceneItemId });
            if (tr.sourceWidth > 0 && tr.sourceHeight > 0) {
                size = { w: tr.sourceWidth, h: tr.sourceHeight };
                break;
            }
            await delay(100);
        }
        if (!size) throw new Error("OBS не смог загрузить картинку руки");

        // Отключаем границы, чтобы масштаб руки управлялся напрямую.
        await this.obs.request("SetSceneItemTransform", {
            sceneName,
            sceneItemId,
            sceneItemTransform: { boundsType: "OBS_BOUNDS_NONE", alignment: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 }
        });

        return { sceneItemId, size };
    }

    /* ---------- анимация ---------- */

    async playTransform(effect, T, sourceName, options) {
        const spec = EFFECTS[effect];
        const { sceneName, sceneItemId } = await this.findItem(sourceName);
        const { sceneItemTransform: tr } = await this.obs.request("GetSceneItemTransform", { sceneName, sceneItemId });

        const usesBounds = tr.boundsType && tr.boundsType !== "OBS_BOUNDS_NONE";
        const box = usesBounds
            ? { w: tr.boundsWidth, h: tr.boundsHeight }
            : {
                w: Math.max(1, (tr.sourceWidth - (tr.cropLeft || 0) - (tr.cropRight || 0)) * Math.abs(tr.scaleX)),
                h: Math.max(1, (tr.sourceHeight - (tr.cropTop || 0) - (tr.cropBottom || 0)) * Math.abs(tr.scaleY))
            };

        // Чтобы вращать и масштабировать вокруг центра, на время эффекта
        // переносим точку привязки в центр источника (alignment = 0).
        const align = Number(tr.alignment) || 0;
        const localX = align & 1 ? box.w / 2 : align & 2 ? -box.w / 2 : 0;
        const localY = align & 4 ? box.h / 2 : align & 8 ? -box.h / 2 : 0;
        const r0 = ((tr.rotation || 0) * Math.PI) / 180;
        const cx = tr.positionX + localX * Math.cos(r0) - localY * Math.sin(r0);
        const cy = tr.positionY + localX * Math.sin(r0) + localY * Math.cos(r0);

        const original = {
            positionX: tr.positionX,
            positionY: tr.positionY,
            rotation: tr.rotation,
            scaleX: tr.scaleX,
            scaleY: tr.scaleY,
            alignment: tr.alignment,
            ...(usesBounds ? { boundsWidth: tr.boundsWidth, boundsHeight: tr.boundsHeight } : {})
        };

        const video = await this.obs.request("GetVideoSettings");
        const canvas = { w: video.baseWidth || 1920, h: video.baseHeight || 1080 };

        const ctx = {
            box,
            cx,
            cy,
            canvas,
            // Тащим к ближнему краю; там же и рука немного наклонена.
            dir: cx > canvas.w / 2 ? 1 : -1,
            headOffset: Math.max(0, Math.min(0.6, Number(options.headOffset) || 0.1)),
            hand: { w: 0, h: 0 }
        };

        let handItem = null;
        let handScale = 1;
        let handVisible = false;
        if (spec.hand) {
            handItem = await this.prepareHand(sceneName, sceneItemId, options.handImage);
            // Ширина руки — около 45% ширины аватара.
            handScale = (box.w * 0.45) / handItem.size.w;
            ctx.hand = { w: handItem.size.w * handScale, h: handItem.size.h * handScale };
        }

        const setHandVisible = (visible) => {
            if (!handItem || visible === handVisible) return;
            handVisible = visible;
            this.obs.fire("SetSceneItemEnabled", { sceneName, sceneItemId: handItem.sceneItemId, sceneItemEnabled: visible });
        };

        const started = Date.now();

        try {
            while (this.obs.connected) {
                const t = (Date.now() - started) / 1000;
                if (t >= T) break;
                const frame = frameAt(effect, t, T, ctx);
                const f = frame.avatar || NO_MOVE;
                const next = {
                    alignment: 0,
                    positionX: cx + f.dx,
                    positionY: cy + f.dy,
                    rotation: (tr.rotation || 0) + f.rot
                };
                if (usesBounds) {
                    next.boundsWidth = tr.boundsWidth * f.k;
                    next.boundsHeight = tr.boundsHeight * f.k;
                } else {
                    next.scaleX = tr.scaleX * f.k;
                    next.scaleY = tr.scaleY * f.k;
                }
                this.obs.fire("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: next });

                if (handItem) {
                    if (frame.hand) {
                        // Сначала ставим руку на место, потом показываем — без мигания.
                        this.obs.fire("SetSceneItemTransform", {
                            sceneName,
                            sceneItemId: handItem.sceneItemId,
                            sceneItemTransform: {
                                alignment: 0,
                                positionX: frame.hand.x,
                                positionY: frame.hand.y,
                                rotation: frame.hand.rot,
                                scaleX: handScale * (ctx.dir > 0 ? 1 : -1),
                                scaleY: handScale
                            }
                        });
                        setHandVisible(true);
                    } else {
                        setHandVisible(false);
                    }
                }

                await delay(FRAME_MS);
            }
        } finally {
            if (this.obs.connected) {
                if (handItem) {
                    await this.obs.request("SetSceneItemEnabled", { sceneName, sceneItemId: handItem.sceneItemId, sceneItemEnabled: false })
                        .catch((error) => console.error("OBS: не удалось спрятать руку:", error.message));
                }
                await this.obs.request("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: original })
                    .catch((error) => console.error("OBS: не удалось вернуть положение аватара:", error.message));
            }
        }
    }
}

module.exports = { AvatarEffects, EFFECTS, HAND_INPUT_NAME };
