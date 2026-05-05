import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

export interface MovementState {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    sprint: boolean;
}

export function useMovementControls() {
    const movementState = useRef<MovementState>({
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
    });

    const velocity = useRef(new THREE.Vector3());
    const direction = useRef(new THREE.Vector3());

    useEffect(() => {
        console.log('[WalkMode] ✅ Keyboard listeners attached');

        const onKeyDown = (event: KeyboardEvent) => {
            switch (event.code) {
                case 'ArrowUp':
                case 'KeyW':
                    console.log('[WalkMode] W KEY PRESSED');
                    movementState.current.forward = true;
                    break;
                case 'ArrowLeft':
                case 'KeyA':
                    console.log('[WalkMode] A KEY PRESSED');
                    movementState.current.left = true;
                    break;
                case 'ArrowDown':
                case 'KeyS':
                    console.log('[WalkMode] S KEY PRESSED');
                    movementState.current.backward = true;
                    break;
                case 'ArrowRight':
                case 'KeyD':
                    console.log('[WalkMode] D KEY PRESSED');
                    movementState.current.right = true;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    movementState.current.sprint = true;
                    break;
            }
        };

        const onKeyUp = (event: KeyboardEvent) => {
            switch (event.code) {
                case 'ArrowUp':
                case 'KeyW':
                    movementState.current.forward = false;
                    break;
                case 'ArrowLeft':
                case 'KeyA':
                    movementState.current.left = false;
                    break;
                case 'ArrowDown':
                case 'KeyS':
                    movementState.current.backward = false;
                    break;
                case 'ArrowRight':
                case 'KeyD':
                    movementState.current.right = false;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    movementState.current.sprint = false;
                    break;
            }
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, []);

    /**
     * Call this every animation frame when Walk Mode is active.
     * Uses PointerLockControls.moveForward / moveRight so movement
     * is always relative to where the camera is looking — exactly like Minecraft.
     *
     * @param controls - The PointerLockControls instance (handles look & move direction)
     * @param delta    - Seconds since last frame (from the animation loop)
     */
    const updateMovement = (
        controls: PointerLockControls,
        camera: THREE.PerspectiveCamera,
        delta: number
    ) => {
        // Cap delta so a tab-switch doesn't cause a teleport
        if (delta > 0.1) delta = 0.1;

        const SPEED_NORMAL = 2.5;   // m/s
        const SPEED_SPRINT = 4.5;   // m/s
        const DAMPING = 10.0;       // friction coefficient

        const speed = movementState.current.sprint ? SPEED_SPRINT : SPEED_NORMAL;

        // Apply friction every frame
        velocity.current.x -= velocity.current.x * DAMPING * delta;
        velocity.current.z -= velocity.current.z * DAMPING * delta;

        // Build normalised intention vector on XZ plane
        direction.current.set(0, 0, 0);
        if (movementState.current.forward)  direction.current.z -= 1;
        if (movementState.current.backward) direction.current.z += 1;
        if (movementState.current.left)     direction.current.x -= 1;
        if (movementState.current.right)    direction.current.x += 1;
        direction.current.normalize();

        // Accumulate velocity from player input
        if (movementState.current.forward || movementState.current.backward) {
            velocity.current.z += direction.current.z * speed * delta * 10;
        }
        if (movementState.current.left || movementState.current.right) {
            velocity.current.x += direction.current.x * speed * delta * 10;
        }

        // ─── THE CRITICAL STEP ───────────────────────────────────────────────
        // PointerLockControls.moveForward / moveRight move the camera relative
        // to where it's LOOKING. This gives true FPS strafing — NOT orbit.
        // Positive moveForward = forward in look direction.
        // Positive moveRight   = strafe right.
        if (Math.abs(velocity.current.z) > 0.001) {
            // moveForward uses -Z as forward in Three.js, negate velocity.z
            controls.moveForward(-velocity.current.z * delta);
            console.log(`[WalkMode] MOVING FORWARD: moveForward(${(-velocity.current.z * delta).toFixed(4)})`);
        }
        if (Math.abs(velocity.current.x) > 0.001) {
            controls.moveRight(velocity.current.x * delta);
            console.log(`[WalkMode] STRAFING: moveRight(${(velocity.current.x * delta).toFixed(4)})`);
        }

        // Lock Y — player must stay grounded at eye height
        camera.position.y = 1.6;

        console.log(
            `[WalkMode] POS=(${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`,
            `VEL=(${velocity.current.x.toFixed(2)}, ${velocity.current.z.toFixed(2)})`
        );
    };

    const resetVelocity = () => {
        velocity.current.set(0, 0, 0);
        direction.current.set(0, 0, 0);
        movementState.current.forward = false;
        movementState.current.backward = false;
        movementState.current.left = false;
        movementState.current.right = false;
        movementState.current.sprint = false;
    };

    return { movementState, updateMovement, velocity, resetVelocity };
}
