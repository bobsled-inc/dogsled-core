'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';
import { GRAPH_LAYERS, graphLayerTitle, type GraphEdge, type GraphNode } from '@/lib/model-graph';

const DARK_THEME_VARIABLES = {
  fontFamily: 'var(--font-mono)',
  lineColor: '#4f46e5',
  primaryColor: '#111122',
  primaryTextColor: '#fafafa',
  secondaryColor: '#1f2937',
  tertiaryColor: '#1e1e32',
  clusterBkg: '#111122',
  clusterBorder: '#2a2a3e',
} as const;

const LIGHT_THEME_VARIABLES = {
  fontFamily: 'var(--font-mono)',
  lineColor: '#6366f1',
  primaryColor: '#ffffff',
  primaryTextColor: '#0a0a0a',
  secondaryColor: '#f4f4f8',
  tertiaryColor: '#f4f4f8',
  clusterBkg: '#ffffff',
  clusterBorder: '#e2e2ef',
} as const;

let mermaidInitialized = false;

function initializeMermaid() {
  if (mermaidInitialized) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
  });
  mermaidInitialized = true;
}

function getMermaidThemeVariables(resolvedTheme: string | undefined) {
  return resolvedTheme === 'light' ? LIGHT_THEME_VARIABLES : DARK_THEME_VARIABLES;
}

// Map each layer to a mermaid `classDef` name. Use camelCase (no hyphens) for
// cross-version mermaid compatibility; the generated SVG will tag `g.node`
// with this class so globals.css can apply the layer fill.
function classDefForLayer(layer: GraphNode['layer']): string {
  const cap = layer
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `dagLayer${cap}`;
}

function buildDefinition(
  nodes: GraphNode[],
  edges: GraphEdge[]
): { definition: string; mermaidIdToNodeId: Map<string, string> } {
  const mermaidIds = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const mermaidIdToNodeId = new Map<string, string>();
  for (const [nodeId, mermaidId] of mermaidIds.entries()) {
    mermaidIdToNodeId.set(mermaidId, nodeId);
  }

  const byLayer = new Map(
    GRAPH_LAYERS.map((layer) => [layer, nodes.filter((node) => node.layer === layer)] as const)
  );

  const lines = ['graph LR'];

  // Per-layer classDefs: mermaid requires at least one style property, so we
  // include a placeholder stroke-width and rely on globals.css for the actual
  // theme-aware fill via .dagLayer<Layer> selectors.
  for (const layer of GRAPH_LAYERS) {
    const layerNodes = byLayer.get(layer) ?? [];
    if (layerNodes.length === 0) {
      continue;
    }
    lines.push(`classDef ${classDefForLayer(layer)} stroke-width:1.5px;`);
  }

  for (const layer of GRAPH_LAYERS) {
    const layerNodes = byLayer.get(layer) ?? [];
    if (layerNodes.length === 0) {
      continue;
    }

    lines.push(`subgraph layer_${layer}["${graphLayerTitle(layer)}"]`);
    for (const node of layerNodes) {
      const mermaidId = mermaidIds.get(node.id);
      if (!mermaidId) {
        continue;
      }
      lines.push(`  ${mermaidId}["${node.label}"]:::${classDefForLayer(layer)}`);
    }
    lines.push('end');
  }

  for (const edge of edges) {
    const fromId = mermaidIds.get(edge.from);
    const toId = mermaidIds.get(edge.to);
    if (!fromId || !toId) {
      continue;
    }
    lines.push(`  ${fromId} --> ${toId}`);
  }

  return { definition: lines.join('\n'), mermaidIdToNodeId };
}

interface PanZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

const DEFAULT_PAN_ZOOM: PanZoomState = { scale: 1, translateX: 0, translateY: 0 };
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

