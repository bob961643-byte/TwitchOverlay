/* =========================
   AVATAR EFFECTS (OBS)
   Анимирует источник аватара в текущей сцене OBS без новых артов
   аватара: тряска, прыжки, вращение, масштаб — и эффекты с рукой
   (погладить по голове, утащить за кадр), и брошенный в аватара предмет.
   Рука и предмет — отдельные источники-картинки в сцене, оверлей создаёт
   их сам и прячет после эффекта.
   После эффекта положение, поворот и масштаб аватара возвращаются как были.
========================= */

const FRAME_MS = 33;
const HAND_INPUT_NAME = "Twitch Overlay — рука";
const ITEM_INPUT_NAME = "Twitch Overlay — предмет";
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
    // Сторона случайная: влево, вправо, вверх или вниз.
    // Минимум покрывает самый длинный вариант: рывок до 1,5 с и возвращение
    // снизу с выглядыванием головы (2,4 с).
    drag: { label: "Утащить за кадр", hand: true, minSec: 5 },
    // Предмет прилетает сбоку по дуге, попадает в голову и отскакивает вниз.
    throw: { label: "Бросить предмет", item: true, minSec: 2 }
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);
const easeIn = (v) => v * v * v;
const easeOut = (v) => 1 - Math.pow(1 - v, 3);
// Плавный вход и выход эффекта за edge секунд.
const envelope = (t, T, edge) => easeInOut(clamp01(t / edge)) * easeInOut(clamp01((T - t) / edge));
const lerp = (a, b, u) => a + (b - a) * u;
// OBS WebSocket отклоняет поворот вне −360…360°, поэтому приводим угол
// к 0…360 — на экране он выглядит так же.
const obsAngle = (deg) => ((deg % 360) + 360) % 360;

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
        case "throw":
            return throwFrame(t, T, ctx);
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

// Точка, где рука снизу (пальцами вверх) держит ноги, и точка за нижним краем.
function feetAnchors(ctx) {
    const { box, cx, cy, hand, canvas } = ctx;
    // Низ аватара, но не ниже точки, где над краем кадра ещё видна ладонь:
    // если аватар стоит в углу и ноги за экраном, рука хватает у края.
    const base = Math.min(cy + box.h / 2, canvas.h - hand.h * 0.3);
    // Ползунок «Где ноги» поднимает точку хвата от этой базы.
    const feetY = base - box.h * ctx.feetOffset;
    return {
        restX: cx,
        // Кончики пальцев заходят на ноги на 18% высоты руки.
        restY: feetY - hand.h * 0.18 + hand.h / 2,
        offY: canvas.h + hand.h * 0.7
    };
}

const DRAG_WAYS = ["left", "right", "up", "down"];

const easeOutBack = (v) => {
    const c = 1.6;
    return 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2);
};
const bounceOut = (v) => {
    const n = 7.5625;
    const d = 2.75;
    if (v < 1 / d) return n * v * v;
    if (v < 2 / d) return n * (v -= 1.5 / d) * v + 0.75;
    if (v < 2.5 / d) return n * (v -= 2.25 / d) * v + 0.9375;
    return n * (v -= 2.625 / d) * v + 0.984375;
};

/**
 * Утащить: рука хватает аватара и утаскивает за край экрана в сторону
 * ctx.dragWay (влево, вправо, вверх или вниз). Влево/вправо/вверх — рука
 * сверху держит за голову; вниз — рука снизу держит за ноги.
 * Затем аватар возвращается: прибегает вприпрыжку, падает сверху
 * или выпрыгивает снизу.
 */
