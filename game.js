// =========================================================================
//  COMPLETE AND FINAL game.js (Rhythm Game Core)
//  Includes: Time-to-Hit Physics, Dynamic Audio Offset, Improved Debugging,
//  Hybrid Spatio-Temporal Hit Detection, and ADAPTIVE Z CALIBRATION (FIXED).
// =========================================================================

// --- Constants and Global Variables ---
const X_POSITIONS = {
    1: -24.0, 2: 0.0, 3: 24.0
};
const Y_POSITIONS = {
    1: -24.0, 2: 0.0, 3: 24.0
};
// HIT_Z is now a 'let' variable controlled by the GameManager
let HIT_Z = 0.0;
let NOTE_SPAWN_Z = 200.0;
const NOTE_SIZE = 24.0;
const NOTE_DEPTH = 0.5;
const CURSOR_SIZE = 8.0;
const LINE_WIDTH = 0.2;
const TARGET_COLOR = 0xffffff;

// --- JUDGMENT CONSTANTS ---
const TIME_WINDOW = 0.2; // 200ms window (Temporal tolerance)
const PROXIMITY_WINDOW = 16.0; // Spatial X/Y tolerance
const Z_WINDOW = 20.0; // Spatial Z tolerance (The note must be near the current HIT_Z)
// ----------------------------

// Audio Offset is set via settings menu
let AUDIO_OFFSET_S = 0.250;

const GRID_HALF_SIZE = (3 * 24.0) / 2;
const MAX_CURSOR_CENTER_POS = GRID_HALF_SIZE - (LINE_WIDTH/2) - (CURSOR_SIZE/2);

const LOGIC_FPS = 60;
const MS_PER_LOGIC_UPDATE = 1000 / LOGIC_FPS;
let lastRenderTime = 0;
let logicAccumulator = 0;

let scene, camera, renderer;
let chartData = null;
let activeNotes = [];
let audioContext, audioElement, sourceNode;

let cursorMesh;
let currentXPos = 0.0;
let currentYPos = 0.0;
let animationLoopStarted = false;

// SCORING CONSTANTS
const BASE_SCORE = 25;
const COMBO_INCREASE_HITS = 10;
const MAX_MULTIPLIER = 8;

// GAME SETTINGS - DYNAMIC
let NOTE_SPEED = 100.0;


/**
 * Dynamic Debugging System - Routes temporary messages to the right-side container.
 */
function displayDebug(message, duration = 0, isCriticalError = false) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });

    if (isCriticalError) {
        const errorBox = document.getElementById('error-box');
        if (errorBox) {
            errorBox.style.display = 'block';
            errorBox.innerHTML = `<strong>CRITICAL ERROR:</strong><br>${message}`;
        }
    }

    if (duration === 0) {
        const logContainer = document.getElementById('error-log-container');
        if (logContainer) {
            const logBox = document.createElement('div');
            logBox.className = 'permanent-error-log';
            logBox.innerHTML = `[${timestamp}] ${message}`;
            logContainer.prepend(logBox);
        }
        return;
    }

    const container = document.getElementById('dynamic-message-container');
    if (!container) return;

    const debugBox = document.createElement('div');
    debugBox.className = 'dynamic-debug-message';
    debugBox.innerHTML = `[${timestamp}] ${message}`;

    container.prepend(debugBox);

    setTimeout(() => {
        debugBox.style.opacity = '0';
        setTimeout(() => {
            debugBox.remove();
        }, 1500);

    }, duration);
}


// --- Class Definitions ---

class Note {
    constructor(data, material, distance) {
        this.time = data.time;
        this.xIndex = data.x;
        this.yIndex = data.y;
        this.hasBeenHit = false;
        this.travelDistance = distance;
        this.finalXPosition = X_POSITIONS[this.xIndex];
        this.finalYPosition = Y_POSITIONS[this.yIndex];

        const geometry = new THREE.BoxGeometry(NOTE_SIZE, NOTE_SIZE, NOTE_DEPTH);
        this.mesh = new THREE.Mesh(geometry, material.clone());

        this.mesh.position.set(this.finalXPosition, this.finalYPosition, NOTE_SPAWN_Z);
        scene.add(this.mesh);
    }