// BFS the node's full lineage chain (ancestors + descendants + self) so we
// can dim everything outside that chain when the user selects a node.
function computeLineageChain(
  rootId: string,
  edges: GraphEdge[]
): { nodeIds: Set<string>; edgeKeys: Set<string> } {
  const nodeIds = new Set<string>([rootId]);
  const edgeKeys = new Set<string>();
  const upstreamByTarget = new Map<string, string[]>();
  const downstreamBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const upstream = upstreamByTarget.get(edge.to) ?? [];
    upstream.push(edge.from);
    upstreamByTarget.set(edge.to, upstream);
    const downstream = downstreamBySource.get(edge.from) ?? [];
    downstream.push(edge.to);
    downstreamBySource.set(edge.from, downstream);
  }
  const edgeKey = (from: string, to: string) => `${from}::${to}`;

  // Walk upstream
  const upQueue = [rootId];
  const upSeen = new Set<string>([rootId]);
  while (upQueue.length > 0) {
    const cur = upQueue.shift();
    if (cur === undefined) break;
    for (const parent of upstreamByTarget.get(cur) ?? []) {
      edgeKeys.add(edgeKey(parent, cur));
      if (!upSeen.has(parent)) {
        upSeen.add(parent);
        nodeIds.add(parent);
        upQueue.push(parent);
      }
    }
  }

  // Walk downstream
  const downQueue = [rootId];
  const downSeen = new Set<string>([rootId]);
  while (downQueue.length > 0) {
    const cur = downQueue.shift();
    if (cur === undefined) break;
    for (const child of downstreamBySource.get(cur) ?? []) {
      edgeKeys.add(edgeKey(cur, child));
      if (!downSeen.has(child)) {
        downSeen.add(child);
        nodeIds.add(child);
        downQueue.push(child);
      }
    }
  }

  return { nodeIds, edgeKeys };
}

export interface ModelDagProps {
  edges: GraphEdge[];
  nodes: GraphNode[];
  fallback?: ReactNode;
  onNodeClick?: (node: GraphNode) => void;
  highlightedNodeId?: string | null;
  /**
   * Node ids currently in the "running" phase of a pipeline. Each id receives
   * the `dag-node-running` class for a pulse animation. The set is replaced on
   * every render — pass a stable identity (e.g. memoized) to avoid thrashing.
   */
  runningNodeIds?: ReadonlySet<string>;
  /**
   * Node ids that have just finished a pipeline step. Each receives the
   * `dag-node-complete` class for a brief flash animation. Compose freely
   * with `runningNodeIds` (they apply to disjoint sets in practice).
   */
  completedNodeIds?: ReadonlySet<string>;
  /**
   * Container height. Number is interpreted as px; string is passed through.
   * Default 520. Pass `'100%'` to fill the parent (the parent must establish
   * a height or the container collapses).
   */
  height?: number | string;
}

