import * as THREE from 'three';

export interface PartitionSettings {
    frameColor: string; // 'black' or 'silver'
    numPanels: number;
    doorIndices?: number[];
}

export class ARPartition extends THREE.Group {
    private frameMaterial: THREE.MeshStandardMaterial;
    private panelMaterial: THREE.MeshStandardMaterial;
    private glassMaterial: THREE.MeshPhysicalMaterial;
    private highlightMaterial: THREE.MeshStandardMaterial;
    public loadedPanels: number = 0;
    public doorIndices: Set<number> = new Set();
    public openDoorIndices: Set<number> = new Set();
    public color: 'black' | 'silver' = 'black';

    constructor(settings: PartitionSettings = { frameColor: 'black', numPanels: 4, doorIndices: [] }) {
        super();
        this.color = settings.frameColor as any;
        // ... rest of constructor materials
        this.frameMaterial = new THREE.MeshStandardMaterial({
            color: settings.frameColor === 'black' ? 0x111111 : 0xcccccc,
            metalness: 0.9,
            roughness: 0.1
        });

        this.panelMaterial = new THREE.MeshStandardMaterial({
            color: 0xeeece5,
            roughness: 0.6
        });

        this.highlightMaterial = new THREE.MeshStandardMaterial({
            color: 0xffaa00,
            emissive: 0xffaa00,
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.4
        });

        this.glassMaterial = new THREE.MeshPhysicalMaterial({
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

        this.doorIndices = new Set(settings.doorIndices || []);
        this.build(settings.numPanels);
    }

    private build(numPanels: number) {
        while (this.children.length > 0) {
            this.remove(this.children[0]);
        }

        const panelWidth = 0.8;
        const totalHeight = 2.4;
        const frameT = 0.05;
        const totalWidth = panelWidth * numPanels + frameT;

        const bottomH = 0.8;
        const middleH = 1.1;
        const topH = 0.5;

        // Horizonal Rails
        [0, bottomH, bottomH + middleH, totalHeight].forEach((y) => {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(totalWidth, frameT, frameT), this.frameMaterial);
            rail.position.set(0, y + frameT / 2, 0);
            this.add(rail);
        });

        // Vertical Rails and Panels
        for (let i = 0; i <= numPanels; i++) {
            const vRail = new THREE.Mesh(new THREE.BoxGeometry(frameT, totalHeight, frameT), this.frameMaterial);
            vRail.position.set(-totalWidth / 2 + i * panelWidth + frameT / 2, totalHeight / 2 + frameT / 2, 0);
            this.add(vRail);

            if (i < numPanels) {
                const isDoor = this.doorIndices.has(i);
                const xPos = -totalWidth / 2 + i * panelWidth + panelWidth / 2 + frameT / 2;

                if (!isDoor) {
                    // Standard Panels
                    const bPanel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT, bottomH - frameT, 0.03), this.panelMaterial);
                    bPanel.position.set(xPos, bottomH / 2 + frameT / 2, 0);
                    bPanel.userData = { isPanel: true, panelIndex: i };
                    this.add(bPanel);

                    const mPanel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT, middleH - frameT, 0.04), this.glassMaterial);
                    mPanel.position.set(xPos, bottomH + middleH / 2 + frameT / 2, 0);
                    mPanel.userData = { isPanel: true, panelIndex: i };
                    this.add(mPanel);

                    const tPanel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT, topH - frameT, 0.03), this.panelMaterial);
                    tPanel.position.set(xPos, bottomH + middleH + topH / 2 + frameT / 2, 0);
                    tPanel.userData = { isPanel: true, panelIndex: i };
                    this.add(tPanel);
                } else {
                    // Create Door Object
                    const doorGroup = new THREE.Group();
                    doorGroup.position.set(xPos - (panelWidth - frameT) / 2, 0, 0); // Pivot at the left rail

                    const doorSlab = new THREE.Group(); // This rotates
                    doorSlab.position.set((panelWidth - frameT) / 2, 0, 0);

                    if (this.openDoorIndices.has(i)) {
                        doorGroup.rotation.y = -Math.PI / 2; // -90 degrees
                    }

                    // Door sections (mimic the panel tiers but inside the door frame)
                    const dBottom = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT * 2, bottomH - frameT, 0.04), this.panelMaterial);
                    dBottom.position.y = bottomH / 2 + frameT / 2;
                    doorSlab.add(dBottom);

                    const dMiddle = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT * 2, middleH - frameT, 0.04), this.glassMaterial);
                    dMiddle.position.y = bottomH + middleH / 2 + frameT / 2;
                    doorSlab.add(dMiddle);

                    const dTop = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT * 2, topH - frameT, 0.04), this.panelMaterial);
                    dTop.position.y = bottomH + middleH + topH / 2 + frameT / 2;
                    doorSlab.add(dTop);

                    // Door Handle
                    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.1), this.frameMaterial);
                    handle.position.set(panelWidth / 2 - frameT * 2, bottomH + 0.2, 0);
                    doorSlab.add(handle);

                    // Door Frame (border)
                    const dFrame = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - frameT, totalHeight - frameT * 2, 0.06), this.frameMaterial);
                    dFrame.position.y = totalHeight / 2;
                    dFrame.material = new THREE.MeshStandardMaterial({ color: this.color === 'black' ? 0x000000 : 0x999999 });
                    // doorSlab.add(dFrame); // Removed to keep it looking like a door slab

                    doorGroup.add(doorSlab);
                    doorGroup.userData = { isDoor: true, panelIndex: i, isOpen: false };
                    this.add(doorGroup);
                }
            }
        }
        this.loadedPanels = numPanels;
    }

    addDoor(index: number) {
        this.doorIndices.add(index);
        this.build(this.loadedPanels);
    }

    removeDoor(index: number) {
        this.doorIndices.delete(index);
        this.openDoorIndices.delete(index);
        this.build(this.loadedPanels);
    }

    toggleDoorSwing(index: number) {
        if (this.openDoorIndices.has(index)) {
            this.openDoorIndices.delete(index);
        } else {
            this.openDoorIndices.add(index);
        }
        this.build(this.loadedPanels);
    }

    setNumPanels(n: number) {
        this.build(n);
    }

    updateFrameColor(color: 'black' | 'silver') {
        this.color = color;
        this.frameMaterial.color.set(color === 'black' ? 0x111111 : 0xcccccc);
        this.build(this.loadedPanels);
    }

    highlightPanel(index: number) {
        // Find existing highlight and remove
        this.children = this.children.filter(c => c.name !== 'highlight');

        const panelWidth = 0.8;
        const totalHeight = 2.4;
        const frameT = 0.05;
        const totalWidth = panelWidth * this.loadedPanels + frameT;
        const xPos = -totalWidth / 2 + index * panelWidth + panelWidth / 2 + frameT / 2;

        const h = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, totalHeight, 0.1), this.highlightMaterial);
        h.position.set(xPos, totalHeight / 2, 0);
        h.name = 'highlight';
        this.add(h);
    }

    clearHighlight() {
        this.children = this.children.filter(c => c.name !== 'highlight');
    }
}
