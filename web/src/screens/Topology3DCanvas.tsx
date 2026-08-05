/**
 * web/src/screens/Topology3DCanvas.tsx — 3D Three.js Topology Visualization
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  Tone,
  TopologyGraph,
  TopologyGraphEdge,
} from '@hpe/shared';

interface Topology3DCanvasProps {
  graph: TopologyGraph;
  onSelectNode?: (nodeId: string) => void;
}

interface Node3D {
  id: string;
  name: string;
  type: 'site' | 'device' | 'ghost';
  tone: Tone;
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  siteId?: string;
}

interface Edge3D {
  edge: TopologyGraphEdge;
  line: THREE.Line;
}

/** Fallback hex when CSS vars unavailable (SSR / canvas boot). */
const TONE_FALLBACK: Record<string, number> = {
  success: 0x3dd68c,
  warning: 0xf0c34a,
  danger: 0xff6f7a,
  neutral: 0x7f8ea8,
  accent: 0x4a90ff,
  info: 0x38bdf8,
};

const ND_CANVAS_FALLBACK = 0x070b13;
const ND_EDGE_FALLBACK = 0x223350;
const ND_COOL_FALLBACK = 0x2dd4bf;

function cssHex(varName: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    if (hex.length === 3) {
      const expanded = hex
        .split('')
        .map((c) => c + c)
        .join('');
      const n = Number.parseInt(expanded, 16);
      return Number.isFinite(n) ? n : fallback;
    }
    if (hex.length >= 6) {
      const n = Number.parseInt(hex.slice(0, 6), 16);
      return Number.isFinite(n) ? n : fallback;
    }
  }
  const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    return ((Number(m[1]) & 255) << 16) | ((Number(m[2]) & 255) << 8) | (Number(m[3]) & 255);
  }
  return fallback;
}

function ndPalette() {
  return {
    tones: {
      success: cssHex('--nd-success', TONE_FALLBACK.success),
      warning: cssHex('--nd-warning', TONE_FALLBACK.warning),
      danger: cssHex('--nd-danger', TONE_FALLBACK.danger),
      neutral: cssHex('--nd-text-secondary', TONE_FALLBACK.neutral),
      accent: cssHex('--nd-accent', TONE_FALLBACK.accent),
      info: cssHex('--nd-info', TONE_FALLBACK.info),
    } as Record<string, number>,
    canvas: cssHex('--nd-bg-canvas', ND_CANVAS_FALLBACK),
    edge: cssHex('--nd-border-default', ND_EDGE_FALLBACK),
    cool: cssHex('--nd-accent', ND_COOL_FALLBACK),
    siteInk: cssHex('--nd-text-primary', 0xeef2fa),
    deviceInk: cssHex('--nd-text-secondary', 0xa3b3cd),
  };
}

function toCssHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function createTextSprite(
  text: string,
  isSite: boolean,
  palette: ReturnType<typeof ndPalette>,
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = isSite
      ? 'Bold 30px Inter, -apple-system, system-ui, sans-serif'
      : '24px Inter, -apple-system, system-ui, sans-serif';
    /* Glass chips — raised surface from live palette (no slate). */
    const chip = isSite ? palette.canvas : ((palette.canvas >> 1) + (palette.edge >> 2));
    const cr = (chip >> 16) & 255;
    const cg = (chip >> 8) & 255;
    const cb = chip & 255;
    ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${isSite ? 0.94 : 0.92})`;
    ctx.strokeStyle = isSite
      ? toCssHex(palette.tones.accent)
      : `rgba(${(palette.edge >> 16) & 255}, ${(palette.edge >> 8) & 255}, ${palette.edge & 255}, 0.28)`;
    ctx.lineWidth = 3;

    const x = 16;
    const y = 16;
    const w = canvas.width - 32;
    const h = canvas.height - 32;
    const r = 16;

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSite ? toCssHex(palette.siteInk) : toCssHex(palette.deviceInk);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = text.length > 24 ? `${text.slice(0, 22)}…` : text;
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(isSite ? 18 : 12, isSite ? 4.5 : 3, 1);
  return sprite;
}

export const Topology3DCanvas: React.FC<Topology3DCanvasProps> = ({ graph, onSelectNode }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<{ id: string; name: string; type: string } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    const palette = ndPalette();
    const TONE_COLORS = palette.tones;
    const ND_EDGE = palette.edge;
    const ND_COOL = palette.cool;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(palette.canvas);

    // Camera setup
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(0, 40, 100);

    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lights — copper-warm key + cool fill
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xdce9ff, 1.15);
    dirLight1.position.set(50, 100, 50);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(ND_COOL, 0.4);
    dirLight2.position.set(-50, -50, -50);
    scene.add(dirLight2);

    // Build 3D Nodes & Edges from graph data
    const nodes3D: Node3D[] = [];
    const nodeMap = new Map<string, Node3D>();

    // Geometries & Materials cache
    const siteGeometry = new THREE.SphereGeometry(4, 32, 32);
    const deviceGeometry = new THREE.DodecahedronGeometry(2.2);
    const ghostGeometry = new THREE.OctahedronGeometry(1.8);

    // Initial position layout algorithm (3D force/cluster positioning)
    const numSites = Math.max(graph.sites.length, 1);
    const siteRadius = Math.max(30, numSites * 12);

    graph.sites.forEach((site, idx) => {
      const angle = (idx / numSites) * Math.PI * 2;
      const sitePos = new THREE.Vector3(
        Math.cos(angle) * siteRadius,
        (Math.random() - 0.5) * 10,
        Math.sin(angle) * siteRadius
      );

      const color = TONE_COLORS[site.tone] ?? TONE_COLORS.neutral;
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.3,
        metalness: 0.2,
        emissive: color,
        emissiveIntensity: 0.2,
      });
      const mesh = new THREE.Mesh(siteGeometry, mat);
      mesh.position.copy(sitePos);
      mesh.userData = { id: site.siteId, name: site.name, type: 'site' };

      const siteSprite = createTextSprite(site.name, true, palette);
      siteSprite.position.set(0, 6, 0);
      mesh.add(siteSprite);

      scene.add(mesh);

      const node3D: Node3D = {
        id: site.siteId,
        name: site.name,
        type: 'site',
        tone: site.tone,
        mesh,
        position: sitePos.clone(),
        velocity: new THREE.Vector3(),
      };
      nodes3D.push(node3D);
      nodeMap.set(site.siteId, node3D);

      // Devices in this site clustered around site sphere
      const siteDevices = graph.nodes.filter(
        (n) => !n.ghost && n.siteId === site.siteId
      );
      const devCount = siteDevices.length;
      siteDevices.forEach((devNode, dIdx) => {
        const subAngle = (dIdx / Math.max(devCount, 1)) * Math.PI * 2;
        const subRadius = 12 + Math.random() * 4;
        const devPos = new THREE.Vector3(
          sitePos.x + Math.cos(subAngle) * subRadius,
          sitePos.y + (Math.random() - 0.5) * 10,
          sitePos.z + Math.sin(subAngle) * subRadius
        );

        const devColor = TONE_COLORS[devNode.tone] ?? TONE_COLORS.neutral;
        const devMat = new THREE.MeshStandardMaterial({
          color: devColor,
          roughness: 0.4,
          metalness: 0.5,
          emissive: devColor,
          emissiveIntensity: 0.15,
        });
        const devMesh = new THREE.Mesh(deviceGeometry, devMat);
        devMesh.position.copy(devPos);
        devMesh.userData = { id: devNode.id, name: devNode.name, type: 'device' };

        const devSprite = createTextSprite(devNode.name, false, palette);
        devSprite.position.set(0, 3.5, 0);
        devMesh.add(devSprite);

        scene.add(devMesh);

        // Subtly connect device to its site sphere
        const clusterLineMat = new THREE.LineBasicMaterial({
          color: ND_EDGE,
          transparent: true,
          opacity: 0.35,
        });
        const clusterGeom = new THREE.BufferGeometry().setFromPoints([sitePos, devPos]);
        scene.add(new THREE.Line(clusterGeom, clusterLineMat));

        const dev3D: Node3D = {
          id: devNode.id,
          name: devNode.name,
          type: 'device',
          tone: devNode.tone,
          mesh: devMesh,
          position: devPos.clone(),
          velocity: new THREE.Vector3(),
          siteId: site.siteId,
        };
        nodes3D.push(dev3D);
        nodeMap.set(devNode.id, dev3D);
      });
    });

    // Unfiled ghosts placement
    const unfiledNodes = graph.nodes.filter(
      (n) => n.siteId === null || !graph.sites.some((s) => s.siteId === n.siteId)
    );

    if (unfiledNodes.length > 0) {
      const ghostCenter = new THREE.Vector3(0, -35, 0);
      unfiledNodes.forEach((gNode, gIdx) => {
        const angle = (gIdx / unfiledNodes.length) * Math.PI * 2;
        const gRadius = 15;
        const gPos = new THREE.Vector3(
          ghostCenter.x + Math.cos(angle) * gRadius,
          ghostCenter.y + (Math.random() - 0.5) * 5,
          ghostCenter.z + Math.sin(angle) * gRadius
        );

        const mat = new THREE.MeshStandardMaterial({
          color: TONE_COLORS.neutral,
          roughness: 0.8,
          transparent: true,
          opacity: 0.7,
        });
        const mesh = new THREE.Mesh(ghostGeometry, mat);
        mesh.position.copy(gPos);
        mesh.userData = { id: gNode.id, name: gNode.name, type: gNode.ghost ? 'ghost' : 'device' };

        const gSprite = createTextSprite(gNode.name, false, palette);
        gSprite.position.set(0, 3, 0);
        mesh.add(gSprite);

        scene.add(mesh);

        const g3D: Node3D = {
          id: gNode.id,
          name: gNode.name,
          type: gNode.ghost ? 'ghost' : 'device',
          tone: 'neutral',
          mesh,
          position: gPos.clone(),
          velocity: new THREE.Vector3(),
        };
        nodes3D.push(g3D);
        nodeMap.set(gNode.id, g3D);
      });
    }

    // Create 3D Edges
    const edges3D: Edge3D[] = [];
    const lineMaterial = new THREE.LineBasicMaterial({
      color: ND_EDGE,
      transparent: true,
      opacity: 0.6,
      linewidth: 1,
    });

    graph.edges.forEach((edge) => {
      const sourceNode = nodeMap.get(edge.from);
      const targetNode = nodeMap.get(edge.to);
      if (!sourceNode || !targetNode) return;

      const points = [sourceNode.mesh.position, targetNode.mesh.position];
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geom, lineMaterial.clone());
      scene.add(line);
      edges3D.push({ edge, line });
    });

    // Raycasting / Selection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(
        nodes3D.map((n) => n.mesh)
      );

      if (intersects.length > 0) {
        const hitData = intersects[0].object.userData;
        setHoveredNode({
          id: hitData.id,
          name: hitData.name,
          type: hitData.type,
        });
        container.style.cursor = 'pointer';
      } else {
        setHoveredNode(null);
        container.style.cursor = 'default';
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(
        nodes3D.map((n) => n.mesh)
      );

      if (intersects.length > 0) {
        const hitData = intersects[0].object.userData;
        if (onSelectNode) onSelectNode(hitData.id);
      }
    };

    const domElem = renderer.domElement;
    domElem.addEventListener('pointermove', handlePointerMove);
    domElem.addEventListener('click', handlePointerDown);

    // Animation Loop
    let animationFrameId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();

      // Gentle floating animation for nodes
      nodes3D.forEach((n, idx) => {
        n.mesh.position.y = n.position.y + Math.sin(elapsedTime * 1.5 + idx) * 0.4;
      });

      // Update edge geometries
      edges3D.forEach(({ edge, line }) => {
        const sourceNode = nodeMap.get(edge.from);
        const targetNode = nodeMap.get(edge.to);
        if (sourceNode && targetNode) {
          const positions = line.geometry.attributes.position as THREE.BufferAttribute;
          positions.setXYZ(0, sourceNode.mesh.position.x, sourceNode.mesh.position.y, sourceNode.mesh.position.z);
          positions.setXYZ(1, targetNode.mesh.position.x, targetNode.mesh.position.y, targetNode.mesh.position.z);
          positions.needsUpdate = true;
        }
      });

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    // Resize handling
    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      domElem.removeEventListener('pointermove', handlePointerMove);
      domElem.removeEventListener('click', handlePointerDown);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [graph, onSelectNode]);

  return (
    <div className="nt-topo3d nt-topo-host nt-topo3d-shell nt-panel-glass">
      <div ref={containerRef} className="nt-topo3d__canvas" />

      {/* Hover Info Tooltip */}
      {hoveredNode && (
        <div
          className="nt-topo3d__glass nt-topo3d__glass--tl"
        >
          <div className="nt-topo3d__title">{hoveredNode.name}</div>
          <div className="nt-topo3d__meta">
            {hoveredNode.type} {hoveredNode.id !== hoveredNode.name ? `· ${hoveredNode.id}` : ''}
          </div>
        </div>
      )}

      {/* Legend & Controls overlay */}
      <div
        className="nt-topo3d__glass nt-topo3d__glass--br"
      >
        <div className="nt-topo3d__stat">3D Controls</div>
        <div>Rotate: Left Click + Drag</div>
        <div>Pan: Right Click + Drag</div>
        <div>Zoom: Scroll Wheel</div>
      </div>
    </div>
  );
};
