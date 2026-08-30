// ==UserScript==
// @name         PolyTrack TAS Slow-Motion Controller
// @namespace    https://www.kodub.com/
// @version      1.0.1
// @description  TAS-style slow motion, pause, and frame-step controls for PolyTrack. Press P to show/hide.
// @match        https://app-polytrack.kodub.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    if (window.__polyTrackTasInstalled) return;
    Object.defineProperty(window, '__polyTrackTasInstalled', { value: true });

    const CONTROL_FLAG = '__POLYTRACK_TAS_CONTROL__';
    const SIM_WORKER_RE =
        /(?:^|\/)simulation[_-]?worker(?:\.bundle)?\.js(?:$|[?#])/i;

    // PolyTrack physics runs in 1 ms simulation ticks.
    const STEP_MS = 1.000001;

    // ============================================================
    // VIRTUAL CLOCK
    // ============================================================

    const realPerformanceNow = performance.now.bind(performance);
    const realRAF = requestAnimationFrame.bind(window);

    let speed = 1.0;
    let lastNonZeroSpeed = 0.25;

    let realAnchor = realPerformanceNow();
    let virtualAnchor = realAnchor;

    function virtualNow() {
        const real = realPerformanceNow();
        return virtualAnchor + (real - realAnchor) * speed;
    }

    function setLocalSpeed(newSpeed) {
        const real = realPerformanceNow();

        // Preserve continuity when changing speed.
        virtualAnchor += (real - realAnchor) * speed;
        realAnchor = real;

        speed = Math.max(0, Math.min(1, Number(newSpeed) || 0));

        if (speed > 0) {
            lastNonZeroSpeed = speed;
        }
    }

    function advanceClock(ms) {
        const real = realPerformanceNow();

        virtualAnchor +=
            (real - realAnchor) * speed +
            ms;

        realAnchor = real;
    }

    // Replace performance.now() with our scaled clock.
    try {
        Object.defineProperty(performance, 'now', {
            configurable: true,
            writable: true,
            value: virtualNow
        });
    } catch {
        try {
            Object.defineProperty(
                Object.getPrototypeOf(performance),
                'now',
                {
                    configurable: true,
                    writable: true,
                    value: virtualNow
                }
            );
        } catch (error) {
            console.warn(
                '[PolyTrack TAS] Could not patch performance.now()',
                error
            );
        }
    }

    // Keep requestAnimationFrame timestamps synchronized.
    window.requestAnimationFrame = function (callback) {
        return realRAF(() => callback(virtualNow()));
    };


    // ============================================================
    // SIMULATION WORKER
    // ============================================================

    const NativeWorker = window.Worker;
    const workers = new Set();

    let workerDetected = false;

    function controlMessage(data = {}) {
        return {
            [CONTROL_FLAG]: true,
            ...data
        };
    }

    function broadcast(data) {
        for (const worker of [...workers]) {
            try {
                worker.postMessage(controlMessage(data));
            } catch {
                workers.delete(worker);
            }
        }
    }

    function makeWorkerBootstrap(originalURL, isModule, initialSpeed) {
        const patch = `
const __TAS_FLAG = ${JSON.stringify(CONTROL_FLAG)};

const __originalURL =
    ${JSON.stringify(originalURL)};

const __baseURL =
    new URL(".", __originalURL).href;

const __resolveURL = value =>
    new URL(String(value), __baseURL).href;

// Blob workers cannot resolve relative fetch/XHR URLs against their
// original script. Keep PolyTrack's resource requests on the real origin.
const __nativeFetch = self.fetch.bind(self);

self.fetch = (input, init) => {
    if (
        typeof input === "string" ||
        input instanceof URL
    ) {
        input = __resolveURL(input);
    }

    return __nativeFetch(input, init);
};

const __nativeXHROpen =
    XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.open = function (
    method,
    url,
    ...args
) {
    return __nativeXHROpen.call(
        this,
        method,
        __resolveURL(url),
        ...args
    );
};

const __realNow = performance.now.bind(performance);

let __speed = ${JSON.stringify(initialSpeed)};
let __realAnchor = __realNow();
let __virtualAnchor = __realAnchor;

function __virtualNow() {
    const r = __realNow();
    return __virtualAnchor + (r - __realAnchor) * __speed;
}

function __setSpeed(value) {
    const r = __realNow();

    __virtualAnchor +=
        (r - __realAnchor) * __speed;

    __realAnchor = r;

    __speed = Math.max(
        0,
        Math.min(1, Number(value) || 0)
    );
}

function __step(ms) {
    const r = __realNow();

    __virtualAnchor +=
        (r - __realAnchor) * __speed +
        ms;

    __realAnchor = r;
}

try {
    Object.defineProperty(performance, "now", {
        configurable: true,
        writable: true,
        value: __virtualNow
    });
} catch (_) {
    try {
        Object.defineProperty(
            Object.getPrototypeOf(performance),
            "now",
            {
                configurable: true,
                writable: true,
                value: __virtualNow
            }
        );
    } catch (_) {}
}

self.addEventListener("message", event => {

    const msg = event.data;

    if (!msg || msg[__TAS_FLAG] !== true)
        return;

    if (Number.isFinite(msg.speed))
        __setSpeed(msg.speed);

    if (
        Number.isFinite(msg.stepMs) &&
        msg.stepMs > 0
    )
        __step(msg.stepMs);

    // Hide our private TAS messages from PolyTrack.
    event.stopImmediatePropagation();

}, true);
`;

        // Support module workers just in case a future version switches.
        if (isModule) {
            return `
${patch}
import(${JSON.stringify(originalURL)});
`;
        }

        /*
         * Blob workers normally change the base path of relative
         * importScripts() calls.
         *
         * PolyTrack imports physics resources relatively, so redirect
         * them back to the real worker directory.
         */
        return `
${patch}

const __nativeImportScripts =
    self.importScripts.bind(self);

self.importScripts = (...urls) => {
    return __nativeImportScripts(
        ...urls.map(url =>
            __resolveURL(url)
        )
    );
};

__nativeImportScripts(__originalURL);
`;
    }

    if (typeof NativeWorker === 'function') {

        class TASWorker extends NativeWorker {

            constructor(scriptURL, options) {

                let absoluteURL = null;

                try {
                    absoluteURL =
                        new URL(
                            String(scriptURL),
                            document.baseURI
                        ).href;
                } catch {}

                const isSimulationWorker =
                    absoluteURL !== null &&
                    SIM_WORKER_RE.test(absoluteURL);

                // Leave unrelated workers completely untouched.
                if (!isSimulationWorker) {
                    super(scriptURL, options);
                    return;
                }

                const isModule =
                    options?.type === 'module';

                const bootstrap =
                    makeWorkerBootstrap(
                        absoluteURL,
                        isModule,
                        speed
                    );

                const blobURL =
                    URL.createObjectURL(
                        new Blob(
                            [bootstrap],
                            { type: 'text/javascript' }
                        )
                    );

                super(blobURL, options);

                workerDetected = true;
                workers.add(this);

                // Queue TAS speed before PolyTrack sends Init.
                this.postMessage(
                    controlMessage({ speed })
                );

                setTimeout(
                    () => URL.revokeObjectURL(blobURL),
                    30000
                );

                updateGUI();
            }

            terminate() {
                workers.delete(this);
                return super.terminate();
            }
        }

        try {
            Object.defineProperty(
                TASWorker,
                'name',
                { value: 'Worker' }
            );
        } catch {}

        window.Worker = TASWorker;
    }


    // ============================================================
    // CONTROLS
    // ============================================================

    function setSpeed(newSpeed) {
        setLocalSpeed(newSpeed);

        broadcast({
            speed
        });

        updateGUI();
    }

    function stepFrame() {

        // Frame stepping only makes sense while paused.
        if (speed !== 0) {
            setSpeed(0);
        }

        advanceClock(STEP_MS);

        broadcast({
            stepMs: STEP_MS
        });

        updateGUI();
    }


    // ============================================================
    // GUI
    // ============================================================

    let guiHost;
    let panel;
    let slider;
    let valueText;
    let pauseButton;
    let workerText;

    function updateGUI() {

        if (!slider)
            return;

        const percent =
            Math.round(speed * 100);

        slider.value =
            String(percent);

        if (speed === 0) {

            valueText.textContent =
                'PAUSED';

        } else if (speed === 1) {

            valueText.textContent =
                '100% · Normal';

        } else {

            const slowdown =
                1 / speed;

            valueText.textContent =
                `${percent}% · ${slowdown.toFixed(
                    slowdown >= 10 ? 1 : 2
                )}× slower`;
        }

        pauseButton.textContent =
            speed === 0
                ? 'Resume'
                : 'Pause';

        workerText.textContent =
            workerDetected
                ? 'Physics hook: ACTIVE'
                : 'Physics hook: waiting...';

        workerText.className =
            workerDetected
                ? 'status active'
                : 'status';
    }


    function createGUI() {

        if (guiHost)
            return;

        guiHost =
            document.createElement('div');

        const shadow =
            guiHost.attachShadow({
                mode: 'open'
            });

        shadow.innerHTML = `

<style>

* {
    box-sizing: border-box;
}

.panel {
    position: fixed;

    top: 20px;
    right: 20px;

    width: 310px;

    z-index: 2147483647;

    display: none;

    padding: 15px;

    background:
        rgba(15, 17, 22, 0.95);

    border:
        1px solid rgba(255,255,255,.17);

    border-radius: 14px;

    box-shadow:
        0 15px 45px rgba(0,0,0,.5);

    backdrop-filter:
        blur(12px);

    color: white;

    font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
}

.panel.open {
    display: block;
}

.header {
    display: flex;

    justify-content:
        space-between;

    align-items:
        center;

    margin-bottom: 14px;
}

.title {
    font-size: 16px;
    font-weight: 800;
}

.close {

    width: 29px;
    height: 29px;

    border: none;

    border-radius: 8px;

    background:
        rgba(255,255,255,.09);

    color: white;

    font-size: 20px;

    cursor: pointer;
}

.close:hover,
.action:hover {

    background:
        rgba(255,255,255,.17);
}

.speed-row {

    display: flex;

    justify-content:
        space-between;

    margin-bottom: 7px;

    font-size: 12px;
}

.value {
    font-weight: 750;
}

input[type="range"] {

    width: 100%;

    margin:
        5px 0 3px;

    accent-color: white;

    cursor: pointer;
}

.scale {

    display: flex;

    justify-content:
        space-between;

    opacity: .5;

    font-size: 10px;

    margin-bottom: 14px;
}

.buttons {

    display: grid;

    grid-template-columns:
        1fr 1.4fr 1fr;

    gap: 7px;
}

.action {

    min-height: 35px;

    border:
        1px solid rgba(255,255,255,.12);

    border-radius: 9px;

    background:
        rgba(255,255,255,.08);

    color: white;

    font-weight: 650;

    cursor: pointer;
}

.status {

    margin-top: 12px;

    opacity: .5;

    font-size: 10px;
}

.status.active {
    opacity: .9;
}

.hint {

    margin-top: 5px;

    opacity: .45;

    font-size: 10px;
}

</style>


<div
    id="panel"
    class="panel"
>

    <div class="header">

        <div class="title">
            PolyTrack TAS
        </div>

        <button
            id="close"
            class="close"
        >
            ×
        </button>

    </div>


    <div class="speed-row">

        <span>
            Game speed
        </span>

        <span
            id="value"
            class="value"
        >
            100% · Normal
        </span>

    </div>


    <input
        id="slider"
        type="range"
        min="0"
        max="100"
        step="1"
        value="100"
    >


    <div class="scale">

        <span>
            Pause
        </span>

        <span>
            25%
        </span>

        <span>
            50%
        </span>

        <span>
            100%
        </span>

    </div>


    <div class="buttons">

        <button
            id="pause"
            class="action"
        >
            Pause
        </button>

        <button
            id="step"
            class="action"
        >
            Step 1 frame
        </button>

        <button
            id="normal"
            class="action"
        >
            100%
        </button>

    </div>


    <div
        id="worker"
        class="status"
    >
        Physics hook: waiting...
    </div>

    <div class="hint">
        P = show/hide · × = hide
    </div>

</div>
`;

        document.documentElement
            .appendChild(guiHost);

        panel =
            shadow.getElementById('panel');

        slider =
            shadow.getElementById('slider');

        valueText =
            shadow.getElementById('value');

        pauseButton =
            shadow.getElementById('pause');

        workerText =
            shadow.getElementById('worker');


        // X button
        shadow
            .getElementById('close')
            .addEventListener(
                'click',
                () => {
                    panel.classList
                        .remove('open');
                }
            );


        // Speed slider
        slider.addEventListener(
            'input',
            () => {

                setSpeed(
                    Number(slider.value) /
                    100
                );
            }
        );


        // Pause / resume
        pauseButton.addEventListener(
            'click',
            () => {

                if (speed === 0) {

                    setSpeed(
                        lastNonZeroSpeed
                    );

                } else {

                    setSpeed(0);
                }
            }
        );


        // Single simulation frame
        shadow
            .getElementById('step')
            .addEventListener(
                'click',
                stepFrame
            );


        // Normal speed
        shadow
            .getElementById('normal')
            .addEventListener(
                'click',
                () => setSpeed(1)
            );


        updateGUI();
    }


    function toggleGUI() {

        if (!panel)
            createGUI();

        panel.classList
            .toggle('open');
    }


    // Create GUI but keep hidden.
    if (document.documentElement) {

        createGUI();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            createGUI,
            { once: true }
        );
    }


    // ============================================================
    // P HOTKEY
    // ============================================================

    window.addEventListener(
        'keydown',
        event => {

            if (
                event.repeat ||
                event.key.toLowerCase() !== 'p'
            ) {
                return;
            }

            // Don't hijack P while typing a track name, etc.
            const target = event.target;

            const typing =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                target?.isContentEditable;

            const insideOurGUI =
                guiHost &&
                event
                    .composedPath()
                    .includes(guiHost);

            if (
                typing &&
                !insideOurGUI
            ) {
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            toggleGUI();

        },
        true
    );


    console.info(
        '[PolyTrack TAS] Loaded — press P.'
    );

})();
