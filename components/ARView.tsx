'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ARPartition, PartitionSettings } from './ARPartition';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { useFPSController } from '@/hooks/useFPSController';
import { useJoystickControls } from '@/hooks/useJoystickControls';
import { useTouchLook } from '@/hooks/useTouchLook';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface WallAnchors {
    wallId: string;
    startAnchor: any;           // XRAnchor (local)
    endAnchor: any;             // XRAnchor (local)
    cloudAnchorIdStart?: string;
    cloudAnchorIdEnd?: string;
}

interface DrawnWall {
    wallId: string;
    mesh: ARPartition;
    startPt: THREE.Vector3;
    endPt: THREE.Vector3;
    frameColor: 'black' | 'silver';
    numPanels: number;
}

// ─── CLOUD ANCHOR HELPERS ─────────────────────────────────────────────────────

const CLOUD_ANCHOR_TIMEOUT_MS = 30_000;

/** Hosts a local XRAnchor to Google Cloud. Returns cloudAnchorId or null. */
async function hostCloudAnchor(
    anchor: any,
    session: any
): Promise<string | null> {
    try {
        if (!session.hostCloudAnchor) {
            console.warn('[CloudAnchor] hostCloudAnchor not supported on this session.');
            return null;
        }
        const cloudAnchorId: string = await session.hostCloudAnchor(anchor, { daysToExpire: 365 });
        console.log('[CloudAnchor] Hosted successfully. ID:', cloudAnchorId);
        return cloudAnchorId;
    } catch (err: any) {
        console.error('[CloudAnchor] Host failed:', err?.message || err);
        return null;
    }
}

/** Resolves a Cloud Anchor ID back to an XRAnchor. Polls until success/failure/timeout. */
async function resolveCloudAnchor(
    cloudAnchorId: string,
    session: any,
    attempt: number = 1,
    onProgress?: (msg: string) => void
): Promise<any | null> {
    if (!session.resolveCloudAnchor) {
        console.warn('[CloudAnchor] resolveCloudAnchor not supported on this session.');
        return null;
    }
    try {
        console.log(`[XR Logging] Attempting to resolve ${cloudAnchorId} (Attempt ${attempt}/3)`);
        const anchor = await session.resolveCloudAnchor(cloudAnchorId);
        const startTime = Date.now();

        return new Promise<any | null>((resolve) => {
            const poll = setInterval(async () => {
                const state: string = anchor.cloudAnchorState || 'pending';
                // Log state quietly to avoid spamming unless it's a final state

                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                if (elapsedSeconds === 10) onProgress?.('Takes longer than usual... look around slowly.');
                else if (elapsedSeconds === 20) onProgress?.('Still resolving... try moving closer to origin.');
                else if (elapsedSeconds >= 30) onProgress?.('Anchor resolution heavily delayed...');

                if (state === 'success') {
                    clearInterval(poll);
                    console.log(`[XR Logging] [SUCCESS] Resolved ${cloudAnchorId}`);
                    resolve(anchor);
                } else if (
                    state === 'error_not_localized' ||
                    state === 'error_not_found' ||
                    state === 'error_cloud_service' ||
                    state.startsWith('error')
                ) {
                    clearInterval(poll);
                    console.error(`[XR Logging] [ERROR] Resolving ${cloudAnchorId} failed: ${state}`);
                    if (attempt < 3) {
                        resolve(await resolveCloudAnchor(cloudAnchorId, session, attempt + 1, onProgress));
                    } else {
                        resolve(null);
                    }
                } else if (Date.now() - startTime > CLOUD_ANCHOR_TIMEOUT_MS) {
                    clearInterval(poll);
                    console.warn(`[XR Logging] [TIMEOUT] Resolving ${cloudAnchorId} timed out.`);
                    if (attempt < 3) {
                        resolve(await resolveCloudAnchor(cloudAnchorId, session, attempt + 1, onProgress));
                    } else {
                        resolve(null);
                    }
                }
            }, 500);
        });
    } catch (err: any) {
        console.error(`[XR Logging] [EXCEPTION] Resolving ${cloudAnchorId}:`, err?.message || err);
        if (attempt < 3) {
            return resolveCloudAnchor(cloudAnchorId, session, attempt + 1, onProgress);
        }
        return null;
    }
}

/** Checks anchor quality before hosting. Returns 'sufficient', 'good', 'insufficient'. */
async function checkAnchorQuality(anchor: any, session: any): Promise<string> {
    try {
        if (!session.estimateAnchorQuality) return 'sufficient'; // Fallback: proceed
        const quality: string = await session.estimateAnchorQuality(anchor);
        console.log('[AnchorQuality]', quality);
        return quality;
    } catch {
        return 'sufficient'; // Fallback: proceed
    }
}

// ─── SMOOTHING HELPER ─────────────────────────────────────────────────────────
// Optional lerp for position updates to reduce jitter on low-confidence tracking

const LERP_FACTOR = 0.3; // 0 = no update, 1 = instant snap. 0.3 = smooth

function lerpVec3(current: THREE.Vector3, target: THREE.Vector3, alpha: number): THREE.Vector3 {
    return current.clone().lerp(target, alpha);
}

