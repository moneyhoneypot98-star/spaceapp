import { useEffect, useMemo, useRef } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { createMemory3DWebGLRenderer, type Memory3DWebGLRenderer } from "./memory-graph-webgl.js";
import {
  DEFAULT_MEMORY_CAMERA, MEMORY_3D_CANVAS_EDGE_LIMIT, MEMORY_3D_CANVAS_NODE_LIMIT,
  createMemory3DPicker, memory3DVolumeRatio, projectMemoryPoint, selectMemory3DLabels, type MemoryCamera3D, type MemoryPoint3D
} from "./memory-3d.js";

/** Fallback keeps the overview caps: sources and the focused node stay, the rest is truncated by id. */
export const cappedFallbackGraph = (nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], selectedNodeId: string | null) => {
  if (nodes.length <= MEMORY_3D_CANVAS_NODE_LIMIT && edges.length <= MEMORY_3D_CANVAS_EDGE_LIMIT) return { nodes, edges };
  const focus = selectedNodeId ? nodes.find(node => node.id === selectedNodeId) : undefined;
  const kept = new Map<string, MemoryGraphNode>();
  for (const node of [...(focus ? [focus] : []), ...nodes.filter(node => node.type === "SOURCE"), ...nodes.filter(node => node !== focus && node.type !== "SOURCE").sort((a, b) => a.id.localeCompare(b.id))]) {
    if (kept.size >= MEMORY_3D_CANVAS_NODE_LIMIT) break;
    kept.set(node.id, node);
  }
  const keptEdges = edges.filter(edge => kept.has(edge.source) && kept.has(edge.target))
    .sort((a, b) => Number(b.type === "CONTAINS" || b.type === "DERIVED_FROM") - Number(a.type === "CONTAINS" || a.type === "DERIVED_FROM"))
    .slice(0, MEMORY_3D_CANVAS_EDGE_LIMIT);
  return { nodes: [...kept.values()], edges: keptEdges };
};