    update(currentTime, speed) {
        if (this.hasBeenHit) return;

        const timeToHit = this.time - currentTime;
        let zPosition = timeToHit * speed;

        // Clamping fix: The note should stop visibly at the current HIT_Z target
        if (zPosition < HIT_Z) {
            zPosition = HIT_Z;
        }

        this.mesh.position.z = zPosition;
        this.mesh.position.x = this.finalXPosition;
        this.mesh.position.y = this.finalYPosition;

        if (this.mesh.position.z < HIT_Z - 20.0 && !this.hasBeenHit) {
             this.destroy();
        }
    }

    // Function to get the calculated Z position WITHOUT the clamping
    getZPosition(currentTime, speed) {
        return (this.time - currentTime) * speed;
    }

    handleMiss() {
        if (!this.hasBeenHit) {
            this.hasBeenHit = true;
            GameManager.instance.handleMiss();
            this.destroy();
            displayDebug(`MISSED NOTE: Note passed judgment window.`, 5000);
        }
    }

    destroy() {
        scene.remove(this.mesh);
        if (this.mesh.geometry) this.mesh.geometry.dispose();
        if (this.mesh.material) this.mesh.material.dispose();
    }
}


class GameManager {
    static instance = null;

    constructor() {
        if (GameManager.instance) return GameManager.instance;
        GameManager.instance = this;

        this.score = 0;
        this.combo = 0;
        this.chartIndex = 0;
        this.gameStarted = false;
        this.noteMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 0.8 });

        this.gameMeshes = [];
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.multiplier = 1;
        this.hitCountInTier = 0;

        this.boundOnMouseMove = this.onMouseMove.bind(this);

        // --- Calibration Properties ---
        this.currentVisualHitZ = HIT_Z;
        this.targetVisualHitZ = HIT_Z;
        this.CALIBRATION_ALPHA = 0.01;
        // ------------------------------
    }

    async initialize() {
        this.setupMenuHandlers();

        try {
            await this.loadChart('assets/maps/map1/map1.json');
        } catch (e) { /* Error box handled in loadChart */ }

        audioElement = document.getElementById('audio-track');
        this.loadSettings(false);

        if (!animationLoopStarted) {
            animate(performance.now());
            animationLoopStarted = true;
        }

        this.updateScoreDisplay();
    }

    // ... (setupMenuHandlers, loadSettings, saveSettings, loadChart, startGame remain the same)
    setupMenuHandlers() {
        const startMenu = document.getElementById('start-menu');
        const settingsMenu = document.getElementById('settings-menu');

        document.getElementById('start-button').addEventListener('click', () => {
            this.saveSettings();
            this.loadSettings(true);
            startMenu.style.display = 'none';
            this.startGame();
        });

        document.getElementById('show-settings-button').addEventListener('click', () => {
            startMenu.style.display = 'none';
            settingsMenu.style.display = 'flex';
            document.body.style.cursor = 'default';
            window.removeEventListener('mousemove', this.boundOnMouseMove);
        });

        document.getElementById('back-to-main-button').addEventListener('click', () => {
            this.saveSettings();
            this.loadSettings(false);
            settingsMenu.style.display = 'none';
            startMenu.style.display = 'flex';
        });
    }

    loadSettings(isGameStart) {
        const speedInput = document.getElementById('note-speed-input');
        const spawnZInput = document.getElementById('spawn-z-input');
        const offsetInput = document.getElementById('audio-offset-input');

        let storedSpeed = localStorage.getItem('noteSpeed');
        let storedSpawnZ = localStorage.getItem('spawnZ');

        if (speedInput) {
            speedInput.value = storedSpeed !== null ? storedSpeed : speedInput.value;
            NOTE_SPEED = parseFloat(speedInput.value) || 100.0;
            if (!isGameStart) displayDebug(`Setting: Note Speed loaded as ${NOTE_SPEED.toFixed(1)}`, 1000);
        }

        if (spawnZInput) {
            spawnZInput.value = storedSpawnZ !== null ? storedSpawnZ : spawnZInput.value;
            NOTE_SPAWN_Z = parseFloat(spawnZInput.value) || 200.0;
        }

        if (offsetInput) {
            let storedOffset = localStorage.getItem('audioOffset');
            offsetInput.value = storedOffset !== null ? storedOffset : offsetInput.value;
            AUDIO_OFFSET_S = parseFloat(offsetInput.value) || 0.250;
            if (!isGameStart) displayDebug(`Setting: Audio Offset loaded as ${AUDIO_OFFSET_S.toFixed(3)}s.`, 1000);
        }

        if (chartData) {
             chartData.metadata.travelDistance = NOTE_SPAWN_Z - HIT_Z;
        }
    }

    saveSettings() {
        const speedInput = document.getElementById('note-speed-input');
        const spawnZInput = document.getElementById('spawn-z-input');
        const offsetInput = document.getElementById('audio-offset-input');

        if (speedInput) {
            localStorage.setItem('noteSpeed', speedInput.value);
        }

        if (spawnZInput) {
            localStorage.setItem('spawnZ', spawnZInput.value);
        }

        if (offsetInput) {
            localStorage.setItem('audioOffset', offsetInput.value);
        }

        displayDebug("Settings saved to Local Storage.", 1000);
    }

    async loadChart(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP Error! Status: ${response.status} (${response.statusText || 'Unknown'}) for file: ${url}`);
            }
            chartData = await response.json();
            const errorBox = document.getElementById('error-box');
            if (errorBox) {
                errorBox.style.display = 'none';
            }

            if (chartData && !chartData.metadata.travelDistance) {
                chartData.metadata.travelDistance = NOTE_SPAWN_Z - HIT_Z;
            }
        } catch (error) {
            displayDebug(`MAP LOAD ERROR: ${error.message || "A network or parsing error occurred."}`, 0, true);
            throw error;
        }
    }

    startGame() {
        try {
            if (this.gameStarted) return;
            this.gameStarted = true;

            const startMenu = document.getElementById('start-menu');
            if (startMenu) startMenu.style.display = 'none';

            this.gameMeshes.forEach(mesh => {
                if (mesh) mesh.visible = true;
            });

            document.body.style.cursor = 'none';
            window.addEventListener('mousemove', this.boundOnMouseMove);

            if (!audioElement) {
                displayDebug("CRITICAL AUDIO ERROR: audioElement is null.", 0, true);
                return;
            }

            audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();

            if (!sourceNode) {
                sourceNode = audioContext.createMediaElementSource(audioElement);
                sourceNode.connect(audioContext.destination);
            }

            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }

            audioElement.play().catch(error => {
                displayDebug(`WARNING: Audio failed to play. Browser message: ${error.message}`, 0, true);
            });

            displayDebug("Game Audio Started (Playing Map).");

        } catch (e) {
            displayDebug(`FATAL START ERROR: ${e.message || "Unknown error during game start."}`, 0, true);
            this.gameStarted = false;
        }
    }

    // --- CALIBRATION AND GRAPHICS UPDATE ---

    smoothUpdate(deltaTimeSeconds) {
        const smoothingFactor = 0.1;

        this.currentVisualHitZ = THREE.MathUtils.lerp(
            this.currentVisualHitZ,
            this.targetVisualHitZ,
            smoothingFactor
        );

        // Update the global HIT_Z variable for all game logic
        HIT_Z = this.currentVisualHitZ;

        this.updateHitTargetGraphics();
    }

    updateHitTargetGraphics() {
        this.gameMeshes.forEach(mesh => {
            // Check if the mesh is a target mesh (grid lines or cursor)
            if (mesh.name === 'hit_target') {
                // Move all hit targets (including the cursor)
                // We add a tiny offset for the cursor so it is rendered in front of the grid plane.
                mesh.position.z = this.currentVisualHitZ + 0.01;
            }
        });
    }

    // --- SCORING LOGIC ---
    registerHit(note, timeDiff) {
        note.hasBeenHit = true;

        // 1. --- ADAPTIVE Z CALIBRATION ---
        const rawTime = audioElement.currentTime;
        const gameTimeAtHit = rawTime - AUDIO_OFFSET_S;

        const hitZObserved = note.getZPosition(gameTimeAtHit, NOTE_SPEED);
        const errorZ = hitZObserved - this.currentVisualHitZ;

        this.targetVisualHitZ += this.CALIBRATION_ALPHA * errorZ;
        this.targetVisualHitZ = THREE.MathUtils.clamp(this.targetVisualHitZ, -50.0, 50.0);

        displayDebug(`HIT! Observed Z: ${hitZObserved.toFixed(2)}. New Target Z: ${this.targetVisualHitZ.toFixed(2)}`, 2000);

        // 2. --- Scoring ---
        let hitScore = BASE_SCORE * this.multiplier;
        this.score += hitScore;
        this.combo++;
        this.hitCountInTier++;
        if (this.multiplier < MAX_MULTIPLIER && this.hitCountInTier >= COMBO_INCREASE_HITS) {
            this.multiplier++;
            this.hitCountInTier = 0;
            displayDebug(`MULTIPLIER UP! Now ${this.multiplier}x.`, 3000);
        }
        this.updateScoreDisplay();

        note.mesh.material.color.set(0x00ffff);
    }

    handleMiss() {
        const newMultiplier = Math.max(1, this.multiplier - 1);
        if (newMultiplier < this.multiplier) {
            displayDebug(`MULTIPLIER DOWN! Missed note. Now ${newMultiplier}x.`, 3000);
        }
        this.multiplier = newMultiplier;
        this.hitCountInTier = 0;
        this.combo = 0;
        this.updateScoreDisplay();
    }

    updateScoreDisplay() {
        const scoreElement = document.getElementById('score');
        if (scoreElement) {
             scoreElement.innerText = `Score: ${this.score} | Combo: ${this.combo} | Multiplier: ${this.multiplier}x`;
        }
    }
    // ---------------------

    update() {
        this.updateScoreDisplay();

        const debugElement = document.getElementById('debug');

        if (!this.gameStarted || !chartData) {
             if (debugElement) {
                 debugElement.innerText = `Time: 0.000s (Pre-Game) | Notes: 0 | Cursor: X ${cursorMesh ? cursorMesh.position.x.toFixed(2) : '0.00'}, Y ${cursorMesh ? cursorMesh.position.y.toFixed(2) : '0.00'}`;
             }
             return;
        }

        const rawTime = audioElement.currentTime;
        const currentTime = rawTime - AUDIO_OFFSET_S;

        if (rawTime === 0 && audioElement.paused) {
             if (debugElement) {
                 debugElement.innerText = `Time: 0.000s (Waiting for Audio Playback) | Notes: ${activeNotes.length} | Cursor: X ${cursorMesh.position.x.toFixed(2)}, Y ${cursorMesh.position.y.toFixed(2)}`;
             }
             return;
        }

        const speed = NOTE_SPEED;
        const distance = chartData.metadata.travelDistance;

        const cursorX = currentXPos;
        const cursorY = currentYPos;

        // 1. SPAWN NOTES
        while (this.chartIndex < chartData.notes.length) {
            const nextNote = chartData.notes[this.chartIndex];

            const travelTime = distance / speed;
            const spawnTime = nextNote.time - travelTime;

            if (currentTime >= spawnTime) {
                const newNote = new Note(nextNote, this.noteMaterial, distance);
                activeNotes.push(newNote);
                this.chartIndex++;

                newNote.update(currentTime, speed);
            } else {
                break;
            }
        }

        // 2. UPDATE ACTIVE NOTES, HIT JUDGEMENT, & CLEANUP
        for (let i = activeNotes.length - 1; i >= 0; i--) {
            const note = activeNotes[i];

            note.update(currentTime, speed);

            if (note.hasBeenHit) {
                note.destroy();
                activeNotes.splice(i, 1);
                continue;
            }

            // C. HYBRID SPATIO-TEMPORAL JUDGEMENT (Hit/Miss Check)
            const timeDiff = Math.abs(note.time - currentTime);

            const currentZ = note.getZPosition(currentTime, speed);

            // Debug check near the note's target time
            if (Math.abs(note.time - currentTime) < 0.015 && !note.hasBeenHit) {
                const zAtCurrentTime = note.getZPosition(currentTime, speed);
                displayDebug(`Note T: ${note.time.toFixed(3)} | Current Z: ${zAtCurrentTime.toFixed(3)} (Target Z=${HIT_Z.toFixed(2)})`, 1500);
            }

            // HIT CHECK:
            if (timeDiff <= TIME_WINDOW) {

                // Z-Check: Is the note physically near the current calibrated hit plane (HIT_Z)?
                const zMatch = Math.abs(currentZ - HIT_Z) <= Z_WINDOW;

                if (zMatch) {
                    const hitTargetX = note.finalXPosition;
                    const hitTargetY = note.finalYPosition;

                    // X/Y Check: Is the cursor over the correct lane?
                    const xMatch = Math.abs(cursorX - hitTargetX) <= PROXIMITY_WINDOW;
                    const yMatch = Math.abs(cursorY - hitTargetY) <= PROXIMITY_WINDOW;

                    if (xMatch && yMatch) {
                        this.registerHit(note, timeDiff);
                    }
                }
            }

            // MISS CHECK
            if (note.time + TIME_WINDOW < currentTime) {
                note.handleMiss();
            }
        }

        // 3. DEBUG UPDATE
        if (debugElement) {
            debugElement.innerText = `Time: ${currentTime.toFixed(3)}s | Raw Time: ${rawTime.toFixed(3)}s | Sync Offset: ${AUDIO_OFFSET_S.toFixed(3)}s | Speed: ${NOTE_SPEED.toFixed(1)} | Active Notes: ${activeNotes.length} | Calibrated Z: ${HIT_Z.toFixed(2)}`;
        }
    }

    onMouseMove(event) {
        if (!cursorMesh) return;
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, camera);

        // Raycasting plane is fixed at the current visual target Z
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), this.currentVisualHitZ);
        const intersectionPoint = new THREE.Vector3();

        const clampLimit = MAX_CURSOR_CENTER_POS;

        if (this.raycaster.ray.intersectPlane(plane, intersectionPoint)) {
            cursorMesh.position.x = THREE.MathUtils.clamp(intersectionPoint.x, -clampLimit, clampLimit);
            cursorMesh.position.y = THREE.MathUtils.clamp(intersectionPoint.y, -clampLimit, clampLimit);
        }

        // CRITICAL FIX: Z POSITION IS NO LONGER SET HERE. IT IS SET BY smoothUpdate() / updateHitTargetGraphics().

        currentXPos = cursorMesh.position.x;
        currentYPos = cursorMesh.position.y;
    }
}

// --- Three.js Graphics Setup (Remaining functions for graphics initialization and resizing) ---

function initGraphics() {
    try {
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000);

        camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.set(0, 0, -50.0);
        camera.lookAt(0, 0, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });

        renderer.setSize(window.innerWidth, window.innerHeight);

        document.body.appendChild(renderer.domElement);

        displayDebug("Renderer created and added to DOM successfully.");

        createGridTargets();
        createCursor();
        GameManager.instance.gameMeshes.forEach(mesh => mesh.visible = false);

    } catch (e) {
        displayDebug(`FATAL GRAPHICS ERROR: Failed to initialize WebGLRenderer or append canvas.<br>Message: ${e.message || "Unknown error."}`, 0, true);
        throw e;
    }
}

function createGridTargets() {
    const manager = GameManager.instance;
    const lineSpacing = 24.0;
    const gridSpan = 3 * lineSpacing;
    const tunnelDepthStart = 0;
    const tunnelDepthEnd = 100;
    const tunnelMaterial = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide, depthTest: true, depthWrite: true });
    const outerMeshMaterial = new THREE.MeshBasicMaterial({ color: TARGET_COLOR, transparent: false, opacity: 1.0, emissive: TARGET_COLOR, emissiveIntensity: 1.0 });

    const tunnelSpan = gridSpan + 2.0;
    const depthLength = Math.abs(tunnelDepthEnd - tunnelDepthStart);
    const depthCenter = (tunnelDepthStart + tunnelDepthEnd) / 2;
    const floorGeometry = new THREE.PlaneGeometry(tunnelSpan, depthLength);

    const meshes = [];
    const floor = new THREE.Mesh(floorGeometry, tunnelMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -tunnelSpan / 2, depthCenter);
    meshes.push(floor);

    const ceiling = new THREE.Mesh(floorGeometry, tunnelMaterial.clone());
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, tunnelSpan / 2, depthCenter);
    meshes.push(ceiling);

    const wallGeometry = new THREE.PlaneGeometry(depthLength, tunnelSpan);

    const wallLeft = new THREE.Mesh(wallGeometry, tunnelMaterial.clone());
    wallLeft.rotation.y = Math.PI / 2;
    wallLeft.position.set(-tunnelSpan / 2, 0, depthCenter);
    meshes.push(wallLeft);

    const wallRight = new THREE.Mesh(wallGeometry, tunnelMaterial.clone());
    wallRight.rotation.y = -Math.PI / 2;
    wallRight.position.set(tunnelSpan / 2, 0, depthCenter);
    meshes.push(wallRight);

    const textureSize = 512;
    const canvas = document.createElement('canvas');
    canvas.width = textureSize;
    canvas.height = textureSize;
    const context = canvas.getContext('2d');
    const third = textureSize / 3;
    const lineWidthPx = (LINE_WIDTH / gridSpan) * textureSize;
    context.strokeStyle = `rgb(${TARGET_COLOR >> 16 & 0xFF}, ${TARGET_COLOR >> 8 & 0xFF}, ${TARGET_COLOR & 0xFF})`;
    context.lineWidth = lineWidthPx;
    context.globalAlpha = 1.0;
    context.beginPath();
    context.moveTo(third, 0); context.lineTo(third, textureSize);
    context.moveTo(2 * third, 0); context.lineTo(2 * third, textureSize);
    context.moveTo(0, third); context.lineTo(textureSize, third);
    context.moveTo(0, 2 * third); context.lineTo(textureSize, 2 * third);
    context.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    const innerGridMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.5, side: THREE.DoubleSide });

    const innerGridSize = gridSpan - LINE_WIDTH;
    const innerGridGeometry = new THREE.PlaneGeometry(innerGridSize, innerGridSize);
    const innerGridMesh = new THREE.Mesh(innerGridGeometry, innerGridMaterial);

    innerGridMesh.position.set(0, 0, HIT_Z - 0.005);
    innerGridMesh.name = 'hit_target';
    meshes.push(innerGridMesh);

    const lineBoundary = gridSpan / 2;
    const vBorderLength = gridSpan - LINE_WIDTH;
    const hBorderGeometry = new THREE.BoxGeometry(gridSpan, LINE_WIDTH, LINE_WIDTH);

    const topBorder = new THREE.Mesh(hBorderGeometry, outerMeshMaterial.clone());
    topBorder.position.set(0, lineBoundary - (LINE_WIDTH/2), HIT_Z);
    topBorder.name = 'hit_target';
    meshes.push(topBorder);

    const bottomBorder = new THREE.Mesh(hBorderGeometry, outerMeshMaterial.clone());
    bottomBorder.position.set(0, -lineBoundary + (LINE_WIDTH/2), HIT_Z);
    bottomBorder.name = 'hit_target';
    meshes.push(bottomBorder);

    const vBorderGeometry = new THREE.BoxGeometry(LINE_WIDTH, vBorderLength, LINE_WIDTH);

    const leftBorder = new THREE.Mesh(vBorderGeometry, outerMeshMaterial.clone());
    leftBorder.position.set(-lineBoundary + (LINE_WIDTH/2), 0, HIT_Z);
    leftBorder.name = 'hit_target';
    meshes.push(leftBorder);

    const rightBorder = new THREE.Mesh(vBorderGeometry, outerMeshMaterial.clone());
    rightBorder.position.set(lineBoundary - (LINE_WIDTH/2), 0, HIT_Z);
    rightBorder.name = 'hit_target';
    meshes.push(rightBorder);

    meshes.forEach(mesh => {
        scene.add(mesh);
        manager.gameMeshes.push(mesh);
    });
}

function createCursor() {
    const manager = GameManager.instance;
    const cursorSize = CURSOR_SIZE;
    const cursorMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 0.8, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
    const cursorGeometry = new THREE.BoxGeometry(cursorSize, cursorSize, 0.05);
    cursorMesh = new THREE.Mesh(cursorGeometry, cursorMaterial);

    cursorMesh.position.set(X_POSITIONS[2], Y_POSITIONS[2], HIT_Z + 0.01);
    cursorMesh.name = 'hit_target';
    scene.add(cursorMesh);

    manager.gameMeshes.push(cursorMesh);
}

function animate(now) {
    if (!animationLoopStarted) {
        animationLoopStarted = true;
    }
    requestAnimationFrame(animate);

    const deltaTime = now - lastRenderTime;

    logicAccumulator += deltaTime;

    if (logicAccumulator >= MS_PER_LOGIC_UPDATE) {

        if (GameManager.instance.gameStarted) {
             // Run smooth calibration update (updates HIT_Z and moves graphics)
             GameManager.instance.smoothUpdate(MS_PER_LOGIC_UPDATE / 1000);
        }

        GameManager.instance.update();
        logicAccumulator -= MS_PER_LOGIC_UPDATE;
    }

    renderer.render(scene, camera);
    lastRenderTime = now;
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Initialization Wrapper ---
document.addEventListener('DOMContentLoaded', () => {
    displayDebug("DOMContentLoaded fired. Checking critical dependencies...");

    if (typeof THREE === 'undefined') {
        displayDebug("CRITICAL ERROR: THREE.js library is not loaded. Check the CDN link or your internet connection.", 0, true);
        return;
    }

    const gameManager = new GameManager();
    displayDebug("GameManager instance created.");

    try {
        initGraphics();
    } catch (e) {
        displayDebug(`FATAL GRAPHICS ERROR: Initialization failed. ${e.message}`, 0, true);
        return;
    }

    gameManager.initialize();

});
