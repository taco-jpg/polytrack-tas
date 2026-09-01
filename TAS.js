// ==UserScript==
// @name         PolyTrack TAS Slow-Motion Controller
// @namespace    https://www.kodub.com/
// @version      1.1.0
// @description  TAS-style slow motion, pause, frame stepping, checkpoints, and replay branching for PolyTrack.
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

    // PolyTrack 0.6.2 minified worker anchor. Checkpoint support is enabled
    // only when this exact worker layout is detected; timing controls continue
    // to work if a future PolyTrack build changes the bundle.
    const WORKER_PATCH_MARKER =
        '$o.length=0,onmessage=r;let a=performance.now(),o=0;function l()';

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

        virtualAnchor += (real - realAnchor) * speed;
        realAnchor = real;

        speed = Math.max(0, Math.min(1, Number(newSpeed) || 0));

        if (speed > 0) {
            lastNonZeroSpeed = speed;
        }
    }

    function setVirtualTime(time) {
        if (!Number.isFinite(time)) return;
        virtualAnchor = time;
        realAnchor = realPerformanceNow();
    }

    function advanceClock(ms) {
        const real = realPerformanceNow();
        virtualAnchor += (real - realAnchor) * speed + ms;
        realAnchor = real;
    }

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

    window.requestAnimationFrame = function (callback) {
        return realRAF(() => callback(virtualNow()));
    };


    // ============================================================
    // CHECKPOINT / REPLAY STATE
    // ============================================================

    let checkpoint = null;
    let inputEvents = [];
    let latestReplayRecording = null;
    let copiedReplayRecording = null;
    let activeBaseRecording = null;
    let activeBaseUntilFrame = 0;

    let activeSimulationWorker = null;
    let requestSequence = 0;

    function cloneMessage(value) {
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(value);
            } catch {}
        }

        if (
            value === null ||
            typeof value !== 'object'
        ) {
            return value;
        }

        if (value instanceof ArrayBuffer) {
            return value.slice(0);
        }

        if (ArrayBuffer.isView(value)) {
            return new value.constructor(value);
        }

        if (Array.isArray(value)) {
            return value.map(cloneMessage);
        }

        const clone = {};
        for (const [key, item] of Object.entries(value)) {
            clone[key] = cloneMessage(item);
        }
        return clone;
    }

    function normalizeControls(value = {}) {
        return {
            up: Boolean(value.up),
            right: Boolean(value.right),
            down: Boolean(value.down),
            left: Boolean(value.left),
            reset: Boolean(value.reset)
        };
    }

    function recordControlEvent(message) {
        const frame = Math.max(0, Math.floor(Number(message.frame) || 0));
        const event = {
            frame,
            ...normalizeControls(message)
        };

        const previous = inputEvents[inputEvents.length - 1];
        if (previous && previous.frame === event.frame) {
            inputEvents[inputEvents.length - 1] = event;
        } else {
            inputEvents.push(event);
        }
    }


    // ============================================================
    // WORKER-SIDE CHECKPOINT PROTOCOL
    // ============================================================

    /*
     * This function is converted to source text and injected inside the
     * PolyTrack simulation worker closure. The free identifiers `e`, `r`,
     * `n`, `Qa`, and `Ki` intentionally refer to the worker's own minified
     * car list, message handler, physics-step function, replay codec, and
     * message enum in PolyTrack 0.6.2.
     */
    function workerCheckpointInjection() {
        const FLAG = '__POLYTRACK_TAS_CONTROL__';
        const originalHandler = onmessage;

        function sendPrivate(data) {
            postMessage({
                [FLAG]: true,
                ...data
            });
        }

        function neutralControls() {
            return {
                up: false,
                right: false,
                down: false,
                left: false,
                reset: false
            };
        }

        function copyControls(value) {
            return {
                up: Boolean(value?.up),
                right: Boolean(value?.right),
                down: Boolean(value?.down),
                left: Boolean(value?.left),
                reset: Boolean(value?.reset)
            };
        }

        function controlsResolver(events, baseRecording, baseUntilFrame) {
            const sorted = Array.isArray(events)
                ? [...events].sort((left, right) => left.frame - right.frame)
                : [];

            let replay = null;
            if (typeof baseRecording === 'string' && baseRecording.length > 0) {
                replay = Qa.deserialize(baseRecording);
            }

            const cutoff = Math.max(0, Math.floor(Number(baseUntilFrame) || 0));
            let eventIndex = 0;
            let liveState = replay && cutoff > 0
                ? copyControls(replay.getFrame(cutoff))
                : neutralControls();

            return frame => {
                if (replay && frame < cutoff) {
                    return copyControls(replay.getFrame(frame));
                }

                while (
                    eventIndex < sorted.length &&
                    sorted[eventIndex].frame <= frame
                ) {
                    liveState = copyControls(sorted[eventIndex]);
                    eventIndex += 1;
                }

                return liveState;
            };
        }

        function restore(message) {
            const targetFrame = Math.max(
                0,
                Math.floor(Number(message.frame) || 0)
            );

            const creates = Array.isArray(message.creates)
                ? message.creates
                : [];

            const savedStates = new Map(
                (Array.isArray(message.carStates) ? message.carStates : [])
                    .map(state => [state.carId, state])
            );

            const targetFrames = new Map(
                (Array.isArray(message.carFrames) ? message.carFrames : [])
                    .map(item => [
                        item.carId,
                        Math.max(0, Math.floor(Number(item.frame) || 0))
                    ])
            );

            const currentIds = e.map(car => car.id);
            for (const carId of currentIds) {
                originalHandler({
                    data: {
                        messageType: Ki.DeleteCar,
                        carId
                    }
                });
            }

            for (const create of creates) {
                originalHandler({ data: create });
            }

            const resolveLiveControls = controlsResolver(
                message.inputEvents,
                message.baseRecording,
                message.baseUntilFrame
            );

            for (const car of e) {
                const saved = savedStates.get(car.id);
                car.hasStarted = Boolean(saved?.started);
                car.targetSimulationFrames = null;
                car.isPaused = true;
            }

            const lastStateBuffers = new Map();
            const maxTargetFrame = Math.max(
                targetFrame,
                ...e.map(car => targetFrames.get(car.id) ?? targetFrame)
            );

            for (let frame = 0; frame < maxTargetFrame; frame += 1) {
                for (const car of e) {
                    if (!car.hasStarted) continue;

                    const carTargetFrame =
                        targetFrames.get(car.id) ?? targetFrame;
                    if (frame >= carTargetFrame) continue;

                    const controls = car.id === message.liveCarId
                        ? resolveLiveControls(frame)
                        : car.controls.getControls(frame);

                    const stateBuffer = n(car, controls);
                    car.frames += 1;
                    lastStateBuffers.set(car.id, stateBuffer);
                }
            }

            const liveCar = e.find(car => car.id === message.liveCarId);
            if (liveCar?.userControls) {
                const controls = resolveLiveControls(targetFrame);
                Object.assign(liveCar.userControls, controls);
                liveCar.userControls.buffer.length = 0;
            }

            for (const car of e) {
                const saved = savedStates.get(car.id);
                car.isPaused = Boolean(saved?.paused);
            }

            if (targetFrame > 0) {
                const stateBuffers = [];
                for (const car of e) {
                    if (!car.hasStarted) continue;
                    const stateBuffer = lastStateBuffers.get(car.id);
                    if (stateBuffer) stateBuffers.push(stateBuffer);
                }

                if (stateBuffers.length > 0) {
                    postMessage(
                        {
                            messageType: Ki.UpdateResult,
                            carStateBuffers: stateBuffers
                        },
                        { transfer: stateBuffers }
                    );
                }
            }

            sendPrivate({
                type: 'restore-complete',
                requestId: message.requestId,
                frame: targetFrame
            });
        }

        onmessage = event => {
            const message = event.data;

            if (message?.[FLAG] === true) {
                try {
                    if (message.command === 'checkpoint') {
                        const car = e.find(item => item.id === message.carId);
                        sendPrivate({
                            type: 'checkpoint-created',
                            requestId: message.requestId,
                            carId: message.carId,
                            frame: car ? car.frames : null,
                            carFrames: e.map(item => ({
                                carId: item.id,
                                frame: item.frames
                            }))
                        });
                        return;
                    }

                    if (message.command === 'restore') {
                        restore(message);
                        return;
                    }
                } catch (error) {
                    sendPrivate({
                        type: 'request-error',
                        requestId: message.requestId,
                        error: String(error?.stack || error)
                    });
                    return;
                }
            }

            originalHandler(event);

            if (
                message?.messageType === Ki.ControlCar
            ) {
                const car = e.find(item => item.id === message.carId);
                const buffer = car?.userControls?.buffer;
                const recorded = buffer?.[buffer.length - 1];

                if (recorded) {
                    sendPrivate({
                        type: 'control-recorded',
                        carId: message.carId,
                        frame: recorded.frame,
                        ...copyControls(recorded)
                    });
                }
            }
        };

        self.__polyTrackTasProtocolReady = true;
        sendPrivate({ type: 'protocol-ready' });
    }


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
        const injectionSource = workerCheckpointInjection.toString();

        const patch = `
const __TAS_FLAG = ${JSON.stringify(CONTROL_FLAG)};
const __TAS_PATCH_MARKER = ${JSON.stringify(WORKER_PATCH_MARKER)};
const __TAS_INJECTION_SOURCE = ${JSON.stringify(injectionSource)};

const __originalURL = ${JSON.stringify(originalURL)};
const __baseURL = new URL(".", __originalURL).href;
const __resolveURL = value => new URL(String(value), __baseURL).href;

const __nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) {
        input = __resolveURL(input);
    }
    return __nativeFetch(input, init);
};

const __nativeXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...args) {
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
    const real = __realNow();
    return __virtualAnchor + (real - __realAnchor) * __speed;
}

function __setSpeed(value) {
    const real = __realNow();
    __virtualAnchor += (real - __realAnchor) * __speed;
    __realAnchor = real;
    __speed = Math.max(0, Math.min(1, Number(value) || 0));
}

function __step(ms) {
    const real = __realNow();
    __virtualAnchor += (real - __realAnchor) * __speed + ms;
    __realAnchor = real;
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
    if (!msg || msg[__TAS_FLAG] !== true) return;

    if (
        msg.command === "checkpoint" ||
        msg.command === "restore"
    ) {
        if (self.__polyTrackTasProtocolReady === true) {
            return;
        }

        self.postMessage({
            [__TAS_FLAG]: true,
            type: "request-error",
            requestId: msg.requestId,
            error: "Checkpoint protocol is unavailable for this PolyTrack build."
        });
        event.stopImmediatePropagation();
        return;
    }

    if (Number.isFinite(msg.speed)) __setSpeed(msg.speed);
    if (Number.isFinite(msg.stepMs) && msg.stepMs > 0) __step(msg.stepMs);

    event.stopImmediatePropagation();
}, true);
`;

        if (isModule) {
            return `
${patch}
self.postMessage({
    [__TAS_FLAG]: true,
    type: "protocol-unavailable"
});
import(${JSON.stringify(originalURL)});
`;
        }

        return `
${patch}

const __nativeImportScripts = self.importScripts.bind(self);
self.importScripts = (...urls) => {
    return __nativeImportScripts(
        ...urls.map(url => __resolveURL(url))
    );
};

let __workerSource = null;
try {
    const __xhr = new XMLHttpRequest();
    __xhr.open("GET", __originalURL, false);
    __xhr.send();
    if (__xhr.status >= 200 && __xhr.status < 300) {
        __workerSource = __xhr.responseText;
    }
} catch (_) {}

if (__workerSource && __workerSource.includes(__TAS_PATCH_MARKER)) {
    const __replacement =
        "$o.length=0,onmessage=r;(" +
        __TAS_INJECTION_SOURCE +
        ")();let a=performance.now(),o=0;function l()";

    __workerSource = __workerSource.replace(
        __TAS_PATCH_MARKER,
        __replacement
    );

    const __patchedURL = URL.createObjectURL(
        new Blob([__workerSource], { type: "text/javascript" })
    );

    __nativeImportScripts(__patchedURL);
    URL.revokeObjectURL(__patchedURL);
} else {
    self.postMessage({
        [__TAS_FLAG]: true,
        type: "protocol-unavailable"
    });
    __nativeImportScripts(__originalURL);
}
`;
    }

    if (typeof NativeWorker === 'function') {
        class TASWorker extends NativeWorker {
            constructor(scriptURL, options) {
                let absoluteURL = null;

                try {
                    absoluteURL = new URL(
                        String(scriptURL),
                        document.baseURI
                    ).href;
                } catch {}

                const isSimulationWorker =
                    absoluteURL !== null &&
                    SIM_WORKER_RE.test(absoluteURL);

                if (!isSimulationWorker) {
                    super(scriptURL, options);
                    return;
                }

                const isModule = options?.type === 'module';
                const bootstrap = makeWorkerBootstrap(
                    absoluteURL,
                    isModule,
                    speed
                );
                const blobURL = URL.createObjectURL(
                    new Blob([bootstrap], { type: 'text/javascript' })
                );

                super(blobURL, options);

                this.__tasSimulationWorker = true;
                this.__tasProtocolReady = false;
                this.__tasCarRecords = new Map();
                this.__tasLiveCarId = null;
                this.__tasPending = new Map();

                this.addEventListener(
                    'message',
                    event => this.__tasHandlePrivateMessage(event),
                    true
                );

                workerDetected = true;
                workers.add(this);
                activeSimulationWorker = this;

                super.postMessage(controlMessage({ speed }));

                setTimeout(() => URL.revokeObjectURL(blobURL), 30000);
                updateGUI();
            }

            __tasHandlePrivateMessage(event) {
                const message = event.data;
                if (!message || message[CONTROL_FLAG] !== true) return;

                event.stopImmediatePropagation();

                if (message.type === 'protocol-ready') {
                    this.__tasProtocolReady = true;
                    setStatus('Checkpoint hook: ACTIVE');
                    updateGUI();
                    return;
                }

                if (message.type === 'protocol-unavailable') {
                    this.__tasProtocolReady = false;
                    setStatus('Checkpoint hook unavailable on this PolyTrack build.');
                    updateGUI();
                    return;
                }

                if (
                    message.type === 'control-recorded' &&
                    message.carId === this.__tasLiveCarId
                ) {
                    recordControlEvent(message);
                    return;
                }

                if (message.requestId !== undefined) {
                    const pending = this.__tasPending.get(message.requestId);
                    if (!pending) return;

                    this.__tasPending.delete(message.requestId);
                    clearTimeout(pending.timeout);

                    if (message.type === 'request-error') {
                        pending.reject(new Error(message.error || 'TAS request failed.'));
                    } else {
                        pending.resolve(message);
                    }
                }
            }

            __tasObserveOutgoing(message) {
                if (!message || typeof message !== 'object') return;
                if (message[CONTROL_FLAG] === true) return;

                const messageType = message.messageType;

                if (messageType === 3) {
                    const create = cloneMessage(message);
                    const existing = this.__tasCarRecords.get(message.carId);

                    this.__tasCarRecords.set(message.carId, {
                        create,
                        started: existing?.started || false,
                        paused: existing?.paused || false
                    });

                    if (message.carRecording == null) {
                        this.__tasLiveCarId = message.carId;
                        activeSimulationWorker = this;
                    } else if (typeof message.carRecording === 'string') {
                        latestReplayRecording = message.carRecording;
                        updateGUI();
                    }
                } else if (messageType === 4) {
                    this.__tasCarRecords.delete(message.carId);
                    if (this.__tasLiveCarId === message.carId) {
                        this.__tasLiveCarId = null;
                    }
                } else if (messageType === 5) {
                    const record = this.__tasCarRecords.get(message.carId);
                    if (record) record.started = true;
                } else if (messageType === 7) {
                    const record = this.__tasCarRecords.get(message.carId);
                    if (record) record.paused = Boolean(message.isPaused);
                }
            }

            postMessage(message, transferOrOptions) {
                if (this.__tasSimulationWorker) {
                    this.__tasObserveOutgoing(message);
                }

                if (arguments.length > 1) {
                    return super.postMessage(message, transferOrOptions);
                }

                return super.postMessage(message);
            }

            __tasRequest(command, payload = {}) {
                if (!this.__tasProtocolReady) {
                    return Promise.reject(
                        new Error('Checkpoint protocol is not ready.')
                    );
                }

                const requestId = ++requestSequence;

                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        this.__tasPending.delete(requestId);
                        reject(new Error('TAS worker request timed out.'));
                    }, 30000);

                    this.__tasPending.set(requestId, {
                        resolve,
                        reject,
                        timeout
                    });

                    super.postMessage(
                        controlMessage({
                            command,
                            requestId,
                            ...payload
                        })
                    );
                });
            }

            __tasRestorePayload(frame, overrides = {}) {
                const creates = [];
                const carStates = [];

                for (const [carId, record] of this.__tasCarRecords) {
                    creates.push(cloneMessage(record.create));
                    carStates.push({
                        carId,
                        started: Boolean(record.started),
                        paused: Boolean(record.paused)
                    });
                }

                return {
                    frame,
                    liveCarId: this.__tasLiveCarId,
                    creates,
                    carStates,
                    carFrames: cloneMessage(checkpoint?.carFrames || []),
                    inputEvents: cloneMessage(inputEvents),
                    baseRecording: activeBaseRecording,
                    baseUntilFrame: activeBaseUntilFrame,
                    ...overrides
                };
            }

            terminate() {
                workers.delete(this);
                if (activeSimulationWorker === this) {
                    activeSimulationWorker = null;
                }
                return super.terminate();
            }
        }

        try {
            Object.defineProperty(TASWorker, 'name', { value: 'Worker' });
        } catch {}

        window.Worker = TASWorker;
    }


    // ============================================================
    // TAS ACTIONS
    // ============================================================

    function getActiveWorker() {
        if (
            activeSimulationWorker?.__tasSimulationWorker &&
            activeSimulationWorker.__tasLiveCarId !== null
        ) {
            return activeSimulationWorker;
        }

        for (const worker of workers) {
            if (worker.__tasLiveCarId !== null) {
                activeSimulationWorker = worker;
                return worker;
            }
        }

        return null;
    }

    function setSpeed(newSpeed) {
        setLocalSpeed(newSpeed);
        broadcast({ speed });
        updateGUI();
    }

    function stepFrame() {
        if (speed !== 0) setSpeed(0);
        advanceClock(STEP_MS);
        broadcast({ stepMs: STEP_MS });
        updateGUI();
    }

    async function createCheckpoint() {
        const worker = getActiveWorker();
        if (!worker) {
            setStatus('Start a run before creating a checkpoint.');
            return;
        }

        const previousSpeed = speed;
        setSpeed(0);

        try {
            const result = await worker.__tasRequest('checkpoint', {
                carId: worker.__tasLiveCarId
            });

            if (!Number.isFinite(result.frame)) {
                throw new Error('The active car is unavailable.');
            }

            checkpoint = {
                frame: Math.max(0, Math.floor(result.frame)),
                carFrames: cloneMessage(result.carFrames || []),
                virtualTime: virtualNow(),
                baseRecording: activeBaseRecording,
                baseUntilFrame: activeBaseUntilFrame
            };

            setStatus(`Checkpoint saved at frame ${checkpoint.frame}.`);
        } catch (error) {
            setStatus(`Checkpoint failed: ${error.message}`);
        } finally {
            if (previousSpeed > 0) setSpeed(previousSpeed);
            updateGUI();
        }
    }

    async function restoreCheckpoint(options = {}) {
        const worker = getActiveWorker();

        if (!worker || !checkpoint) {
            setStatus('No checkpoint is available to restore.');
            return false;
        }

        setSpeed(0);
        setStatus('Restoring checkpoint...');

        const useReplay = Boolean(options.useReplay);
        const baseRecording = useReplay
            ? copiedReplayRecording
            : checkpoint.baseRecording;
        const baseUntilFrame = useReplay
            ? checkpoint.frame
            : checkpoint.baseUntilFrame;
        const events = useReplay
            ? []
            : inputEvents.filter(event => event.frame <= checkpoint.frame);

        try {
            await worker.__tasRequest(
                'restore',
                worker.__tasRestorePayload(
                    checkpoint.frame,
                    {
                        inputEvents: cloneMessage(events),
                        baseRecording,
                        baseUntilFrame
                    }
                )
            );

            setVirtualTime(checkpoint.virtualTime);

            if (useReplay) {
                activeBaseRecording = copiedReplayRecording;
                activeBaseUntilFrame = checkpoint.frame;
                inputEvents = [];
                checkpoint.baseRecording = activeBaseRecording;
                checkpoint.baseUntilFrame = activeBaseUntilFrame;
                setStatus(
                    `Replay branched at frame ${checkpoint.frame}. ` +
                    'Resume and drive your optimized branch.'
                );
            } else {
                activeBaseRecording = checkpoint.baseRecording;
                activeBaseUntilFrame = checkpoint.baseUntilFrame;
                inputEvents = events;
                setStatus(`Restored frame ${checkpoint.frame}.`);
            }

            updateGUI();
            return true;
        } catch (error) {
            setStatus(`Restore failed: ${error.message}`);
            updateGUI();
            return false;
        }
    }

    async function copyLoadedReplay() {
        if (!latestReplayRecording) {
            setStatus('Load a leaderboard replay or ghost first.');
            return;
        }

        copiedReplayRecording = latestReplayRecording;

        try {
            await navigator.clipboard?.writeText(copiedReplayRecording);
            setStatus('Loaded replay captured and copied to the clipboard.');
        } catch {
            setStatus('Loaded replay captured for TAS branching.');
        }

        updateGUI();
    }

    async function branchLoadedReplay() {
        if (!copiedReplayRecording) {
            setStatus('Copy a loaded replay before branching it.');
            return;
        }

        if (!checkpoint) {
            setStatus('Create a checkpoint at the desired branch frame first.');
            return;
        }

        await restoreCheckpoint({ useReplay: true });
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
    let checkpointText;
    let replayText;
    let messageText;

    let statusMessage = '';

    function setStatus(message) {
        statusMessage = String(message || '');
        if (messageText) messageText.textContent = statusMessage;
    }

    function updateGUI() {
        if (!slider) return;

        const percent = Math.round(speed * 100);
        slider.value = String(percent);

        if (speed === 0) {
            valueText.textContent = 'PAUSED';
        } else if (speed === 1) {
            valueText.textContent = '100% · Normal';
        } else {
            const slowdown = 1 / speed;
            valueText.textContent =
                `${percent}% · ${slowdown.toFixed(slowdown >= 10 ? 1 : 2)}× slower`;
        }

        pauseButton.textContent = speed === 0 ? 'Resume' : 'Pause';

        const worker = getActiveWorker();
        if (!workerDetected) {
            workerText.textContent = 'Physics hook: waiting...';
            workerText.className = 'status';
        } else if (worker?.__tasProtocolReady) {
            workerText.textContent = 'Physics + checkpoint hook: ACTIVE';
            workerText.className = 'status active';
        } else {
            workerText.textContent = 'Physics hook: ACTIVE · checkpoint hook waiting...';
            workerText.className = 'status';
        }

        checkpointText.textContent = checkpoint
            ? `Checkpoint: frame ${checkpoint.frame}`
            : 'Checkpoint: none';

        if (copiedReplayRecording) {
            replayText.textContent = 'Replay: captured and ready to branch';
        } else if (latestReplayRecording) {
            replayText.textContent = 'Replay: loaded · click Copy loaded replay';
        } else {
            replayText.textContent = 'Replay: waiting for a loaded ghost/record';
        }

        messageText.textContent = statusMessage;
    }

    function createGUI() {
        if (guiHost) return;

        guiHost = document.createElement('div');
        const shadow = guiHost.attachShadow({ mode: 'open' });

        shadow.innerHTML = `
<style>
* { box-sizing: border-box; }
.panel {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 340px;
    z-index: 2147483647;
    display: none;
    padding: 15px;
    background: rgba(15, 17, 22, 0.96);
    border: 1px solid rgba(255,255,255,.17);
    border-radius: 14px;
    box-shadow: 0 15px 45px rgba(0,0,0,.5);
    backdrop-filter: blur(12px);
    color: white;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.panel.open { display: block; }
.header, .speed-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.header { margin-bottom: 14px; }
.title { font-size: 16px; font-weight: 800; }
.close {
    width: 29px;
    height: 29px;
    border: none;
    border-radius: 8px;
    background: rgba(255,255,255,.09);
    color: white;
    font-size: 20px;
    cursor: pointer;
}
.speed-row { margin-bottom: 7px; font-size: 12px; }
.value { font-weight: 750; }
input[type="range"] {
    width: 100%;
    margin: 5px 0 3px;
    accent-color: white;
    cursor: pointer;
}
.scale {
    display: flex;
    justify-content: space-between;
    opacity: .5;
    font-size: 10px;
    margin-bottom: 14px;
}
.buttons, .feature-buttons {
    display: grid;
    gap: 7px;
}
.buttons { grid-template-columns: 1fr 1.4fr 1fr; }
.feature-buttons { grid-template-columns: 1fr 1fr; }
.action {
    min-height: 35px;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 9px;
    background: rgba(255,255,255,.08);
    color: white;
    font-weight: 650;
    cursor: pointer;
}
.action:hover, .close:hover { background: rgba(255,255,255,.17); }
.divider {
    height: 1px;
    background: rgba(255,255,255,.11);
    margin: 13px 0;
}
.section-title {
    margin-bottom: 7px;
    font-size: 11px;
    font-weight: 800;
    opacity: .85;
    text-transform: uppercase;
    letter-spacing: .05em;
}
.status, .detail, .message {
    font-size: 10px;
    line-height: 1.35;
}
.status { margin-top: 12px; opacity: .55; }
.status.active { opacity: .95; }
.detail { margin-top: 6px; opacity: .58; }
.message { margin-top: 7px; min-height: 14px; opacity: .82; }
.hint { margin-top: 7px; opacity: .42; font-size: 10px; }
</style>
<div id="panel" class="panel">
    <div class="header">
        <div class="title">PolyTrack TAS</div>
        <button id="close" class="close">×</button>
    </div>

    <div class="speed-row">
        <span>Game speed</span>
        <span id="value" class="value">100% · Normal</span>
    </div>
    <input id="slider" type="range" min="0" max="100" step="1" value="100">
    <div class="scale">
        <span>Pause</span><span>25%</span><span>50%</span><span>100%</span>
    </div>
    <div class="buttons">
        <button id="pause" class="action">Pause</button>
        <button id="step" class="action">Step 1 frame</button>
        <button id="normal" class="action">100%</button>
    </div>

    <div class="divider"></div>
    <div class="section-title">Checkpoint</div>
    <div class="feature-buttons">
        <button id="save-checkpoint" class="action">Set checkpoint</button>
        <button id="restore-checkpoint" class="action">Restore checkpoint</button>
    </div>
    <div id="checkpoint" class="detail">Checkpoint: none</div>

    <div class="divider"></div>
    <div class="section-title">Loaded replay / leaderboard ghost</div>
    <div class="feature-buttons">
        <button id="copy-replay" class="action">Copy loaded replay</button>
        <button id="branch-replay" class="action">Branch at checkpoint</button>
    </div>
    <div id="replay" class="detail">Replay: waiting for a loaded ghost/record</div>

    <div id="worker" class="status">Physics hook: waiting...</div>
    <div id="message" class="message"></div>
    <div class="hint">P = show/hide · restored checkpoints stay paused</div>
</div>`;

        const attach = () => {
            if (!document.documentElement) {
                setTimeout(attach, 0);
                return;
            }
            document.documentElement.appendChild(guiHost);
        };
        attach();

        panel = shadow.getElementById('panel');
        slider = shadow.getElementById('slider');
        valueText = shadow.getElementById('value');
        pauseButton = shadow.getElementById('pause');
        workerText = shadow.getElementById('worker');
        checkpointText = shadow.getElementById('checkpoint');
        replayText = shadow.getElementById('replay');
        messageText = shadow.getElementById('message');

        shadow.getElementById('close').addEventListener('click', () => {
            panel.classList.remove('open');
        });

        slider.addEventListener('input', () => {
            setSpeed(Number(slider.value) / 100);
        });

        pauseButton.addEventListener('click', () => {
            if (speed === 0) {
                setSpeed(lastNonZeroSpeed || 0.25);
            } else {
                setSpeed(0);
            }
        });

        shadow.getElementById('step').addEventListener('click', stepFrame);
        shadow.getElementById('normal').addEventListener('click', () => setSpeed(1));
        shadow.getElementById('save-checkpoint').addEventListener('click', createCheckpoint);
        shadow.getElementById('restore-checkpoint').addEventListener('click', () => restoreCheckpoint());
        shadow.getElementById('copy-replay').addEventListener('click', copyLoadedReplay);
        shadow.getElementById('branch-replay').addEventListener('click', branchLoadedReplay);

        window.addEventListener('keydown', event => {
            if (
                event.code === 'KeyP' &&
                !event.repeat &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
            ) {
                panel.classList.toggle('open');
            }
        }, true);

        updateGUI();
    }

    createGUI();

    console.log(
        '[PolyTrack TAS] Loaded v1.1.0 — press P.'
    );
})();