function dragFrame(t, T, ctx) {
    const { hand, box, cx, cy, canvas } = ctx;
    const way = ctx.dragWay || "right";
    const fromBelow = way === "down";
    const a = fromBelow ? feetAnchors(ctx) : handAnchors(ctx);
    const vx = way === "right" ? 1 : way === "left" ? -1 : 0;
    const vy = way === "down" ? 1 : way === "up" ? -1 : 0;

    // Насколько сдвинуть аватар, чтобы он целиком ушёл за край вместе с рукой.
    const reach = Math.max(box.w, box.h) * 0.75 + Math.max(hand.w, hand.h);
    const distance =
        way === "right" ? canvas.w - cx + reach :
        way === "left" ? cx + reach :
        way === "up" ? cy + reach :
        canvas.h - cy + reach;

    // Схватили: сверху аватара приподнимают, снизу — прижимают вниз.
    const lift = fromBelow ? box.h * 0.06 : -box.h * 0.1;
    // Рука снизу перевёрнута пальцами вверх; сжатие — в сторону аватара.
    const handBase = fromBelow ? 180 : 0;
    const squeeze = (fromBelow ? -1 : 1) * hand.h * 0.04;
    // Наклон: вбок — туда, куда тащат; вверх/вниз — аватар болтается.
    const tiltSide = vx || ctx.dir;

    // Чем дальше тащить, тем дольше рывок и возвращение.
    const tIn = 0.45;
    const tGrab = 0.3;
    const tPull = Math.max(0.9, Math.min(1.5, distance / 1400));
    // Снизу кот сперва секунду выглядывает головой, поэтому возвращение дольше.
    const PEEK_RISE = 0.4;
    const PEEK_HOLD = 1.0;
    const PEEK_DIP = 0.15;
    const PEEK_JUMP = 0.85;
    const tBack = fromBelow
        ? PEEK_RISE + PEEK_HOLD + PEEK_DIP + PEEK_JUMP
        : Math.max(1.3, Math.min(2.0, distance / 1100));
    const tAway = Math.max(0.2, T - tIn - tGrab - tPull - tBack);
    const t1 = tIn;
    const t2 = t1 + tGrab;
    const t3 = t2 + tPull;
    const t4 = t3 + tAway;

    if (t < t1) {
        const u = easeOut(clamp01(t / tIn));
        return { avatar: NO_MOVE, hand: { x: a.restX, y: lerp(a.offY, a.restY, u), rot: handBase } };
    }
    if (t < t2) {
        const u = easeInOut(clamp01((t - t1) / tGrab));
        const tilt = vx ? 6 * vx * u : 0;
        return {
            avatar: { dx: 0, dy: lift * u, rot: tilt, k: 1 - 0.04 * u },
            hand: { x: a.restX, y: a.restY + (lift + squeeze) * u, rot: handBase + (vx ? 10 * vx * u : 0) }
        };
    }
    if (t < t3) {
        const u = easeIn(clamp01((t - t2) / tPull));
        const d = distance * u;
        const dx = vx * d;
        const dy = lift + vy * d - (vx ? box.h * 0.04 * Math.sin(u * Math.PI) : 0);
        // Вбок: верх аватара наклонён туда, куда его уносят; вверх/вниз — раскачивается.
        const rot = vx
            ? 6 * vx + 10 * vx * Math.min(1, u * 3)
            : 7 * tiltSide * Math.sin((t - t2) * 13) * Math.min(1, u * 4);
        return {
            avatar: { dx, dy, rot, k: 0.96 },
            hand: { x: a.restX + dx, y: a.restY + dy + squeeze, rot: handBase + (vx ? 10 * vx : rot * 0.4) }
        };
    }
    if (t < t4) {
        return { avatar: { dx: vx * distance, dy: vy * distance, rot: 0, k: 1 }, hand: null };
    }

    const u = clamp01((t - t4) / tBack);
    if (vx) {
        // Прибегает вприпрыжку с той стороны, куда утащили.
        const run = easeOut(u);
        const hops = Math.abs(Math.sin(Math.PI * u * 5));
        return {
            avatar: {
                dx: vx * distance * (1 - run),
                dy: -box.h * 0.07 * hops * (1 - u * 0.6),
                rot: -vx * 6 * Math.sin(Math.PI * u * 10) * (1 - u),
                k: 1
            },
            hand: null
        };
    }
    if (way === "up") {
        // Падает сверху и пару раз подскакивает при приземлении.
        const fall = bounceOut(u);
        // Последний подскок плавно гасим, чтобы в конце не было рывка на место.
        const settle = 1 - easeInOut(clamp01((u - 0.85) / 0.15));
        return {
            avatar: { dx: 0, dy: -distance * (1 - fall) * settle, rot: 4 * tiltSide * Math.sin(u * 12) * (1 - u), k: 1 },
            hand: null
        };
    }
    // Снизу: сперва из-за нижнего края высовывается голова, кот секунду
    // осматривается, приседает и выпрыгивает целиком на своё место.
    const s = t - t4;
    // Видна голова: отступ до головы плюс примерно четверть высоты аватара.
    const peekShow = box.h * (ctx.headOffset + 0.28);
    const topAtRest = cy - box.h / 2;
    const peekDy = Math.max(0, canvas.h - peekShow - topAtRest);

    if (s < PEEK_RISE) {
        const v = easeOut(clamp01(s / PEEK_RISE));
        return { avatar: { dx: 0, dy: lerp(distance, peekDy, v), rot: 0, k: 1 }, hand: null };
    }
    if (s < PEEK_RISE + PEEK_HOLD) {
        // Осматривается: покачивает головой влево-вправо и чуть приподнимается.
        const h = s - PEEK_RISE;
        const look = Math.sin((h / PEEK_HOLD) * Math.PI * 2);
        const fade = Math.sin((h / PEEK_HOLD) * Math.PI);
        return {
            avatar: { dx: 0, dy: peekDy - box.h * 0.03 * fade, rot: 7 * tiltSide * look * fade, k: 1 },
            hand: null
        };
    }
    if (s < PEEK_RISE + PEEK_HOLD + PEEK_DIP) {
        // Приседает перед прыжком.
        const v = easeInOut(clamp01((s - PEEK_RISE - PEEK_HOLD) / PEEK_DIP));
        return { avatar: { dx: 0, dy: peekDy + box.h * 0.06 * v, rot: 0, k: 1 }, hand: null };
    }
    // Выпрыгивает, чуть перелетает своё место и опускается обратно.
    const v = clamp01((s - PEEK_RISE - PEEK_HOLD - PEEK_DIP) / PEEK_JUMP);
    const jump = easeOutBack(v);
    const from = peekDy + box.h * 0.06;
    return {
        avatar: { dx: 0, dy: from * (1 - jump), rot: 5 * tiltSide * Math.sin(v * 9) * (1 - v), k: 1 },
        hand: null
    };
}