function lerpAngle(current: number, target: number, alpha: number): number {
    // Handle wraparound
    let diff = target - current;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return current + diff * alpha;
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function ARView() {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const reticleRef = useRef<THREE.Mesh | null>(null);

    // Navigation Controls
    const orbitControlsRef = useRef<OrbitControls | null>(null);
    const [navMode, setNavMode] = useState<'edit' | 'walk'>('edit');
    // ── navModeRef: ref so animation loop reads live value (no stale closure) ──
    const navModeRef = useRef<'edit' | 'walk'>('edit');
    const [isPointerLocked, setIsPointerLocked] = useState(false);
    const lastTimeRef = useRef<number>(performance.now());

    // ── FPS Controller: unified keyboard + mouse-look + movement per frame ──
    const fpsController = useFPSController();
    // ── Joystick writes into the same movementInput ref as keyboard ──
    const { joystickContainerRef } = useJoystickControls(fpsController.movementInput, navMode === 'walk');
    // ── Mobile touch-look (right-half of screen) ──
    useTouchLook(cameraRef.current, navMode === 'walk');

    // Wall registry: wallId → { mesh, startAnchor, endAnchor }
    const wallMeshesRef = useRef<Map<string, DrawnWall>>(new Map());
    const wallAnchorsRef = useRef<Map<string, WallAnchors>>(new Map());

    // Legacy tap-to-place anchors (kept for preview-mode functionality)
    const tapAnchorsRef = useRef<Map<any, THREE.Group>>(new Map());

    const hitTestSourceRef = useRef<any | null>(null);
    const hitTestSourceRequestedRef = useRef<boolean>(false);
    const previewModelRef = useRef<ARPartition | null>(null);
    const referenceSpaceRef = useRef<any | null>(null); // Cached local-floor ref space

    // Selection / Dragging
    const selectedPartitionRef = useRef<THREE.Group | null>(null);
    const isDraggingRef = useRef<boolean>(false);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const previewLineRef = useRef<THREE.Line | null>(null);
    const linePointsRef = useRef<THREE.Vector3[]>([]);
    const previewMeshesRef = useRef<THREE.Object3D[]>([]);

    // Debug sphere markers for anchor positions
    const anchorDebugMeshesRef = useRef<THREE.Mesh[]>([]);

    // Smoothing toggle
    const useSmoothingRef = useRef<boolean>(true);

    // Recalibration
    const isRecalibratingRef = useRef<boolean>(false);
    const recalibrationOffsetRef = useRef(new THREE.Vector3(0, 0, 0));

    const [isMounted, setIsMounted] = useState(false);
    const [arSupported, setArSupported] = useState(true);
    const [frameColor, setFrameColor] = useState<'black' | 'silver'>('black');
    const [numPanels, setNumPanels] = useState(4);
    const [activeSession, setActiveSession] = useState<any | null>(null);
    const [debugStatus, setDebugStatus] = useState('System Initializing...');
    const [showDebug, setShowDebug] = useState(false);

    // Resolution progress
    const [resolveProgress, setResolveProgress] = useState({ resolved: 0, total: 0 });
    const [isRecalibrationMode, setIsRecalibrationMode] = useState(false);

    // Mode 3 State
    const [mode3Active, setMode3Active] = useState(false);

    // Drawing States
    const [isLineMode, setIsLineMode] = useState(false);
    const [isCurrentlyDrawing, setIsCurrentlyDrawing] = useState(false);
    const [correctedPoints, setCorrectedPoints] = useState<{ start: THREE.Vector3, end: THREE.Vector3 } | null>(null);
    const [isConfirming, setIsConfirming] = useState(false);
    const [anchorQualityWarning, setAnchorQualityWarning] = useState(false);

    const [selectedPanel, setSelectedPanel] = useState<{
        index: number;
        position: THREE.Vector3;
        isDoor: boolean;
    } | null>(null);
    const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });

    const settingsRef = useRef({ frameColor, numPanels });
    useEffect(() => { settingsRef.current = { frameColor, numPanels }; }, [frameColor, numPanels]);

    // ── Keep navModeRef in sync with navMode state ────────────────────────────
    useEffect(() => {
        navModeRef.current = navMode;
    }, [navMode]);

    // ── Controls lifecycle: OrbitControls ↔ FPS Controller ─────────────────
    useEffect(() => {
        if (navMode === 'walk') {
            console.log('[System] WALK MODE ENABLED — disabling OrbitControls');
            // Hard-disable OrbitControls so it cannot capture mouse events
            if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
            fpsController.resetVelocity();
            if (cameraRef.current) {
                cameraRef.current.position.y = 1.6;
                // Sync yaw/pitch so camera doesn't snap when entering walk mode
                fpsController.syncFromCamera(cameraRef.current);
            }
        } else {
            console.log('[System] EDIT MODE ENABLED — restoring OrbitControls');
            // Release pointer lock and re-enable orbit
            fpsController.unlock();
            fpsController.resetVelocity();
            if (orbitControlsRef.current) {
                orbitControlsRef.current.enabled = !isLineMode;
            }
        }
    }, [navMode]);

    // Keep OrbitControls disabled while drawing (separate concern)
    useEffect(() => {
        if (orbitControlsRef.current && navMode === 'edit') {
            orbitControlsRef.current.enabled = !isLineMode;
        }
    }, [isLineMode, navMode]);

    // ─── DRAWING CLEANUP ───────────────────────────────────────────────────────

    const cleanupDrawing = () => {
        setIsLineMode(false);
        setIsCurrentlyDrawing(false);
        linePointsRef.current = [];
        setCorrectedPoints(null);
        setIsConfirming(false);
        setAnchorQualityWarning(false);
        setDebugStatus('Preview Active');
        if (previewLineRef.current) {
            sceneRef.current?.remove(previewLineRef.current);
            previewLineRef.current = null;
        }
        previewMeshesRef.current.forEach(m => sceneRef.current?.remove(m));
        previewMeshesRef.current = [];
    };

    // ─── PCA LINE CORRECTION ──────────────────────────────────────────────────

    const runAICorrection = (points: THREE.Vector3[]) => {
        if (points.length < 5) {
            cleanupDrawing();
            setDebugStatus('Trace a longer line!');
            return;
        }

        const n = points.length;
        let sumX = 0, sumZ = 0;
        points.forEach(p => { sumX += p.x; sumZ += p.z; });
        const meanX = sumX / n;
        const meanZ = sumZ / n;

        let sxx = 0, szz = 0, sxz = 0;
        points.forEach(p => {
            sxx += (p.x - meanX) ** 2;
            szz += (p.z - meanZ) ** 2;
            sxz += (p.x - meanX) * (p.z - meanZ);
        });

        const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
        const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).normalize();

        const project = (p: THREE.Vector3) => {
            const offset = p.clone().sub(new THREE.Vector3(meanX, 0, meanZ));
            return new THREE.Vector3(meanX, 0.01, meanZ).add(dir.clone().multiplyScalar(offset.dot(dir)));
        };

        const start = project(points[0]);
        const end = project(points[n - 1]);

        setCorrectedPoints({ start, end });
        setIsConfirming(true);
        setDebugStatus(`Wall: ${start.distanceTo(end).toFixed(2)}m. Confirm?`);

        if (previewLineRef.current) {
            previewLineRef.current.geometry.setFromPoints([start, end]);
            (previewLineRef.current.material as THREE.LineBasicMaterial).color.set(0xffffff);

            const sphereGeo = new THREE.SphereGeometry(0.08);
            const sphereMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
            [start, end].forEach(p => {
                const s = new THREE.Mesh(sphereGeo, sphereMat);
                s.position.copy(p);
                sceneRef.current?.add(s);
                previewMeshesRef.current.push(s);
            });
        }
    };

    // ─── CONFIRM WALL — ANCHOR-DRIVEN ─────────────────────────────────────────
    // FIX #1 (Anchor Drift): Every wall MUST be bound to two XRAnchors.
    // The mesh is positioned from anchor poses in the frame loop, never statically.

    const confirmLineWall = async () => {
        if (!correctedPoints || !sceneRef.current) return;
        const { start, end } = correctedPoints;
        const center = start.clone().lerp(end, 0.5);
        const length = start.distanceTo(end);
        if (length < 0.2) { cleanupDrawing(); return; }

        const renderer = rendererRef.current;
        const refSpace = referenceSpaceRef.current;
        const session = renderer?.xr?.getSession?.();

        const wallId = `wall_${Date.now()}`;
        const nPanels = Math.max(1, Math.round(length / 0.8));
        const partition = new ARPartition({ frameColor: settingsRef.current.frameColor, numPanels: nPanels });

        // ── IMPORTANT: matrixAutoUpdate = false for anchor-driven walls ──
        // The frame loop will set position/rotation directly from anchor poses.
        // We set an initial position here only as a brief visual until anchors
        // are created (typically < 1 frame).
        const direction = end.clone().sub(start).normalize();
        const rotAngle = Math.atan2(direction.x, direction.z);
        partition.position.copy(center);
        partition.rotation.y = rotAngle + Math.PI / 2;

        sceneRef.current.add(partition);

        // Store wall data immediately so frame loop can reference it
        wallMeshesRef.current.set(wallId, {
            wallId,
            mesh: partition,
            startPt: start.clone(),
            endPt: end.clone(),
            frameColor: settingsRef.current.frameColor,
            numPanels: nPanels,
        });

        cleanupDrawing();
        setDebugStatus('Creating anchors...');

        // ── Try to create XR Anchors if session exists ──
        if (session && refSpace) {
            try {
                // Build XRRigidTransform poses for start and end points
                const startPos = { x: start.x, y: start.y, z: start.z };
                const endPos = { x: end.x, y: end.y, z: end.z };
                const neutralRot = { x: 0, y: 0, z: 0, w: 1 };

                const startPose = new (window as any).XRRigidTransform(startPos, neutralRot);
                const endPose = new (window as any).XRRigidTransform(endPos, neutralRot);

                // Get the current XRFrame for anchor creation
                const xrFrame = renderer!.xr!.getFrame?.();

                // Safe check: Ensure xrFrame exists and createAnchor API is available on this device
                if (xrFrame && typeof xrFrame.createAnchor === 'function') {
                    const startAnchor = await xrFrame.createAnchor(startPose, refSpace);
                    const endAnchor = await xrFrame.createAnchor(endPose, refSpace);

                    if (startAnchor && endAnchor) {
                        // ── Anchor Quality Check (FIX #3) ─────────────────────
                        const quality = await checkAnchorQuality(startAnchor, session);
                        if (quality === 'insufficient') {
                            setAnchorQualityWarning(true);
                            setDebugStatus('⚠️ Move camera for better tracking...');
                            // Still store, but warn user
                        }

                        const anchorEntry: WallAnchors = { wallId, startAnchor, endAnchor };
                        wallAnchorsRef.current.set(wallId, anchorEntry);
                        setDebugStatus('Anchors created ✓');

                        // ── Add debug markers ─────────────────────────────────
                        if (showDebug) {
                            addDebugSphere(start, 0xff0000);
                            addDebugSphere(end, 0x00ff00);
                        }

                        // ── Attempt Cloud Anchor Hosting (FIX #2) ─────────────
                        if (quality === 'sufficient' || quality === 'good') {
                            setDebugStatus('Hosting to cloud...');
                            const [cloudStart, cloudEnd] = await Promise.all([
                                hostCloudAnchor(startAnchor, session),
                                hostCloudAnchor(endAnchor, session),
                            ]);

                            anchorEntry.cloudAnchorIdStart = cloudStart ?? undefined;
                            anchorEntry.cloudAnchorIdEnd = cloudEnd ?? undefined;
                            setDebugStatus(cloudStart ? '☁️ Cloud anchors hosted ✓' : 'Local anchors only');
                            await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, cloudStart, cloudEnd);
                        } else {
                            setDebugStatus('⚠️ Cloud anchor skipped — low quality');
                            await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, null, null);
                        }
                    } else {
                        // Anchor creation returned null — wall stays at static position as last resort
                        console.warn('[Anchor] createAnchor returned null for one or both endpoints.');
                        setDebugStatus('⚠️ Anchors not created — static fallback');
                        await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, null, null);
                    }
                } else {
                    const reason = !xrFrame ? 'No XRFrame available' : 'Anchor API unsupported';
                    console.warn(`[Anchor] ${reason} — cannot create anchors (static fallback)`);
                    setDebugStatus(`⚠️ ${reason} — static fallback`);
                    await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, null, null);
                }
            } catch (err: any) {
                console.error('[Anchor] Creation failed:', err?.message || err);
                setDebugStatus('Anchors failed — wall placed statically');
                await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, null, null);
            }
        } else {
            // Desktop/non-AR mode — save without anchors
            setDebugStatus('Wall placed (Desktop mode)');
            await persistWallToSupabase(wallId, start, end, nPanels, settingsRef.current.frameColor, null, null);
        }
    };

    // ─── ADD DEBUG SPHERE MARKER ───────────────────────────────────────────────

    const addDebugSphere = (pos: THREE.Vector3, color: number) => {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(0.04),
            new THREE.MeshBasicMaterial({ color })
        );
        m.position.copy(pos);
        sceneRef.current?.add(m);
        anchorDebugMeshesRef.current.push(m);
    };

    // ─── SUPABASE PERSISTENCE ──────────────────────────────────────────────────

    const persistWallToSupabase = async (
        wallId: string,
        start: THREE.Vector3,
        end: THREE.Vector3,
        numPanels: number,
        frameColor: string,
        cloudAnchorIdStart: string | null,
        cloudAnchorIdEnd: string | null
    ) => {
        if (!isSupabaseConfigured) return;
        const { error } = await supabase.from('ar_walls').upsert({
            wall_id: wallId,
            start_x: start.x, start_y: start.y, start_z: start.z,
            end_x: end.x, end_y: end.y, end_z: end.z,
            num_panels: numPanels,
            frame_color: frameColor,
            cloud_anchor_id_start: cloudAnchorIdStart,
            cloud_anchor_id_end: cloudAnchorIdEnd,
            created_at: new Date().toISOString(),
        }, { onConflict: 'wall_id' });

        if (error) console.error('[Supabase] Wall save failed:', error);
        else console.log('[Supabase] Wall saved:', wallId);
    };

    // ─── RESOLVE SAVED WALLS ON SESSION START (MODE 2) ────────────────────────
    // FIX #2: Cloud Anchor resolving — fetch layout from Supabase, resolve each
    // cloud anchor, render wall once resolved. Falls back to local coords on failure.

    const resolveWallsFromSupabase = useCallback(async (session: any) => {
        if (!isSupabaseConfigured) return;
        setDebugStatus('Resolving saved walls...');

        const { data: walls, error } = await supabase
            .from('ar_walls')
            .select('*');

        const cloudWalls = (walls || []).filter(w => w.cloud_anchor_id_start);

        if (error || !cloudWalls.length) {
            setDebugStatus('No saved walls found.');
            return;
        }

        const total = cloudWalls.length;
        setResolveProgress({ resolved: 0, total });
        setDebugStatus(`Resolving walls (0/${total})...`);
        let resolvedCount = 0;

        console.log(`[XR Logging] Starting parallel resolution of ${total} cloud walls.`);

        // Resolve walls progressively
        cloudWalls.forEach(async (row: any) => {
            const handleProgress = (msg: string) => setDebugStatus(msg);
            const [startAnchor, endAnchor] = await Promise.all([
                resolveCloudAnchor(row.cloud_anchor_id_start, session, 1, handleProgress),
                resolveCloudAnchor(row.cloud_anchor_id_end, session, 1, handleProgress),
            ]);

            const resolvedBoth = !!(startAnchor && endAnchor);
            const resolvedOne = !!(startAnchor || endAnchor);

            console.log(`[XR Logging] Wall ${row.wall_id} resolved: ${resolvedBoth ? 'FULL' : resolvedOne ? 'PARTIAL' : 'FAILED'}`);

            const partition = new ARPartition({
                frameColor: row.frame_color || 'black',
                numPanels: row.num_panels || 4,
            });
            sceneRef.current?.add(partition);

            // Confidence UI - add to user data
            partition.userData.confidence = resolvedBoth ? 'high' : resolvedOne ? 'medium' : 'low';

            if (resolvedBoth) {
                wallMeshesRef.current.set(row.wall_id, {
                    wallId: row.wall_id,
                    mesh: partition,
                    startPt: new THREE.Vector3(row.start_x, row.start_y, row.start_z),
                    endPt: new THREE.Vector3(row.end_x, row.end_y, row.end_z),
                    frameColor: row.frame_color || 'black',
                    numPanels: row.num_panels || 4,
                });
                wallAnchorsRef.current.set(row.wall_id, {
                    wallId: row.wall_id,
                    startAnchor,
                    endAnchor,
                    cloudAnchorIdStart: row.cloud_anchor_id_start,
                    cloudAnchorIdEnd: row.cloud_anchor_id_end,
                });
            } else {
                // Cloud resolve failed — render at stored static coordinates as fallback
                const start = new THREE.Vector3(row.start_x, row.start_y, row.start_z);
                const end = new THREE.Vector3(row.end_x, row.end_y, row.end_z);
                const center = start.clone().lerp(end, 0.5);
                const direction = end.clone().sub(start).normalize();
                const rotAngle = Math.atan2(direction.x, direction.z);

                // Add offset logic on the frame loop by creating wallMeshes without anchors
                partition.position.copy(center);
                partition.rotation.y = rotAngle + Math.PI / 2;

                wallMeshesRef.current.set(row.wall_id, {
                    wallId: row.wall_id,
                    mesh: partition,
                    startPt: start,
                    endPt: end,
                    frameColor: row.frame_color || 'black',
                    numPanels: row.num_panels || 4,
                });
            }

            resolvedCount++;
            setResolveProgress({ resolved: resolvedCount, total });
            
            if (resolvedCount === total) {
                setDebugStatus(`Walls resolved ✓`);
            } else {
                setDebugStatus(`Resolving walls (${resolvedCount}/${total})...`);
            }
        });
    }, []);

    // ─── TOUCH HANDLERS ───────────────────────────────────────────────────────

    const onTouchStart = (event: React.TouchEvent | React.MouseEvent) => {
        if (navMode === 'walk') return;

        const camera = cameraRef.current;
        const scene = sceneRef.current;
        if (!camera || !scene) return;

        const px = ('touches' in event) ? event.touches[0].clientX : (event as any).clientX;
        const py = ('touches' in event) ? event.touches[0].clientY : (event as any).clientY;
        pointerRef.current.x = (px / window.innerWidth) * 2 - 1;
        pointerRef.current.y = -(py / window.innerHeight) * 2 + 1;
        raycasterRef.current.setFromCamera(pointerRef.current, camera);

        if (isRecalibrationMode) {
            const floorIntersects = raycasterRef.current.intersectObjects(
                scene.children.filter(c => c.name === 'floor_plane'),
                true
            );
            if (floorIntersects.length > 0) {
                const originPoint = floorIntersects[0].point.clone();
                originPoint.y = 0; // Only XZ offset matters for floor plan
                
                recalibrationOffsetRef.current = originPoint;
                setDebugStatus('Position Recalibrated ✓');
                setIsRecalibrationMode(false);
                console.log(`[XR Logging] Recalibrated origin to:`, originPoint);
            }
            return;
        }

        if (isLineMode && !isConfirming) {
            const floorIntersects = raycasterRef.current.intersectObjects(
                scene.children.filter(c => c.name === 'floor_plane'),
                true
            );
            if (floorIntersects.length > 0) {
                const point = floorIntersects[0].point.clone();
                point.y = 0.01;
                linePointsRef.current = [point];
                setIsCurrentlyDrawing(true);
                setDebugStatus('Tracing Line...');

                if (previewLineRef.current) scene.remove(previewLineRef.current);
                const line = new THREE.Line(
                    new THREE.BufferGeometry(),
                    new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 })
                );
                scene.add(line);
                previewLineRef.current = line;
            }
            return;
        }

        // Raycast against all wall meshes + preview
        const allMeshes: THREE.Object3D[] = [
            ...Array.from(wallMeshesRef.current.values()).map(w => w.mesh),
            ...Array.from(tapAnchorsRef.current.values()),
        ];
        if (previewModelRef.current) allMeshes.push(previewModelRef.current);

        const intersects = raycasterRef.current.intersectObjects(allMeshes, true);

        if (intersects.length > 0) {
            let target = intersects[0].object;
            while (target.parent && !(target instanceof ARPartition)) { target = target.parent; }
            if (target instanceof ARPartition) {
                const intersect = intersects[0];
                const isDoorMesh = (obj: THREE.Object3D) => {
                    let curr: THREE.Object3D | null = obj;
                    while (curr && curr !== target) {
                        if (curr.userData.isDoor) return curr;
                        curr = curr.parent;
                    }
                    return null;
                };

                const doorObj = isDoorMesh(intersect.object);
                const isDoor = !!doorObj;
                const panelIndex = isDoor ? doorObj!.userData.panelIndex : intersect.object.userData.panelIndex;

                if (intersect.object.userData.isPanel || isDoor) {
                    target.highlightPanel(panelIndex);
                    setSelectedPanel({ index: panelIndex, position: intersect.point, isDoor });
                    const pos = intersect.point.clone().project(camera);
                    setPopupPos({
                        x: (pos.x * 0.5 + 0.5) * window.innerWidth,
                        y: (-(pos.y * 0.5) + 0.5) * window.innerHeight
                    });
                }
                selectedPartitionRef.current = target;
                isDraggingRef.current = true;
            }
        }
    };

    const onTouchMove = (event: React.TouchEvent | React.MouseEvent) => {
        if (!isCurrentlyDrawing || !isLineMode || navMode === 'walk') return;
        const camera = cameraRef.current;
        const scene = sceneRef.current;
        if (!camera || !scene) return;

        const px = ('touches' in event) ? event.touches[0].clientX : (event as any).clientX;
        const py = ('touches' in event) ? event.touches[0].clientY : (event as any).clientY;
        pointerRef.current.x = (px / window.innerWidth) * 2 - 1;
        pointerRef.current.y = -(py / window.innerHeight) * 2 + 1;
        raycasterRef.current.setFromCamera(pointerRef.current, camera);

        const intersects = raycasterRef.current.intersectObjects(
            scene.children.filter(c => c.name === 'floor_plane'),
            true
        );
        if (intersects.length > 0) {
            const point = intersects[0].point.clone();
            point.y = 0.01;
            linePointsRef.current.push(point);
            if (previewLineRef.current) {
                previewLineRef.current.geometry.setFromPoints(linePointsRef.current);
            }
        }
    };

    const onTouchEnd = () => {
        if (isCurrentlyDrawing) {
            setIsCurrentlyDrawing(false);
            runAICorrection(linePointsRef.current);
        }
        isDraggingRef.current = false;
        selectedPartitionRef.current = null;
    };

    // ─── XR SELECT (tap-to-place mode) ────────────────────────────────────────

    const onSelect = useCallback((event: any) => {
        const renderer = rendererRef.current;
        if (!renderer || isDraggingRef.current) return;
        const session = renderer.xr.getSession();
        if (!session) return;
        const referenceSpace = renderer.xr.getReferenceSpace()!;
        const hitTestResults = event.frame.getHitTestResults(hitTestSourceRef.current);
        if (hitTestResults.length > 0) {
            const pose = hitTestResults[0].getPose(referenceSpace);
            // Safe check for createAnchor support before tap-to-place
            if (typeof (session as any).createAnchor === 'function') {
                (session as any).createAnchor(pose.transform, referenceSpace).then((anchor: any) => {
                    const partition = new ARPartition({ frameColor: settingsRef.current.frameColor, numPanels: settingsRef.current.numPanels });
                    (partition as any).matrixAutoUpdate = false;
                    sceneRef.current?.add(partition);
                    tapAnchorsRef.current.set(anchor, partition);
                });
            } else {
                console.warn('[Anchor] tap-to-place createAnchor not supported on this session.');
            }
        }
    }, []);

    // ─── MOUNT & DEVICE CAPABILITY ────────────────────────────────────────────

    useEffect(() => { 
        setIsMounted(true); 
        if (navigator.xr) {
            navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
                setArSupported(supported);
            });
        } else {
            setArSupported(false);
        }
    }, []);

    // ─── SCENE & RENDERER SETUP ───────────────────────────────────────────────
    // FIX #4: AR Stability — use 'local-floor' reference space, avoid re-creating
    // scene objects every frame, debug mode shows anchor points + floor plane.

    useEffect(() => {
        if (!isMounted || !containerRef.current) return;

        console.log('[ARView] Initializing Three.js scene...');
        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const grid = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        scene.add(grid);

        const floorPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(100, 100),
            new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.1 })
        );
        floorPlane.rotateX(-Math.PI / 2);
        floorPlane.name = 'floor_plane';
        scene.add(floorPlane);

        const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
        camera.position.set(2, 3, 5);
        camera.lookAt(0, 0, 0);
        cameraRef.current = camera;

        const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
        scene.add(light);
        const dirLight = new THREE.DirectionalLight(0xffffff, 2);
        dirLight.position.set(5, 10, 7.5);
        scene.add(dirLight);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.xr.enabled = true;

        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // Initialize Controls
        const orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.dampingFactor = 0.05;
        orbitControls.enabled = navMode === 'edit';
        orbitControlsRef.current = orbitControls;

        // ── Track pointer lock state for UI (lock/unlock button label) ─────────────
        // useFPSController handles the actual requestPointerLock + mousemove.
        // Here we just sync the React state for the button label.
        const onPointerLockChange = () => {
            const locked = document.pointerLockElement === renderer.domElement;
            setIsPointerLocked(locked);
            console.log('[FPS] pointerlockchange — locked:', locked);
        };
        document.addEventListener('pointerlockchange', onPointerLockChange);

        const previewModel = new ARPartition({ frameColor: settingsRef.current.frameColor, numPanels: settingsRef.current.numPanels });
        scene.add(previewModel);
        previewModelRef.current = previewModel;

        const reticle = new THREE.Mesh(
            new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ color: 0x00ff00 })
        );
        reticle.matrixAutoUpdate = false;
        reticle.visible = false;
        scene.add(reticle);
        reticleRef.current = reticle;

        // FIX #4: Request 'local-floor' as required feature for ground-plane stability.
        // 'cloud-anchors' is optional — gracefully degrades if unavailable.
        const arButton = ARButton.createButton(renderer, {
            requiredFeatures: ['hit-test', 'anchors', 'local-floor'],
            optionalFeatures: ['dom-overlay', 'cloud-anchors'],
            domOverlay: { root: document.body },
        });
        document.body.appendChild(arButton);

        const controller = renderer.xr.getController(0);
        controller.addEventListener('select', (e: any) => onSelect({ ...e, frame: renderer.xr.getFrame() }));
        scene.add(controller);

        // ─── FRAME LOOP ────────────────────────────────────────────────────────
        // FIX #1 + #4: Anchor-driven transforms computed here.
        // No scene objects are re-created per frame — only positions are updated.

        renderer.setAnimationLoop((_timestamp: number, frame: any) => {
            const time = performance.now();
            const delta = (time - lastTimeRef.current) / 1000;
            lastTimeRef.current = time;

            // ── Animation loop: Walk Mode uses FPS controller, Edit uses OrbitControls ──
            if (navModeRef.current === 'walk') {
                // Double-guard: ensure OrbitControls cannot touch the camera
                if (orbitControlsRef.current?.enabled) orbitControlsRef.current.enabled = false;
                // FPS controller applies mouse-look rotation + WASD/joystick movement
                fpsController.updateFrame(camera, delta);
            } else {
                orbitControlsRef.current?.update();
            }

            if (frame) {
                // Use 'local-floor' reference space for better ground-plane stability
                const referenceSpace = renderer.xr.getReferenceSpace()!;
                referenceSpaceRef.current = referenceSpace;

                if (previewModelRef.current) previewModelRef.current.visible = false;
                if (!activeSession) setActiveSession(frame.session);

                // ── Session start: resolve previously saved walls (runs once) ──
                if (!hitTestSourceRequestedRef.current) {
                    // Resolve saved walls from Supabase when entering AR
                    resolveWallsFromSupabase(frame.session);

                    frame.session.requestReferenceSpace('viewer').then((vs: any) => {
                        frame.session.requestHitTestSource({ space: vs }).then((s: any) => {
                            hitTestSourceRef.current = s;
                        });
                    });
                    frame.session.addEventListener('end', () => {
                        hitTestSourceRequestedRef.current = false;
                        hitTestSourceRef.current = null;
                        referenceSpaceRef.current = null;
                        setActiveSession(null);
                    });
                    hitTestSourceRequestedRef.current = true;
                }

                // Update reticle from hit-test
                if (hitTestSourceRef.current) {
                    const results = frame.getHitTestResults(hitTestSourceRef.current);
                    if (results.length > 0) {
                        const pose = results[0].getPose(referenceSpace);
                        reticle.visible = true;
                        reticle.matrix.fromArray(pose.transform.matrix);

                        // Drag selected partition to reticle position
                        if (isDraggingRef.current && selectedPartitionRef.current) {
                            selectedPartitionRef.current.position.setFromMatrixPosition(reticle.matrix);
                            selectedPartitionRef.current.updateMatrix();
                        }
                    } else {
                        reticle.visible = false;
                    }
                }

                // ── ANCHOR-DRIVEN WALL TRANSFORMS — NO DRIFT (FIX #1) ───────────
                // For every drawn wall with local anchors, update position from anchor
                // poses every single frame. This is the ONLY source of truth for position.
                const trackedAnchors: Set<any> = frame.trackedAnchors || new Set();

                // ── REFERENCE WALL ARCHITECTURE (FIX #3) ──────────────────────
                // 1. Determine Rigid Body Offset from the first available tracked pair
                let activeTrackingOffset: THREE.Vector3 | null = null;
                let activeTrackingAngleDiff: number = 0;

                for (const [wallId, anchorEntry] of wallAnchorsRef.current.entries()) {
                    const { startAnchor, endAnchor } = anchorEntry;
                    if (trackedAnchors.has(startAnchor) && trackedAnchors.has(endAnchor)) {
                        const startPose = frame.getPose(startAnchor.anchorSpace, referenceSpace);
                        const endPose = frame.getPose(endAnchor.anchorSpace, referenceSpace);
                        if (startPose && endPose) {
                            const sPos = new THREE.Vector3(startPose.transform.position.x, startPose.transform.position.y, startPose.transform.position.z);
                            const ePos = new THREE.Vector3(endPose.transform.position.x, endPose.transform.position.y, endPose.transform.position.z);
                            
                            const liveCenter = sPos.clone().lerp(ePos, 0.5);
                            const liveDir = ePos.clone().sub(sPos).normalize();
                            const liveAngle = Math.atan2(liveDir.x, liveDir.z) + Math.PI / 2;

                            const wallData = wallMeshesRef.current.get(wallId);
                            if (wallData) {
                                const origCenter = wallData.startPt.clone().lerp(wallData.endPt, 0.5);
                                const origDir = wallData.endPt.clone().sub(wallData.startPt).normalize();
                                const origAngle = Math.atan2(origDir.x, origDir.z) + Math.PI / 2;

                                activeTrackingOffset = liveCenter.clone().sub(origCenter);
                                activeTrackingAngleDiff = liveAngle - origAngle;
                                break; // Found reference wall
                            }
                        }
                    }
                }

                // 2. Apply rigid layout to ALL walls (prevent cumulative drift)
                const finalOffset = activeTrackingOffset || recalibrationOffsetRef.current;
                const finalAngleDiff = activeTrackingAngleDiff || 0;

                wallMeshesRef.current.forEach((wallData, wallId) => {
                    // Skip if being dragged
                    if (isDraggingRef.current && selectedPartitionRef.current === wallData.mesh) return;

                    const origCenter = wallData.startPt.clone().lerp(wallData.endPt, 0.5);
                    const origDir = wallData.endPt.clone().sub(wallData.startPt).normalize();
                    const origAngle = Math.atan2(origDir.x, origDir.z) + Math.PI / 2;

                    const targetCenter = origCenter.clone().add(finalOffset);
                    const targetAngle = origAngle + finalAngleDiff;

                    // FIX #1 & #2: Anchor Jitter Filtering & Smooth Snap
                    const dist = wallData.mesh.position.distanceTo(targetCenter);
                    
                    if (dist > 0.005) { // Skip micro-movements < 5mm
                        if (useSmoothingRef.current && wallData.mesh.visible) {
                            wallData.mesh.position.copy(lerpVec3(wallData.mesh.position, targetCenter, LERP_FACTOR));
                            wallData.mesh.rotation.y = lerpAngle(wallData.mesh.rotation.y, targetAngle, LERP_FACTOR);
                        } else {
                            // First frame visibility -> direct snap to begin smooth path
                            wallData.mesh.position.copy(targetCenter);
                            wallData.mesh.rotation.y = targetAngle;
                        }
                    }

                    wallData.mesh.visible = true;
                    // Update Confidence intelligently
                    const hasLocalAnchors = wallAnchorsRef.current.has(wallId) && 
                        trackedAnchors.has(wallAnchorsRef.current.get(wallId)!.startAnchor);
                    
                    if (!activeTrackingOffset) wallData.mesh.userData.confidence = 'low'; // entirely disconnected
                    else if (hasLocalAnchors) wallData.mesh.userData.confidence = 'high'; // fully tracked
                    else wallData.mesh.userData.confidence = 'medium'; // securely locked to reference wall
                });

                // ── TAP-TO-PLACE ANCHOR UPDATE (legacy) ──────────────────────────
                tapAnchorsRef.current.forEach((mesh, anchor) => {
                    if (isDraggingRef.current && selectedPartitionRef.current === mesh) return;
                    if (!trackedAnchors.has(anchor)) { mesh.visible = false; return; }
                    const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
                    if (pose) { mesh.matrix.fromArray(pose.transform.matrix); mesh.visible = true; }
                    else { mesh.visible = false; }
                });
            }

            // Desktop preview rotation (non-XR mode only)
            if (!renderer.xr.isPresenting && previewModelRef.current) {
                previewModelRef.current.visible = true;
                previewModelRef.current.rotation.y += 0.005;
                if (
                    previewModelRef.current.children.length === 0 ||
                    settingsRef.current.numPanels !== (previewModelRef.current as any).loadedPanels
                ) {
                    previewModelRef.current.setNumPanels(settingsRef.current.numPanels);
                    (previewModelRef.current as any).loadedPanels = settingsRef.current.numPanels;
                }
                previewModelRef.current.updateFrameColor(settingsRef.current.frameColor);
            }

            renderer.render(scene, camera);
        });

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);
        setDebugStatus('Ready to Draw');

        return () => {
            window.removeEventListener('resize', handleResize);
            document.removeEventListener('pointerlockchange', onPointerLockChange);
            renderer.setAnimationLoop(null);
            renderer.dispose();
            if (arButton.parentNode) arButton.parentNode.removeChild(arButton);
        };
    }, [isMounted]);

    // ─── UI HELPERS ───────────────────────────────────────────────────────────

    const updateSelectedFrameColor = (color: 'black' | 'silver') => {
        setFrameColor(color);
        if (selectedPartitionRef.current instanceof ARPartition) {
            selectedPartitionRef.current.updateFrameColor(color);
        }
    };

    const toggleDebugMarkers = () => {
        const next = !showDebug;
        setShowDebug(next);
        anchorDebugMeshesRef.current.forEach(m => { m.visible = next; });
    };

    // ─── DEBUG-MODE: toggle visibility of floor plane and grid ───────────────

    useEffect(() => {
        if (!sceneRef.current) return;
        sceneRef.current.children.forEach(obj => {
            if (obj instanceof THREE.GridHelper) obj.visible = showDebug;
            if (obj.name === 'floor_plane') (obj as THREE.Mesh).material && ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).setValues({ opacity: showDebug ? 0.3 : 0.1 });
        });
    }, [showDebug]);

    // ─── BULK SAVE (fallback – saves all walls) ───────────────────────────────

    const saveAllToSupabase = async () => {
        if (!isSupabaseConfigured) { alert('Supabase keys missing!'); return; }
        const promises = Array.from(wallMeshesRef.current.values()).map(w => {
            const anchorData = wallAnchorsRef.current.get(w.wallId);
            return persistWallToSupabase(
                w.wallId, w.startPt, w.endPt, w.numPanels, w.frameColor,
                anchorData?.cloudAnchorIdStart ?? null,
                anchorData?.cloudAnchorIdEnd ?? null
            );
        });
        await Promise.allSettled(promises);
        alert('Layout saved!');
    };

    if (!isMounted) return <div className="fixed inset-0 bg-black" />;


    // ─── RENDER ───────────────────────────────────────────────────────────────

    return (
        <div className="fixed inset-0 bg-black overflow-hidden select-none touch-none font-sans">
            <div
                ref={containerRef}
                className="absolute inset-0 z-0 pointer-events-auto"
                style={{ cursor: isLineMode ? 'crosshair' : 'default' }}
                onMouseDown={onTouchStart}
                onTouchStart={onTouchStart}
                onMouseMove={onTouchMove}
                onTouchMove={onTouchMove}
                onMouseUp={onTouchEnd}
                onTouchEnd={onTouchEnd}
            />

            {/* Mobile Joystick Container */}
            <div ref={joystickContainerRef} className="absolute bottom-10 left-10 w-40 h-40 z-30 pointer-events-auto" />

            {/* Status bar */}
            <div className="absolute top-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none z-10 w-full">
                <div className="text-white bg-black/80 px-4 py-2 rounded-lg font-mono text-[10px] border border-blue-500/30 mb-2 shadow-2xl flex flex-col items-center">
                    <span>{debugStatus}</span>
                    {resolveProgress.total > 0 && resolveProgress.resolved < resolveProgress.total && (
                        <div className="w-full bg-gray-700 h-1 mt-1 rounded-full overflow-hidden">
                            <div className="bg-blue-400 h-full transition-all duration-300" style={{ width: `${(resolveProgress.resolved / resolveProgress.total) * 100}%` }} />
                        </div>
                    )}
                </div>

                <div className="flex gap-2 mb-2 pointer-events-auto">
                    <button 
                        onClick={() => setNavMode('edit')}
                        className={`px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${navMode === 'edit' ? 'bg-blue-600 text-white shadow-lg' : 'bg-black/60 text-white/60 border border-white/10'}`}
                    >
                        Edit Mode
                    </button>
                    <button 
                        onClick={() => setNavMode('walk')}
                        className={`px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${navMode === 'walk' ? 'bg-emerald-600 text-white shadow-lg' : 'bg-black/60 text-white/60 border border-white/10'}`}
                    >
                        Walk Mode
                    </button>
                    {navMode === 'walk' && (
                        <button 
                            onClick={() => {
                                const canvas = rendererRef.current?.domElement;
                                if (!canvas) return;
                                isPointerLocked
                                    ? fpsController.unlock()
                                    : fpsController.lock(canvas);
                            }}
                            className={`px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all ${isPointerLocked ? 'bg-orange-600 text-white' : 'bg-white/10 text-white border border-white/10'}`}
                        >
                            {isPointerLocked ? 'Unlock Mouse' : 'Lock Mouse'}
                        </button>
                    )}
                </div>

                {isRecalibrationMode && (
                    <div className="text-white bg-purple-600/90 px-4 py-2 rounded-lg font-mono text-[10px] border border-purple-400/50 shadow-2xl animate-pulse">
                        🎯 Tap on the floor to set new origin and recalibrate walls
                    </div>
                )}
                
                {mode3Active && (
                    <div className="text-white bg-emerald-600/90 px-4 py-2 rounded-lg font-mono text-[10px] border border-emerald-400/50 shadow-2xl">
                        🌍 World Labs Generation Mode Active — Upload video to create 3D World
                    </div>
                )}

                {anchorQualityWarning && (
                    <div className="text-yellow-300 bg-yellow-900/80 px-4 py-2 rounded-lg font-mono text-[10px] border border-yellow-500/50 shadow-2xl animate-pulse">
                        ⚠️ Move camera slowly around the wall for better tracking
                    </div>
                )}
                <div className="text-white bg-black/60 px-6 py-2 rounded-full font-bold backdrop-blur-lg border border-white/20 shadow-2xl uppercase tracking-tighter text-xs flex gap-2 items-center">
                    {activeSession ? <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> : <span className="w-2 h-2 rounded-full bg-gray-500"></span>}
                    {activeSession ? 'AR Session Live' : 'Debug Mode · Desktop View'}
                </div>
                
                {/* Anchor Confidence Indicators */}
                {wallMeshesRef.current.size > 0 && !isLineMode && (
                    <div className="flex gap-2 mt-2 bg-black/50 p-2 rounded-xl backdrop-blur-md">
                        <div className="flex items-center gap-1 text-[9px] text-white/80"><div className="w-2 h-2 rounded-full bg-green-500"></div> Resolved</div>
                        <div className="flex items-center gap-1 text-[9px] text-white/80"><div className="w-2 h-2 rounded-full bg-yellow-500"></div> Estimated</div>
                        <div className="flex items-center gap-1 text-[9px] text-white/80"><div className="w-2 h-2 rounded-full bg-red-500"></div> Failed</div>
                    </div>
                )}
            </div>

            {/* Bottom controls */}
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 z-20 w-full px-6 pointer-events-auto">
                {isConfirming ? (
                    <div className="flex gap-2 w-full max-w-sm animate-in slide-in-from-bottom-5 duration-300">
                        <button onClick={(e) => { e.stopPropagation(); cleanupDrawing(); setIsLineMode(true); }} className="flex-1 px-4 py-4 rounded-3xl bg-white/10 text-white font-black hover:bg-white/20 transition-all text-[11px] border border-white/10 uppercase">🔄 Redraw</button>
                        <button onClick={(e) => { e.stopPropagation(); confirmLineWall(); }} className="flex-[2] px-4 py-4 rounded-3xl bg-blue-600 text-white font-black shadow-lg transition-all text-[11px] border border-blue-400/30 uppercase active:scale-95">✅ Confirm</button>
                    </div>
                ) : isLineMode ? (
                    <div className="flex flex-col items-center gap-2 w-full">
                        <div className="bg-blue-600/90 text-white px-8 py-3 rounded-full text-[11px] font-black uppercase tracking-widest animate-pulse border border-white/20 shadow-2xl shadow-blue-500/40">✏️ Trace Wall on Floor</div>
                        <button onClick={(e) => { e.stopPropagation(); cleanupDrawing(); }} className="w-full max-w-xs px-4 py-4 rounded-3xl bg-white/10 text-white font-black hover:bg-white/20 transition-all text-[11px] border border-white/10 uppercase">Cancel</button>
                    </div>
                ) : mode3Active ? (
                    <div className="flex flex-col gap-2 w-full max-w-sm">
                        <div className="bg-black/80 border border-emerald-500/50 p-4 rounded-xl flex flex-col items-center gap-2 mb-2">
                            <span className="text-white text-xs font-bold text-center">World Labs Integration<br/><span className="text-[9px] text-white/50 font-normal">Generate 3D world from video</span></span>
                            <button onClick={(e) => { e.stopPropagation(); setDebugStatus('Mode 3: Processing Video Pipeline...'); }} className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg uppercase tracking-wide shadow-lg transition-colors">Upload Video</button>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setMode3Active(false); }} className="w-full px-4 py-3 rounded-2xl bg-white/10 text-white border border-white/20 text-xs uppercase font-bold hover:bg-white/20 transition-colors">Close Mode 3</button>
                    </div>
                ) : (
                    <>
                        <div className="flex gap-2 justify-center w-full max-w-sm">
                            <button onClick={(e) => { e.stopPropagation(); updateSelectedFrameColor('black'); }} className={`flex-1 px-3 py-3 rounded-2xl font-black transition-all shadow-2xl active:scale-95 text-[9px] uppercase tracking-widest ${frameColor === 'black' ? 'bg-black text-white ring-2 ring-blue-500 scale-105' : 'bg-white/10 text-white backdrop-blur-sm'}`}>Black</button>
                            <button onClick={(e) => { e.stopPropagation(); updateSelectedFrameColor('silver'); }} className={`flex-1 px-3 py-3 rounded-2xl font-black transition-all shadow-2xl active:scale-95 text-[9px] uppercase tracking-widest ${frameColor === 'silver' ? 'bg-slate-300 text-black ring-2 ring-blue-500 scale-105' : 'bg-white/10 text-white backdrop-blur-sm'}`}>Silver</button>
                            <button onClick={(e) => { e.stopPropagation(); setIsRecalibrationMode(!isRecalibrationMode); }} className={`flex-1 px-3 py-3 rounded-2xl font-black transition-all shadow-2xl active:scale-95 text-[9px] uppercase tracking-widest ${isRecalibrationMode ? 'bg-purple-600 text-white' : 'bg-white/10 text-white'}`}>Target Origin</button>
                        </div>
                        <div className="flex gap-2 w-full max-w-sm">
                            <button onClick={(e) => { e.stopPropagation(); setIsLineMode(true); }} className="flex-[2] px-4 py-4 rounded-3xl bg-blue-600 text-white font-black shadow-2xl active:scale-95 transition-all text-[10px] uppercase tracking-widest border border-blue-400/30">✏️ Draw Wall</button>
                            <button onClick={(e) => { e.stopPropagation(); saveAllToSupabase(); }} className="flex-1 px-2 py-4 rounded-3xl bg-gradient-to-br from-orange-400 to-rose-500 text-white font-black shadow-2xl active:scale-95 transition-all text-[10px] uppercase tracking-widest border border-white/20">Save</button>
                            <button onClick={(e) => { e.stopPropagation(); setMode3Active(true); }} className="flex-1 px-2 py-4 rounded-3xl bg-emerald-600 text-white font-black shadow-2xl active:scale-95 transition-all text-[10px] uppercase tracking-widest border border-white/20">Mode 3</button>
                        </div>
                    </>
                )}
            </div>

            {/* Panel popup */}
            {selectedPanel && (
                <div className="absolute z-50 pointer-events-auto" style={{ left: popupPos.x, top: popupPos.y - 100, transform: 'translateX(-50%)' }}>
                    <div className="bg-white/95 backdrop-blur-xl border border-white/20 rounded-2xl p-4 shadow-2xl flex flex-col gap-3 min-w-[140px]">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-black uppercase text-gray-500 font-mono tracking-widest">Panel {selectedPanel.index + 1}</span>
                            <button onClick={(e) => { e.stopPropagation(); setSelectedPanel(null); if (selectedPartitionRef.current instanceof ARPartition) selectedPartitionRef.current.clearHighlight(); }} className="text-gray-400 hover:text-black p-1">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); if (selectedPartitionRef.current instanceof ARPartition) { if (selectedPanel.isDoor) selectedPartitionRef.current.removeDoor(selectedPanel.index); else selectedPartitionRef.current.addDoor(selectedPanel.index); setSelectedPanel(null); selectedPartitionRef.current.clearHighlight(); } }} className={`w-full py-3 rounded-xl font-black text-[12px] uppercase tracking-wide transition-all ${selectedPanel.isDoor ? 'bg-rose-500 text-white shadow-rose-200 shadow-lg' : 'bg-indigo-600 text-white shadow-indigo-200 shadow-lg'} active:scale-95`}>
                            {selectedPanel.isDoor ? '🚪 Remove Door' : '🚪 Add Door'}
                        </button>
                        {selectedPanel.isDoor && (
                            <button onClick={(e) => { e.stopPropagation(); if (selectedPartitionRef.current instanceof ARPartition) { selectedPartitionRef.current.toggleDoorSwing(selectedPanel.index); setSelectedPanel(null); selectedPartitionRef.current.clearHighlight(); } }} className="w-full py-3 rounded-xl font-black text-[12px] uppercase tracking-wide transition-all bg-emerald-600 text-white shadow-emerald-200 shadow-lg active:scale-95">🔄 Open / Close</button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
