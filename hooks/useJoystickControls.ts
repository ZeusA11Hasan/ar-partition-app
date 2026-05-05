import { useEffect, useRef } from 'react';
import nipplejs from 'nipplejs';
import { MovementInput } from './useFPSController';

/**
 * Hooks a nipplejs joystick to the shared movementInput ref
 * from useFPSController so keyboard and joystick use ONE pipeline.
 */
export function useJoystickControls(
    movementInput: React.MutableRefObject<MovementInput>,
    active: boolean
) {
    const joystickContainerRef = useRef<HTMLDivElement | null>(null);
    const managerRef = useRef<any>(null);

    useEffect(() => {
        // Destroy previous instance whenever active or container changes
        if (managerRef.current) {
            managerRef.current.destroy();
            managerRef.current = null;
        }

        if (!active || !joystickContainerRef.current) return;

        console.log('[Joystick] Initializing nipplejs');

        const manager = nipplejs.create({
            zone: joystickContainerRef.current,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: 'rgba(255,255,255,0.7)',
            size: 120,
        });

        managerRef.current = manager;

        manager.on('move', (_evt: any, data: any) => {
            if (!data?.vector) return;

            const { x, y } = data.vector;
            console.log(`[Joystick] MOVE vector:(${x.toFixed(2)},${y.toFixed(2)})`);

            // nipplejs Y is positive UP, matching our forward direction
            movementInput.current.forward  = y >  0.2;
            movementInput.current.backward = y < -0.2;
            movementInput.current.left     = x < -0.2;
            movementInput.current.right    = x >  0.2;
        });

        manager.on('end', () => {
            console.log('[Joystick] Released');
            movementInput.current.forward  = false;
            movementInput.current.backward = false;
            movementInput.current.left     = false;
            movementInput.current.right    = false;
        });

        return () => {
            if (managerRef.current) {
                managerRef.current.destroy();
                managerRef.current = null;
            }
        };
    }, [active, movementInput]);

    return { joystickContainerRef };
}