export function ModelDag({
  edges,
  nodes,
  fallback,
  onNodeClick,
  highlightedNodeId,
  runningNodeIds,
  completedNodeIds,
  height = 520,
}: ModelDagProps) {
  const id = useId().replaceAll(':', '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [mapping, setMapping] = useState<Map<string, string>>(() => new Map());
  const [panZoom, setPanZoom] = useState<PanZoomState>(DEFAULT_PAN_ZOOM);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{
    originX: number;
    originY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const isInteractive = Boolean(onNodeClick);
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Track the (nodes, edges) fingerprint we've already auto-fit so user pan/zoom
  // isn't reset on every theme change or unrelated re-render.
  const fitFingerprintRef = useRef<string | null>(null);
  const graphFingerprint = useMemo(
    () =>
      [
        nodes.map((n) => n.id).join('|'),
        edges
          .map((e) => `${e.from}->${e.to}`)
          .sort()
          .join('|'),
      ].join('::'),
    [nodes, edges]
  );

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      try {
        initializeMermaid();
        mermaid.mermaidAPI.updateSiteConfig({
          themeVariables: getMermaidThemeVariables(resolvedTheme),
        });
        const { definition, mermaidIdToNodeId } = buildDefinition(nodes, edges);
        const rendered = await mermaid.render(`model-dag-${id}`, definition);
        if (!cancelled) {
          setSvg(rendered.svg);
          setMapping(mermaidIdToNodeId);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }

    void renderChart();
    return () => {
      cancelled = true;
    };
  }, [edges, id, nodes, resolvedTheme]);

  // Imperative auto-fit: scale and center the SVG to fill its container.
  const fitToView = useCallback(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return false;
    const svgEl = inner.querySelector<SVGSVGElement>('svg');
    if (!svgEl) return false;

    // The SVG already auto-fits its content from user-space to pixel-space
    // via `width="100%"` + viewBox. Our transform-scale layers ON TOP of
    // that mapping, so what we actually want to fit is the SVG's natural
    // (un-transformed) rendered size, not the bounding-rect pixel size
    // — which gets multiplied by the current panZoom.scale and would feed
    // scaled values into the fit calculation when the user clicks Reset
    // after a manual zoom.
    //
    // `getComputedStyle` returns the CSS-resolved size *before* CSS
    // transforms are applied, which is exactly the natural-rendered SVG
    // size we want regardless of the current zoom.
    const svgStyles = window.getComputedStyle(svgEl);
    const renderedW = parseFloat(svgStyles.width);
    const renderedH = parseFloat(svgStyles.height);
    if (!Number.isFinite(renderedW) || !Number.isFinite(renderedH)) return false;
    if (!renderedW || !renderedH) return false;

    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    if (!containerW || !containerH) return false;

    // Compute scale that fits the SVG's rendered size (with a 5% safety
    // margin) into the container. The SVG natively fills the inner div's
    // width, so for typical aspect ratios `fitScale` is close to or above
    // 1 — letting the DAG fill the container instead of sitting at a tiny
    // 40% of it on full-page layouts.
    const padding = 32;
    const fitScale =
      Math.min(containerW / (renderedW + padding), containerH / (renderedH + padding)) * 0.95;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale));
    // Center the rendered (padded) box in the container.
    const translateX = (containerW - (renderedW + padding) * scale) / 2;
    const translateY = (containerH - (renderedH + padding) * scale) / 2;

    setPanZoom({ scale, translateX, translateY });
    return true;
  }, []);

  // Auto-fit on first render (and when the graph shape changes). User-driven
  // pan/zoom, theme switches, and highlight changes must NOT reset the view —
  // we guard with a fingerprint of (nodes, edges) ids.
  useEffect(() => {
    if (!svg) return;
    if (fitFingerprintRef.current === graphFingerprint) return;
    if (fitToView()) {
      fitFingerprintRef.current = graphFingerprint;
    }
  }, [svg, graphFingerprint, fitToView]);

  // Pre-compute the lineage chain (ancestors + self + descendants) for the
  // currently selected node so we can dim everything else.
  const chain = useMemo(() => {
    if (!highlightedNodeId) {
      return null;
    }
    return computeLineageChain(highlightedNodeId, edges);
  }, [highlightedNodeId, edges]);

  // Resolve a SVG `g.node` element to its source GraphNode by mining the
  // mermaid-generated id. Used by both the a11y-attribute walk and the
  // delegated click/keydown handler.
  const nodeFromElement = useCallback(
    (el: Element | null | undefined): GraphNode | null => {
      if (!el) return null;
      // Mermaid emits ids like `model-dag-<reactId>-flowchart-n0-<counter>`.
      // The trailing `-n<digits>-<digits>` segment is what we set in the
      // definition (n0/n1/...). Anchor to that suffix so we don't accidentally
      // match `n` characters that appear earlier in the React id.
      const match = el.id.match(/-(n\d+)-\d+$/);
      if (!match || !match[1]) return null;
      const nodeId = mapping.get(match[1]);
      if (!nodeId) return null;
      return nodesById.get(nodeId) ?? null;
    },
    [mapping, nodesById]
  );

  // A11y attribute walk: set cursor / tabindex / role / aria-label on each
  // node element. Runs once per (svg, mapping, isInteractive, nodesById)
  // change. The actual click/keydown dispatch is handled by a delegated
  // listener at the container level (see effect below) — keeping the
  // dispatch off per-node listeners means a flaky DOM moment during the
  // attribute walk can't silently disable clicks.
  useEffect(() => {
    if (!svg) return;
    const inner = innerRef.current;
    if (!inner) return;
    const nodeEls = inner.querySelectorAll<SVGGElement>('g.node');
    const touched: SVGGElement[] = [];
    nodeEls.forEach((el) => {
      const node = nodeFromElement(el);
      if (!node) return;
      if (isInteractive) {
        el.style.cursor = 'pointer';
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Inspect ${node.label}`);
      } else {
        el.style.cursor = '';
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
      }
      touched.push(el);
    });

    return () => {
      touched.forEach((el) => {
        el.style.cursor = '';
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        el.removeAttribute('aria-pressed');
      });
    };
    // `nodeFromElement` is a useCallback over [mapping, nodesById], so it
    // captures both. Listing it alone is enough — adding mapping/nodesById
    // separately would be redundant and risks dep-array size churn under HMR.
  }, [svg, isInteractive, nodeFromElement]);

  // Delegated click + keydown listener at the inner container level. Stays
  // attached for the lifetime of the inner DOM node so per-render churn on
  // svg / mapping doesn't open a window where clicks silently fail.
  useEffect(() => {
    if (!isInteractive) return;
    const inner = innerRef.current;
    if (!inner) return;

    const dispatch = (target: EventTarget | null, event: Event) => {
      const el = target instanceof Element ? target.closest<SVGGElement>('g.node') : null;
      if (!el) return;
      const node = nodeFromElement(el);
      if (!node) return;
      event.preventDefault();
      event.stopPropagation();
      onNodeClickRef.current?.(node);
    };

    const handleClick = (event: MouseEvent) => {
      dispatch(event.target, event);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      dispatch(event.target, event);
    };

    inner.addEventListener('click', handleClick);
    inner.addEventListener('keydown', handleKeyDown);
    return () => {
      inner.removeEventListener('click', handleClick);
      inner.removeEventListener('keydown', handleKeyDown);
    };
  }, [isInteractive, nodeFromElement]);

  // Class-mutation effect: toggles selection / dim / running / complete classes
  // and aria-pressed only. No event-listener churn here — this can re-run on
  // every step event during a pipeline run without breaking user clicks.
  useEffect(() => {
    if (!svg) return;
    const inner = innerRef.current;
    if (!inner) return;

    const hasRunning = !!runningNodeIds && runningNodeIds.size > 0;
    const hasCompleted = !!completedNodeIds && completedNodeIds.size > 0;
    // When state has flipped back to "nothing to highlight", we still need to
    // sweep classes the previous run of this effect left on the SVG —
    // otherwise dim/active/run/complete classes can stick around after a
    // deselection or run-completion (the SVG is not rerendered on highlight
    // changes).
    if (chain === null && highlightedNodeId === null && !hasRunning && !hasCompleted) {
      const staleNodeEls = inner.querySelectorAll<SVGGElement>('g.node');
      staleNodeEls.forEach((el) => {
        el.classList.remove(
          'dag-node-active',
          'dag-node-dim',
          'dag-node-running',
          'dag-node-complete'
        );
        if (isInteractive) {
          el.setAttribute('aria-pressed', 'false');
        }
      });
      const staleEdgeEls = inner.querySelectorAll<SVGPathElement>('path.flowchart-link');
      staleEdgeEls.forEach((el) => {
        el.classList.remove('dag-edge-dim');
      });
      return;
    }

    const nodeEls = inner.querySelectorAll<SVGGElement>('g.node');
    nodeEls.forEach((el) => {
      // Use the same anchored parser the click/a11y path uses so selection
      // and run classes attach to the exact same node the click handler
      // would resolve. A loose `/n\d+/` could match a stray `n<digits>`
      // earlier in mermaid's useId-prefixed element id and tag the wrong
      // node.
      const node = nodeFromElement(el);
      if (!node) return;
      const nodeId = node.id;

      const isActive = highlightedNodeId === nodeId;

      if (isInteractive) {
        el.setAttribute('aria-pressed', String(isActive));
      }

      if (isActive) {
        el.classList.add('dag-node-active');
      } else {
        el.classList.remove('dag-node-active');
      }

      if (chain && !chain.nodeIds.has(nodeId)) {
        el.classList.add('dag-node-dim');
      } else {
        el.classList.remove('dag-node-dim');
      }

      // Pipeline run animations. The `running` and `complete` classes are
      // composed with whatever else is on the node — including dim — so a
      // step in the user-selected lineage chain still pulses. The keyframes
      // in globals.css define the pulse + flash without competing with the
      // selection stroke / fill, so the visual story layers cleanly.
      if (runningNodeIds && runningNodeIds.has(nodeId)) {
        el.classList.add('dag-node-running');
      } else {
        el.classList.remove('dag-node-running');
      }
      if (completedNodeIds && completedNodeIds.has(nodeId)) {
        el.classList.add('dag-node-complete');
      } else {
        el.classList.remove('dag-node-complete');
      }
    });

    // Dim non-chain edges. Mermaid emits edges as <path class="flowchart-link
    // LS-<startId> LE-<endId> ...">. Decode those mermaid ids back to our
    // node ids and check chain membership.
    const edgeEls = inner.querySelectorAll<SVGPathElement>('path.flowchart-link');
    edgeEls.forEach((el) => {
      const classList = Array.from(el.classList);
      const startClass = classList.find((c) => c.startsWith('LS-'));
      const endClass = classList.find((c) => c.startsWith('LE-'));
      if (!startClass || !endClass) {
        el.classList.remove('dag-edge-dim');
        return;
      }
      const fromMermaidId = startClass.slice(3);
      const toMermaidId = endClass.slice(3);
      const fromNodeId = mapping.get(fromMermaidId);
      const toNodeId = mapping.get(toMermaidId);
      if (!fromNodeId || !toNodeId) {
        el.classList.remove('dag-edge-dim');
        return;
      }
      if (chain && !chain.edgeKeys.has(`${fromNodeId}::${toNodeId}`)) {
        el.classList.add('dag-edge-dim');
      } else {
        el.classList.remove('dag-edge-dim');
      }
    });
    // `nodeFromElement` (useCallback over [mapping, nodesById]) replaces the
    // direct `mapping` reference for node resolution, so listing it alone
    // covers both. Edge resolution still reads `mapping` directly via the
    // `LS-`/`LE-` class prefixes, so it stays in deps too.
  }, [
    svg,
    mapping,
    nodeFromElement,
    highlightedNodeId,
    isInteractive,
    chain,
    runningNodeIds,
    completedNodeIds,
  ]);

  // Mouse-wheel zoom (toward cursor).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setPanZoom((prev) => {
        const delta = -event.deltaY * 0.0015;
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * (1 + delta)));
        const rect = container.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const factor = nextScale / prev.scale;
        return {
          scale: nextScale,
          translateX: cx - (cx - prev.translateX) * factor,
          translateY: cy - (cy - prev.translateY) * factor,
        };
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('g.node')) return;
    draggingRef.current = {
      originX: event.clientX,
      originY: event.clientY,
      baseX: panZoom.translateX,
      baseY: panZoom.translateY,
    };
    setIsDragging(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    setPanZoom((prev) => ({
      ...prev,
      translateX: drag.baseX + dx,
      translateY: drag.baseY + dy,
    }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = null;
    setIsDragging(false);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer may have already been released by the browser (e.g. context menu, focus loss).
    }
  };

  const reset = () => {
    // Reset re-runs the auto-fit so the user can recover from any pan/zoom
    // they don't want; falls back to identity if the SVG isn't measurable.
    if (!fitToView()) {
      setPanZoom(DEFAULT_PAN_ZOOM);
    }
  };
  const adjustScale = (delta: number) =>
    setPanZoom((prev) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale + delta));
      if (nextScale === prev.scale) return prev;
      const container = containerRef.current;
      if (!container) {
        return { ...prev, scale: nextScale };
      }
      // Anchor button zoom to the viewport center so the chart doesn't drift
      // toward the top-left (transform-origin) like the wheel zoom does.
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      const factor = nextScale / prev.scale;
      return {
        scale: nextScale,
        translateX: cx - (cx - prev.translateX) * factor,
        translateY: cy - (cy - prev.translateY) * factor,
      };
    });

  if (failed) {
    return <>{fallback ?? null}</>;
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative overflow-hidden rounded-2xl border border-border bg-card"
        style={{
          touchAction: 'none',
          height: typeof height === 'number' ? `${height}px` : height,
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
      >
        <div
          ref={innerRef}
          style={{
            transform: `translate(${panZoom.translateX}px, ${panZoom.translateY}px) scale(${panZoom.scale})`,
            transformOrigin: '0 0',
            transition: isDragging ? 'none' : 'transform 120ms ease-out',
            padding: 16,
          }}
          data-dag-interactive={isInteractive ? 'true' : 'false'}
          // Mermaid output is built from internal model graph data (no user input);
          // mermaid runs with `securityLevel: 'strict'` which sanitizes its own SVG.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute right-3 top-3 flex flex-col items-center gap-1 rounded-md border border-border bg-background/90 p-1 shadow-sm">
        <button
          type="button"
          onClick={() => adjustScale(0.2)}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-sm hover:bg-secondary"
          aria-label="Zoom in"
        >
          +
        </button>
        <div className="px-1 text-[10px] tabular-nums text-muted-foreground">
          {Math.round(panZoom.scale * 100)}%
        </div>
        <button
          type="button"
          onClick={() => adjustScale(-0.2)}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-sm hover:bg-secondary"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={reset}
          className="mt-1 flex h-7 w-7 items-center justify-center rounded-sm text-[10px] hover:bg-secondary"
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          ⤢
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-muted-foreground/70">
        Drag to pan · scroll to zoom{isInteractive ? ' · click any model for details' : ''}
      </div>
    </div>
  );
}
