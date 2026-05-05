import { useRef, useCallback } from 'react';
import * as THREE from 'three';
import { ARPartition } from '../components/ARPartition';

export function useCollisionDetection() {
    const collidersRef = useRef<THREE.Box3[]>([]);

    const updateColliders = useCallback((scene: THREE.Scene) => {
        const newColliders: THREE.Box3[] = [];
        
        scene.traverse((object) => {
            if (object instanceof ARPartition) {
                // Get the bounding box of the whole partition
                // We should be careful to exclude temporary highlight meshes if they exist
                // But usually, the partition width is predictable:
                // totalWidth = panelWidth * numPanels + frameT
                
                // Instead of setFromObject, we can calculate it from the partition settings
                // But for now, let's just use the children that are panels/rails
                object.children.forEach(child => {
                    if (child instanceof THREE.Mesh && child.name !== 'highlight') {
                        const box = new THREE.Box3().setFromObject(child);
                        
                        // Slightly expand the box for better collision detection
                        // Especially for very thin glass panels
                        if (box.max.z - box.min.z < 0.1) {
                            box.min.z -= 0.05;
                            box.max.z += 0.05;
                        }
                        if (box.max.x - box.min.x < 0.1) {
                            box.min.x -= 0.05;
                            box.max.x += 0.05;
                        }
                        
                        newColliders.push(box);
                    }
                });
            }
        });

        collidersRef.current = newColliders;
    }, []);

    return { collidersRef, updateColliders };
}
