import { useEffect, useRef, useState } from 'react';
import { init } from 'gcode-preview';
import { fitToolpath, parseToolpath, renderToolpath } from './toolpath.js';
import type { WebGLPreview } from 'gcode-preview';
import type { LineSegments, Material, LineBasicMaterial } from 'three';
const TRAVEL = '#526373';
class PreviewError extends Error {}
function setVisibility(preview: WebGLPreview, layer: number, single: boolean, travel: boolean) {
  for (const group of preview.scene.children) {
    const match = group.name.match(/^layer(\d+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    group.visible = index > 0 && (single ? index === layer : index <= layer);
    group.traverse((object) => {
      const line = object as LineSegments;
      if (line.isLineSegments) {
        const material = line.material as Material & Partial<LineBasicMaterial>;
        if (material.color?.getHexString() === TRAVEL.slice(1)) line.visible = travel;
      }
    });
  }
}
export function Viewer({ text, onReady }: { text: string; onReady: (ready: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    preview = useRef<WebGLPreview | null>(null);
  const [count, setCount] = useState(0),
    [layer, setLayer] = useState(1),
    [single, setSingle] = useState(false),
    [travel, setTravel] = useState(false),
    [loading, setLoading] = useState(true),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(''),
    [heights, setHeights] = useState<number[]>([]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const abort = new AbortController();
    let instance: WebGLPreview | null = null;
    let observer: ResizeObserver | undefined;
    let disposeToolpath: (() => void) | undefined;
    let rendered = false;
    onReady(false);
    setLoading(true);
    setError('');
    setProgress(0);
    setCount(0);
    setHeights([]);
    void (async () => {
      try {
        instance = init({
          canvas: element,
          buildVolume: { x: 180, y: 180, z: 180 },
          backgroundColor: '#101a25',
          extrusionColor: '#4bd5bc',
          travelColor: TRAVEL,
          topLayerColor: '#ffc27a',
          renderTravel: true,
          renderTubes: false,
          startLayer: 2,
          minLayerThreshold: 0.05,
          initialCameraPosition: [250, 220, 250],
        });
        preview.current = instance;
        observer = new ResizeObserver(() => {
          if (!instance) return;
          instance.resize();
          instance.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
          if (rendered) fitToolpath(instance);
        });
        observer.observe(element.parentElement!);
        instance.resize();
        instance.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        await parseToolpath(instance, text, abort.signal, (fraction) =>
          setProgress(Math.round(fraction * 70)),
        );
        const layers = instance.parser.layers;
        if (!layers.length) throw new PreviewError('表示できるツールパスがありません。');
        setCount(layers.length);
        setLayer(layers.length);
        let z = 0;
        setHeights(layers.map((layer) => (z += layer.height)));
        disposeToolpath = await renderToolpath(instance, abort.signal, (fraction) =>
          setProgress(70 + Math.round(fraction * 30)),
        );
        abort.signal.throwIfAborted();
        setVisibility(instance, layers.length, false, false);
        fitToolpath(instance);
        rendered = true;
        setProgress(100);
        setLoading(false);
        onReady(true);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(
            e instanceof PreviewError
              ? e.message
              : '3D表示に失敗しました。WebGL対応ブラウザで開いてください。',
          );
          setLoading(false);
          onReady(false);
          disposeToolpath?.();
          observer?.disconnect();
          instance?.dispose();
          preview.current = null;
        }
      }
    })();
    return () => {
      abort.abort();
      observer?.disconnect();
      disposeToolpath?.();
      if (instance) {
        instance.parser.layers = [];
        instance.parser.preamble.commands = [];
        instance.dispose();
      }
      preview.current = null;
    };
  }, [text, onReady]);
  useEffect(() => {
    if (preview.current && !loading) setVisibility(preview.current, layer, single, travel);
  }, [layer, single, travel, loading]);
  return (
    <section className="viewer" aria-label="3Dツールパス">
      <div className="viewport">
        <canvas ref={canvas} aria-label="G-codeプレビュー" />
        <div className="plate-label">
          A1 mini <span>180 × 180 × 180 mm</span>
        </div>
        <div className="gesture-hint">ドラッグ: 回転 · スクロール: ズーム · 右ドラッグ: 移動</div>
        {loading && (
          <div className="viewport-message" role="status">
            <span className="spinner" />
            読み込み中 {progress}%
          </div>
        )}
        {error && (
          <div className="viewport-message error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="layer-panel">
        <div className="layer-heading">
          <strong>
            レイヤー <b>{count ? layer : '—'}</b>
            <span> / {count || '—'}</span>
          </strong>
          <span>{heights[layer - 1] ? `${heights[layer - 1]?.toFixed(2)} mm` : ''}</span>
        </div>
        <input
          aria-label="レイヤー"
          type="range"
          min="1"
          max={count || 1}
          value={layer}
          disabled={loading || !count}
          onChange={(e) => setLayer(Number(e.target.value))}
        />
        <div className="layer-options">
          <label>
            <input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} />
            このレイヤーのみ
          </label>
          <label>
            <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} />
            移動経路
          </label>
          <span className="legend">
            ● 押出 <i>● 移動</i>
          </span>
        </div>
      </div>
    </section>
  );
}
