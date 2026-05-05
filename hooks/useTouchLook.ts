import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function useTouchLook(
    camera: THREE.PerspectiveCamera | null,
    active: boolean
) {
    const isTouching = useRef(false);
    const lastTouchX = useRef(0);
    const lastTouchY = useRef(0);
    const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));

    useEffect(() => {
        if (!active || !camera) return;

        const onTouchStart = (event: TouchEvent) => {
            // Only handle touches on the right half of the screen
            const touch = event.touches[0];
            if (touch.clientX > window.innerWidth / 2) {
                isTouching.current = true;
                lastTouchX.current = touch.clientX;
                lastTouchY.current = touch.clientY;
                
                // Sync euler with current camera rotation
                euler.current.setFromQuaternion(camera.quaternion);
            }
        };

        const onTouchMove = (event: TouchEvent) => {
            if (!isTouching.current) return;

            const touch = event.touches[0];
            const movementX = touch.clientX - lastTouchX.current;
            const movementY = touch.clientY - lastTouchY.current;

            lastTouchX.current = touch.clientX;
            lastTouchY.current = touch.clientY;

            // Rotate camera
            const sensitivity = 0.005;
            
            euler.current.y -= movementX * sensitivity;
            euler.current.x -= movementY * sensitivity;

            // Clamp pitch
            euler.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.current.x));

            camera.quaternion.setFromEuler(euler.current);
        };

        const onTouchEnd = () => {
            isTouching.current = false;
        };

        window.addEventListener('touchstart', onTouchStart);
        window.addEventListener('touchmove', onTouchMove);
        window.addEventListener('touchend', onTouchEnd);

        return () => {
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };
    }, [active, camera]);

    return {};
}