export function MemoryGraph3D({ nodes, edges, positions, coordinates, packedCoordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  packedCoordinates: { ids: string[]; coords: Float32Array } | null;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, packedCoordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, packedCoordinates, showTitles, selectedNodeId, onSelectNode };
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const glCanvas = glCanvasRef.current;
    let renderer: Memory3DWebGLRenderer | null = null;
    let usingWebGL = false;
    const attachWebGL = () => {
      if (!glCanvas) return false;
      const gl = glCanvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: true, depth: true });
      const candidate = gl ? createMemory3DWebGLRenderer(glCanvas, gl) : null;
      if (!candidate) return false;
      renderer?.destroy();
      renderer = candidate;
      usingWebGL = true;
      uploadKey = "";
      return true;
    };
    let frame = 0, width = 1, height = 1, dpr = 1;
    let hover: string | null = null;
    let pickerDirty = true, uploadKey = "", focusKey: string | null = null;
    let extentKey: unknown = null, extentValue = 60;
    let orderedKey: unknown = null, orderedNodes: MemoryGraphNode[] = [];
    let fallbackKey = "", fallbackNodes: MemoryGraphNode[] = [], fallbackEdges: MemoryGraphEdge[] = [];
    const picker = createMemory3DPicker();
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;
    // The extent only changes with the coordinates, not with the camera, so cache it per object.
    const extent = () => {
      if (extentKey !== current.current.coordinates) {
        extentKey = current.current.coordinates;
        extentValue = Math.max(60, ...[...current.current.coordinates.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      }
      return extentValue;
    };
    const orderedFor = () => {
      const packed = current.current.packedCoordinates;
      if (packed !== orderedKey) {
        orderedKey = packed;
        const byId = new Map(current.current.nodes.map(node => [node.id, node]));
        orderedNodes = packed ? packed.ids.map(id => byId.get(id)).filter(node => node !== undefined) : current.current.nodes;
      }
      return orderedNodes;
    };
    const fallbackFor = () => {
      const { nodes, edges, selectedNodeId } = current.current;
      const key = `${nodes.length}|${edges.length}|${selectedNodeId}`;
      if (key !== fallbackKey) {
        fallbackKey = key;
        const capped = cappedFallbackGraph(nodes, edges, selectedNodeId);
        fallbackNodes = capped.nodes; fallbackEdges = capped.edges;
      }
      return { nodes: fallbackNodes, edges: fallbackEdges };
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    const invalidate = () => { pickerDirty = true; schedule(); };
    redrawRef.current = invalidate;
    const render = () => {
      frame = 0;
      const { edges, positions, coordinates, packedCoordinates, showTitles, selectedNodeId } = current.current;
      context.clearRect(0, 0, width, height);
      const spread = extent();
      const scale = Math.min(width, height) * 0.4 / spread;
      const focus = hover ?? selectedNodeId;
      const projected = new Map<string, { x: number; y: number; z: number; perspective: number }>();
      let labelNodes = orderedFor();
      if (usingWebGL && renderer) {
        const key = `${orderedNodes.length}|${current.current.nodes.length}|${edges.length}|${positions.size}`;
        if (key !== uploadKey) {
          uploadKey = key;
          const packedWidth = Math.max(1, Math.ceil(Math.sqrt(orderedNodes.length)));
          renderer.upload(orderedNodes, edges, positions, packedCoordinates?.coords ?? new Float32Array(0), packedWidth, Math.max(1, Math.ceil(orderedNodes.length / packedWidth)));
          focusKey = null;
          pickerDirty = true;
        }
        if (focus !== focusKey) { focusKey = focus; renderer.updateFocus(focus); }
        renderer.render(cameraRef.current, width, height, dpr, scale, spread, focus);
      } else {
        const drawn = fallbackFor();
        labelNodes = drawn.nodes;
        for (const node of drawn.nodes) {
          const p = coordinates.get(node.id);
          if (p) projected.set(node.id, projectMemoryPoint(p, cameraRef.current, scale, width, height));
        }
        context.lineWidth = 0.55;
        for (const edge of drawn.edges) {
          const a = projected.get(edge.source), b = projected.get(edge.target);
          if (!a || !b) continue;
          const incident = edge.source === focus || edge.target === focus;
          context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
          context.lineWidth = incident ? 1.15 : 0.55;
          context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        }
        const neighbors = new Set<string>();
        if (focus) for (const edge of edges) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
        const ordered = drawn.nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
        for (const node of ordered) {
          const p = projected.get(node.id)!;
          const highlighted = node.id === focus;
          const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
          const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(cameraRef.current.zoom)) * (highlighted ? 1.5 : 1);
          context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
          context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
          if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
          context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
        }
        context.globalAlpha = 1;
      }
      if (pickerDirty) {
        picker.update(labelNodes, coordinates, cameraRef.current, scale, width, height);
        pickerDirty = false;
      }
      if (showTitles) {
        const labeled = [...labelNodes].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
        context.font = "11px system-ui, sans-serif";
        const labels = selectMemory3DLabels({
          nodes: labeled, focus, zoom: cameraRef.current.zoom, width, height,
          project: id => {
            const existing = projected.get(id);
            if (existing) return existing;
            const p = coordinates.get(id);
            return p ? projectMemoryPoint(p, cameraRef.current, scale, width, height) : undefined;
          },
          measure: text => context.measureText(text).width
        });
        for (const label of labels) {
          context.fillStyle = "#09111bea"; context.fillRect(label.x - 3, label.y - 11, label.w + 6, 16);
          context.fillStyle = isMemoryCoreLabel(label.label) ? "#fff0b0" : "#c6dfed"; context.fillText(label.label, label.x, label.y + 1);
        }
      }
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      if (glCanvas) { glCanvas.width = canvas.width; glCanvas.height = canvas.height; }
      invalidate();
    };
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const hoverAt = (x: number, y: number) => {
      const started = performance.now();
      if (pickerDirty) {
        picker.update(usingWebGL ? orderedFor() : fallbackFor().nodes, current.current.coordinates, cameraRef.current, Math.min(width, height) * 0.4 / extent(), width, height);
        pickerDirty = false;
      }
      const id = picker.pick(x, y);
      canvas.dataset.pickMs = (performance.now() - started).toFixed(3);
      return id;
    };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null;
    };
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p);
        invalidate();
      } else { hover = hoverAt(p.x, p.y); canvas.style.cursor = hover ? "pointer" : "grab"; schedule(); }
    };
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const id = hoverAt(p.x, p.y); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); invalidate(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; invalidate();
      } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
    };
    const lost = (event: Event) => { event.preventDefault(); usingWebGL = false; canvas.dataset.renderer = "canvas2d"; schedule(); };
    const restored = () => { if (attachWebGL()) { canvas.dataset.renderer = "webgl2"; schedule(); } };
    attachWebGL();
    canvas.dataset.renderer = usingWebGL ? "webgl2" : "canvas2d";
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    glCanvas?.addEventListener("webglcontextlost", lost);
    glCanvas?.addEventListener("webglcontextrestored", restored);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {};
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
      glCanvas?.removeEventListener("webglcontextlost", lost);
      glCanvas?.removeEventListener("webglcontextrestored", restored);
      renderer?.destroy(); renderer = null; usingWebGL = false;
    };
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, packedCoordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={glCanvasRef} className="memory-3d-webgl" aria-hidden="true" /><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
