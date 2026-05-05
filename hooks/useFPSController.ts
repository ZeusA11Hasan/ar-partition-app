import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';

// ─── Shared movement input — keyboard AND joystick both write here ─────────────
export interface MovementInput {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    sprint: boolean;
}

export function useFPSController() {
    // ── Input state (shared between keyboard + joystick) ─────────────────────
    const movementInput = useRef<MovementInput>({
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
    });

    // ── Camera euler (yaw = left/right, pitch = up/down) ─────────────────────
    // We store these separately so we can apply them cleanly every frame.
    const yaw   = useRef(0); // rotation around world Y axis
    const pitch = useRef(0); // rotation around local X axis

    // ── Velocity for smooth acceleration/deceleration ────────────────────────
    const velocity = useRef(new THREE.Vector3());

    // ── Pointer lock state (ref, not state — read inside rAF without stale closure) ──
    const isLockedRef = useRef(false);
    const canvasRef   = useRef<HTMLElement | null>(null);

    // ── Keyboard listeners ────────────────────────────────────────────────────
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp':    movementInput.current.forward  = true; break;
                case 'KeyS': case 'ArrowDown':  movementInput.current.backward = true; break;
                case 'KeyA': case 'ArrowLeft':  movementInput.current.left     = true; break;
                case 'KeyD': case 'ArrowRight': movementInput.current.right    = true; break;
                case 'ShiftLeft': case 'ShiftRight': movementInput.current.sprint = true; break;
            }
        };
        const up = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp':    movementInput.current.forward  = false; break;
                case 'KeyS': case 'ArrowDown':  movementInput.current.backward = false; break;
                case 'KeyA': case 'ArrowLeft':  movementInput.current.left     = false; break;
                case 'KeyD': case 'ArrowRight': movementInput.current.right    = false; break;
                case 'ShiftLeft': case 'ShiftRight': movementInput.current.sprint = false; break;
            }
        };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup',   up);
        return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    }, []);

    // ── Mouse look + pointer lock lifecycle ───────────────────────────────────
    useEffect(() => {
        const SENSITIVITY  = 0.002;
        const MAX_PITCH    = Math.PI / 2 - 0.05; // ~85° — prevents flipping

        const onMouseMove = (e: MouseEvent) => {
            if (!isLockedRef.current) return;
            const dx = e.movementX ?? 0;
            const dy = e.movementY ?? 0;

            yaw.current   -= dx * SENSITIVITY;
            pitch.current -= dy * SENSITIVITY;
            pitch.current  = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch.current));

            console.log(`[FPS] MOUSEMOVE dx:${dx} dy:${dy} | yaw:${yaw.current.toFixed(3)} pitch:${pitch.current.toFixed(3)}`);
        };

        const onLockChange = () => {
            const locked = !!(canvasRef.current && document.pointerLockElement === canvasRef.current);
            isLockedRef.current = locked;
            if (locked) {
                console.log('[FPS] ✅ POINTER LOCK ACTIVE — mouse look enabled');
            } else {
                console.log('[FPS] ⛔ POINTER LOCK RELEASED');
                // Clear any stuck keys on unlock
                movementInput.current.forward = movementInput.current.backward =
                movementInput.current.left    = movementInput.current.right    = false;
            }
        };

        const onLockError = () => console.error('[FPS] ❌ Pointer lock request failed');

        document.addEventListener('mousemove',        onMouseMove);
        document.addEventListener('pointerlockchange', onLockChange);
        document.addEventListener('pointerlockerror',  onLockError);
        return () => {
            document.removeEventListener('mousemove',        onMouseMove);
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('pointerlockerror',  onLockError);
        };
    }, []);

    // ── Public API: lock / unlock ──────────────────────────────────────────────
    const lock = useCallback((canvas: HTMLElement) => {
        canvasRef.current = canvas;
        canvas.requestPointerLock();
        console.log('[FPS] Requesting pointer lock on canvas element...');
    }, []);

    const unlock = useCallback(() => {
        if (document.pointerLockElement) {
            document.exitPointerLock();
        }
    }, []);

    // ── Sync yaw/pitch FROM camera when entering walk mode ────────────────────
    // Prevents a jarring snap when the camera starts at some non-zero rotation.
    const syncFromCamera = useCallback((camera: THREE.PerspectiveCamera) => {
        camera.rotation.order = 'YXZ';
        yaw.current   = camera.rotation.y;
        pitch.current = camera.rotation.x;
        console.log(`[FPS] Synced from camera — yaw:${yaw.current.toFixed(3)} pitch:${pitch.current.toFixed(3)}`);
    }, []);

    // ── Per-frame update — call every animation frame in Walk Mode ─────────────
    const updateFrame = useCallback((camera: THREE.PerspectiveCamera, delta: number) => {
        if (delta > 0.1) delta = 0.1; // cap for tab-switch prevention

        const WALK_SPEED  = 2.5;
        const SPRINT_SPEED = 4.5;
        const DAMPING      = 10;

        // 1. Apply camera rotation (YXZ = yaw first, then pitch — standard FPS order)
        camera.rotation.order = 'YXZ';
        camera.rotation.y = yaw.current;
        camera.rotation.x = pitch.current;
        camera.rotation.z = 0; // no roll

        // 2. Friction
        velocity.current.x -= velocity.current.x * DAMPING * delta;
        velocity.current.z -= velocity.current.z * DAMPING * delta;

        // 3. Movement direction (XZ plane only — ignores pitch so W doesn't make you dive)
        const inp   = movementInput.current;
        const speed = inp.sprint ? SPRINT_SPEED : WALK_SPEED;
        const hasInput = inp.forward || inp.backward || inp.left || inp.right;

        if (hasInput) {
            // World-space forward/right derived from YAW ONLY (not full quaternion)
            const sinY = Math.sin(yaw.current);
            const cosY = Math.cos(yaw.current);

            const fwdX = -sinY, fwdZ = -cosY;
            const rgtX =  cosY, rgtZ = -sinY;

            let dirX = 0, dirZ = 0;
            if (inp.forward)  { dirX += fwdX; dirZ += fwdZ; }
            if (inp.backward) { dirX -= fwdX; dirZ -= fwdZ; }
            if (inp.right)    { dirX += rgtX; dirZ += rgtZ; }
            if (inp.left)     { dirX -= rgtX; dirZ -= rgtZ; }

            // Normalise
            const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
            if (len > 0) { dirX /= len; dirZ /= len; }

            velocity.current.x += dirX * speed * DAMPING * delta;
            velocity.current.z += dirZ * speed * DAMPING * delta;

            console.log(`[FPS] MOVING dir:(${dirX.toFixed(2)},${dirZ.toFixed(2)}) speed:${speed} locked:${isLockedRef.current}`);
        }

        // 4. Apply velocity
        camera.position.x += velocity.current.x * delta;
        camera.position.z += velocity.current.z * delta;

        // 5. Always lock Y to eye height
        camera.position.y = 1.6;
    }, []);

    const resetVelocity = useCallback(() => {
        velocity.current.set(0, 0, 0);
        movementInput.current.forward = movementInput.current.backward =
        movementInput.current.left    = movementInput.current.right    =
        movementInput.current.sprint  = false;
    }, []);

    return { movementInput, lock, unlock, isLockedRef, syncFromCamera, updateFrame, resetVelocity };
}
