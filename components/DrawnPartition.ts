import * as THREE from 'three';

export class DrawnPartition extends THREE.Group {
    constructor(points: THREE.Vector3[], frameColor: string) {
        super();

        const shape = new THREE.Shape();
        shape.moveTo(points[0].x, -points[0].z); // Map 3D x,z to 2D x,y for shape
        shape.lineTo(points[1].x, -points[1].z);
        shape.lineTo(points[2].x, -points[2].z);
        shape.lineTo(points[3].x, -points[3].z);
        shape.closePath();

        const frameMaterial = new THREE.MeshStandardMaterial({
            color: frameColor === 'black' ? 0x111111 : 0xcccccc,
            metalness: 0.9,
            roughness: 0.1
        });

        const panelMaterial = new THREE.MeshStandardMaterial({
            color: 0xeeece5,
            roughness: 0.6
        });

        const glassMaterial = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            metalness: 0,
            roughness: 0.05,
            transmission: 0.95,
            thickness: 0.05,
            transparent: true,
            opacity: 1,
            reflectivity: 0.5,
            clearcoat: 1.0,
            ior: 1.5,
        });

        // Bottom Tier (0 to 0.8)
        const bottomExtrude = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: false });
        const bottomMesh = new THREE.Mesh(bottomExtrude, panelMaterial);
        bottomMesh.rotateX(Math.PI / 2);
        this.add(bottomMesh);

        // Middle Tier (0.8 to 1.9)
        const middleExtrude = new THREE.ExtrudeGeometry(shape, { depth: 1.1, bevelEnabled: false });
        const middleMesh = new THREE.Mesh(middleExtrude, glassMaterial);
        middleMesh.rotateX(Math.PI / 2);
        middleMesh.position.y = 0.8;
        this.add(middleMesh);

        // Top Tier (1.9 to 2.4)
        const topExtrude = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
        const topMesh = new THREE.Mesh(topExtrude, panelMaterial);
        topMesh.rotateX(Math.PI / 2);
        topMesh.position.y = 1.9;
        this.add(topMesh);

        // Add "Frames" by extruding the outline as a tube/path
        const points2D = [
            new THREE.Vector2(points[0].x, -points[0].z),
            new THREE.Vector2(points[1].x, -points[1].z),
            new THREE.Vector2(points[2].x, -points[2].z),
            new THREE.Vector2(points[3].x, -points[3].z),
            new THREE.Vector2(points[0].x, -points[0].z)
        ];

        const curve = new THREE.CatmullRomCurve3(points.concat([points[0]]));
        const frameTube = new THREE.TubeGeometry(curve, 64, 0.03, 8, false);
        const frameMeshBottom = new THREE.Mesh(frameTube, frameMaterial);
        this.add(frameMeshBottom);

        const frameMeshMid = frameMeshBottom.clone();
        frameMeshMid.position.y = 0.8;
        this.add(frameMeshMid);

        const frameMeshTop = frameMeshBottom.clone();
        frameMeshTop.position.y = 2.4;
        this.add(frameMeshTop);

        // Vertical Frame corner rails
        points.forEach(p => {
            const verticalRail = new THREE.Mesh(
                new THREE.BoxGeometry(0.06, 2.4, 0.06),
                frameMaterial
            );
            verticalRail.position.set(p.x, 1.2, p.z);
            this.add(verticalRail);
        });
    }
}