/* ---------- бросок предмета ---------- */

const THROW_FLY = 0.6;
const THROW_GRAVITY = 2600;

// Случайные параметры одного броска: откуда летит, как высоко и куда попадает.
function randomThrow() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    return {
        side: Math.random() < 0.5 ? -1 : 1,
        startY: rnd(0.2, 0.55),
        arc: rnd(0.12, 0.28),
        spin: Math.random() < 0.5 ? -1 : 1,
        hitX: rnd(-0.08, 0.08),
        bounce: rnd(220, 380)
    };
}

/**
 * Бросок: предмет вылетает из-за края экрана, летит по дуге с вращением,
 * попадает аватару в голову, сплющивается от удара и отскакивает вниз
 * за кадр. Аватара от удара отбрасывает и покачивает.
 */
function throwFrame(t, T, ctx) {
    const { box, cx, cy, canvas, item } = ctx;
    const p = ctx.throwParams;
    const sx = p.side < 0 ? -item.w : canvas.w + item.w;
    const sy = canvas.h * p.startY;
    const px = cx + box.w * p.hitX;
    const py = cy - box.h / 2 + box.h * (ctx.headOffset + 0.15);
    const push = Math.sign(px - sx) || 1;
    const arcH = canvas.h * p.arc;

    if (t < THROW_FLY) {
        const u = t / THROW_FLY;
        return {
            avatar: NO_MOVE,
            item: {
                x: lerp(sx, px, u),
                y: lerp(sy, py, u) - arcH * 4 * u * (1 - u),
                rot: p.spin * 540 * u,
                sx: 1,
                sy: 1
            }
        };
    }

    const s = t - THROW_FLY;
    // Удар: резкий толчок и затухающее покачивание.
    const hit = (1 - Math.exp(-30 * s)) * Math.exp(-3.5 * s);
    const jitter = 3 * Math.sin(s * 40) * Math.exp(-6 * s);
    const avatar = {
        dx: push * box.w * 0.09 * hit + jitter,
        dy: -box.h * 0.02 * hit,
        rot: push * 12 * hit,
        k: 1 - 0.07 * Math.exp(-9 * s)
    };

    // Предмет отскакивает назад и вверх, затем падает под действием тяжести.
    const ix = px - push * p.bounce * s;
    const iy = py - 520 * s + 0.5 * THROW_GRAVITY * s * s;
    if (iy - item.h / 2 > canvas.h) return { avatar, item: null };
    const squash = s < 0.1 ? 1 - s / 0.1 : 0;
    return {
        avatar,
        item: {
            x: ix,
            y: iy,
            rot: p.spin * (540 + 400 * s),
            sx: 1 + 0.3 * squash,
            sy: 1 - 0.3 * squash
        }
    };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AvatarEffects {
    constructor({ obs }) {
        this.obs = obs;
        this.cleanedSources = new Set();
        this.lastDragWay = null;
    }

    // Случайная сторона для «Утащить», не повторяя прошлую подряд.
    pickDragWay() {
        const options = DRAG_WAYS.filter((way) => way !== this.lastDragWay);
        this.lastDragWay = options[Math.floor(Math.random() * options.length)];
        return this.lastDragWay;
    }

    static list() {
        return Object.entries(EFFECTS).map(([id, e]) => ({ id, label: e.label, hand: Boolean(e.hand), item: Boolean(e.item) }));
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
                .filter((item) => item.sourceName !== HAND_INPUT_NAME && item.sourceName !== ITEM_INPUT_NAME)
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
     * options.feetOffset — где ноги: доля высоты аватара от нижнего края.
     * options.itemImage — абсолютный путь к картинке брошенного предмета.
     */
    async play(effect, durationMs, sourceName, options = {}) {
        const spec = EFFECTS[effect];
        if (!spec) return { success: false, error: "Неизвестный эффект" };
        if (!sourceName) return { success: false, error: "Не выбран источник аватара в OBS" };
        if (!this.obs.connected) return { success: false, error: "OBS не подключён" };
        if (spec.hand && !options.handImage) return { success: false, error: "Нет картинки руки" };
        if (spec.item && !options.itemImage) return { success: false, error: "Нет картинки предмета" };

        try {
            await this.removeLegacyColorFilter(sourceName);
            const durationSec = Math.max(spec.minSec || 0.3, durationMs / 1000);
            await this.playTransform(effect, durationSec, sourceName, options);
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    }

    /* ---------- рука и предмет ---------- */

    /**
     * Создаёт (или находит) источник-картинку inputName в сцене, выше аватара,
     * ставит ему файл file и скрывает. Возвращает id элемента сцены и размер картинки.
     */
    async prepareImageOverlay(sceneName, avatarItemId, inputName, file, what) {
        let previousFile = null;
        try {
            const { inputSettings } = await this.obs.request("GetInputSettings", { inputName });
            previousFile = inputSettings?.file ?? "";
        } catch {
            previousFile = null;
        }

        if (previousFile === null) {
            await this.obs.request("CreateInput", {
                sceneName,
                inputName,
                inputKind: "image_source",
                inputSettings: { file, unload: false },
                sceneItemEnabled: false
            });
        } else if (previousFile !== file) {
            await this.obs.request("SetInputSettings", { inputName, inputSettings: { file, unload: false } });
        }

        let sceneItemId;
        try {
            ({ sceneItemId } = await this.obs.request("GetSceneItemId", { sceneName, sourceName: inputName }));
        } catch {
            // Источник уже есть, но в другой сцене — добавляем его и сюда.
            ({ sceneItemId } = await this.obs.request("CreateSceneItem", {
                sceneName,
                sourceName: inputName,
                sceneItemEnabled: false
            }));
        }
        await this.obs.request("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: false });

        // Картинка должна быть поверх аватара.
        const [{ sceneItemIndex: avatarIndex }, { sceneItemIndex: ownIndex }] = await Promise.all([
            this.obs.request("GetSceneItemIndex", { sceneName, sceneItemId: avatarItemId }),
            this.obs.request("GetSceneItemIndex", { sceneName, sceneItemId })
        ]);
        if (ownIndex < avatarIndex) {
            await this.obs.request("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: avatarIndex });
        }

        // Картинка грузится асинхронно — ждём, пока OBS узнает её размер.
        // Если файл сменили, даём OBS время перечитать его, иначе размер будет от старого.
        if (previousFile !== null && previousFile !== file) await delay(250);
        let size = null;
        for (let i = 0; i < 20; i++) {
            const { sceneItemTransform: tr } = await this.obs.request("GetSceneItemTransform", { sceneName, sceneItemId });
            if (tr.sourceWidth > 0 && tr.sourceHeight > 0) {
                size = { w: tr.sourceWidth, h: tr.sourceHeight };
                break;
            }
            await delay(100);
        }
        if (!size) throw new Error(`OBS не смог загрузить картинку ${what}`);

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
            // Куда наклонена рука при поглаживании; сторона «Утащить» — случайная.
            dir: cx > canvas.w / 2 ? -1 : 1,
            dragWay: effect === "drag" ? (options.dragWay || this.pickDragWay()) : null,
            throwParams: effect === "throw" ? { ...randomThrow(), ...(options.throwParams || {}) } : null,
            headOffset: Math.max(0, Math.min(0.6, Number(options.headOffset ?? 0.1) || 0)),
            feetOffset: Math.max(0, Math.min(0.6, Number(options.feetOffset ?? 0.04) || 0)),
            hand: { w: 0, h: 0 },
            item: { w: 0, h: 0 }
        };

        // Картинки поверх аватара: рука и брошенный предмет.
        const overlays = {};
        if (spec.hand) {
            const prepared = await this.prepareImageOverlay(sceneName, sceneItemId, HAND_INPUT_NAME, options.handImage, "руки");
            // Ширина руки — около 45% ширины аватара; зеркалим её по стороне.
            const scale = (box.w * 0.45) / prepared.size.w;
            ctx.hand = { w: prepared.size.w * scale, h: prepared.size.h * scale };
            overlays.hand = { ...prepared, scale, mirror: ctx.dir > 0 ? 1 : -1, visible: false };
        }
        if (spec.item) {
            const prepared = await this.prepareImageOverlay(sceneName, sceneItemId, ITEM_INPUT_NAME, options.itemImage, "предмета");
            // Предмет — около трети ширины аватара по большей стороне.
            const scale = (box.w * 0.32) / Math.max(prepared.size.w, prepared.size.h);
            ctx.item = { w: prepared.size.w * scale, h: prepared.size.h * scale };
            overlays.item = { ...prepared, scale, mirror: 1, visible: false };
        }

        const setOverlayVisible = (overlay, visible) => {
            if (visible === overlay.visible) return;
            overlay.visible = visible;
            this.obs.fire("SetSceneItemEnabled", { sceneName, sceneItemId: overlay.sceneItemId, sceneItemEnabled: visible });
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
                    rotation: obsAngle((tr.rotation || 0) + f.rot)
                };
                if (usesBounds) {
                    next.boundsWidth = tr.boundsWidth * f.k;
                    next.boundsHeight = tr.boundsHeight * f.k;
                } else {
                    next.scaleX = tr.scaleX * f.k;
                    next.scaleY = tr.scaleY * f.k;
                }
                this.obs.fire("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: next });

                for (const [key, overlay] of Object.entries(overlays)) {
                    const pose = frame[key];
                    if (pose) {
                        // Сначала ставим картинку на место, потом показываем — без мигания.
                        this.obs.fire("SetSceneItemTransform", {
                            sceneName,
                            sceneItemId: overlay.sceneItemId,
                            sceneItemTransform: {
                                alignment: 0,
                                positionX: pose.x,
                                positionY: pose.y,
                                rotation: obsAngle(pose.rot),
                                scaleX: overlay.scale * overlay.mirror * (pose.sx ?? 1),
                                scaleY: overlay.scale * (pose.sy ?? 1)
                            }
                        });
                        setOverlayVisible(overlay, true);
                    } else {
                        setOverlayVisible(overlay, false);
                    }
                }

                await delay(FRAME_MS);
            }
        } finally {
            if (this.obs.connected) {
                for (const overlay of Object.values(overlays)) {
                    await this.obs.request("SetSceneItemEnabled", { sceneName, sceneItemId: overlay.sceneItemId, sceneItemEnabled: false })
                        .catch((error) => console.error("OBS: не удалось спрятать картинку эффекта:", error.message));
                }
                await this.obs.request("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: original })
                    .catch((error) => console.error("OBS: не удалось вернуть положение аватара:", error.message));
            }
        }
    }
}

module.exports = { AvatarEffects, EFFECTS, HAND_INPUT_NAME, ITEM_INPUT_NAME };
