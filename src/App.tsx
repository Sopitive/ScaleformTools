import React, { useState, useRef, useEffect } from 'react';
import {
  FileJson,
  Save,
  Download,
  Move,
  Type,
  Square,
  Circle,
  Layers,
  Settings,
  Undo,
  Redo,
  Maximize,
  Minimize,
  Palette,
  Layout,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  FileImage,
} from 'lucide-react';
import { Stage, Layer, Rect, Transformer, Text, Group, Path } from 'react-konva';
import { motion, AnimatePresence } from 'framer-motion';

import { GFXParser } from './lib/gfx';
import { parseAS2Actions, encodeAS2Actions } from './lib/gfxPatcher';
import type { EditableAction } from './lib/gfxPatcher';
import { parseAS3 } from './lib/as3Parser';
import { compileAS3 } from './lib/as3Compiler';
import { serialiseABC } from './lib/abcFile';
import { decompileABCClass } from './lib/as3Decompiler';
import { mergeClassIntoABC } from './lib/abcMerger';
import { AVMRuntime, type DisplayChange } from './lib/as3Runtime';
import {
  isNative,
  nativeOpenFile,
  nativeSaveFile,
  nativeLiveEditWrite,
  onLiveEditStatus,
  uint8ToBase64,
  base64ToUint8,
} from './lib/native';
import { TexturePackEditor } from './components/TexturePackEditor';

// File System Access API (Chrome/Edge) — not in standard TS lib
declare global {
  interface Window {
    showOpenFilePicker?: (opts?: any) => Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?: (opts?: any) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemFileHandle {
    readonly kind: 'file';
    name: string;
    getFile(): Promise<File>;
    createWritable(opts?: any): Promise<FileSystemWritableFileStream>;
  }
  interface FileSystemDirectoryHandle {
    readonly kind: 'directory';
    name: string;
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileSystemFileHandle>;
  }
  interface FileSystemWritableFileStream extends WritableStream {
    write(data: ArrayBuffer | ArrayBufferView | Blob | string): Promise<void>;
    close(): Promise<void>;
  }
}

// --- Types ---
interface GFXElement {
  id: string;
  type: 'rect' | 'text' | 'group' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX?: number;
  scaleY?: number;
  rotate0?: number;
  rotate1?: number;
  fill?: string;
  text?: string;
  color?: string;
  fontSize?: number;
  letterSpacing?: number;
  svgPath?: string;
  stroke?: string;
  strokeWidth?: number;
  align?: string;
  wordWrap?: boolean;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  originalId?: number;
  className?: string;
  maxLength?: number;
  variableName?: string;
  password?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  html?: boolean;
  // Gradient fill data (from SWF gradient fills)
  gradientFill?: {
    type: 'linear' | 'radial';
    stops: Array<{ offset: number; r: number; g: number; b: number; a: number }>;
  };
  // Shape's local coordinate bounding box (for gradient positioning)
  shapeLocalBounds?: { x: number; y: number; w: number; h: number };
  // Internal: binary patch location, set by parser - do not edit manually
  _patchKey?: string;
  _origX?: number;
  _origY?: number;
  _origScaleX?: number;
  _origScaleY?: number;
  _origColor?: string; // original text color from binary, for change detection
  _parentScaleX?: number;
  _parentScaleY?: number;
  // Which sprite directly contains this element, and how many frames that sprite has
  _spriteId?: number;
  _spriteFrameCount?: number;
}

const App: React.FC = () => {
  const [elements, setElements] = useState<GFXElement[]>([]);
  const [stageSize, setStageSize] = useState({ width: 1920, height: 1080 });
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<{ visible: boolean, sx: number, sy: number, x: number, y: number, width: number, height: number } | null>(null);
  const [history, setHistory] = useState<GFXElement[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [viewMode, setViewMode] = useState<'canvas' | 'code'>('canvas');
  const [fileName, setFileName] = useState('HUD_MAIN.GFX');
  const stageRef = useRef<any>(null);
  const trRef = useRef<any>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Live-edit mode
  const [liveEditMode, setLiveEditMode] = useState(false);
  const [liveEditStatus, setLiveEditStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [stagingDirName, setStagingDirName] = useState<string>('');
  const stagingDirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const liveEditTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Desktop-native live edit: path of the actual game file (no staging folder needed)
  const [nativeLiveSourcePath, setNativeLiveSourcePath] = useState<string>('');
  const nativeLiveSourceRef = useRef<string>('');
  const suppressLiveSaveRef = useRef(false); // true while initial file load is being applied

  // Marquee / pan interaction refs (avoid re-renders during drag)
  const isPanningRef   = useRef(false);
  const panStartRef    = useRef({ ox: 0, oy: 0, px: 0, py: 0 }); // origin offsets + pointer start
  const isSelectingRef = useRef(false);
  const selStartRef    = useRef({ x: 0, y: 0 });  // canvas-space start of marquee
  const hasDraggedRef  = useRef(false);             // distinguish click from drag
  const [gfxMeta, setGfxMeta] = useState<any>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [library, setLibrary] = useState<Record<number, any>>({});
  const [leftSidebarMode, setLeftSidebarMode] = useState<'layers' | 'library' | 'scripts'>('layers');
  const [allScripts, setAllScripts] = useState<any[]>([]);
  const [currentContext, setCurrentContext] = useState<number>(0); // 0 = root
  const [navigationStack, setNavigationStack] = useState<{id: number, name: string}[]>([]);
  const [currentScripts, setCurrentScripts] = useState<any[]>([]);
  const [currentFrameCount, setCurrentFrameCount] = useState(1);
  const [allFrameScripts, setAllFrameScripts] = useState<Map<number, any[]>>(new Map());
  const [isLooping, setIsLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const parserRef = useRef<InstanceType<typeof GFXParser> | null>(null);
  const getElementsRef = useRef<((idx: number, ctx: number, spriteFrameMap?: Map<number, number>) => {elements: GFXElement[], scripts: any[]}) | null>(null);
  const avmRtRef = useRef<AVMRuntime | null>(null);
  const [compositeMode, setCompositeMode] = useState(false);
  const [hoverSimulation, setHoverSimulation] = useState(false);
  const [appMode, setAppMode] = useState<'gfx' | 'textures'>('gfx');
  const [scriptEditorTarget, setScriptEditorTarget] = useState<any>(null);
  // Ref: per-sprite current frame for composite playback (avoids stale closure)
  const spriteFramesRef = useRef<Map<number, number>>(new Map());
  const currentFrameRef = useRef(0);
  // Track which sprite is currently in a hover state (so leave knows what to revert)
  const hoveredSpritesRef = useRef<Map<number, string>>(new Map()); // spriteId → label entered

  const pushHistory = (newElements: GFXElement[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newElements);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setElements(newElements);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setElements(history[historyIndex - 1]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setElements(history[historyIndex + 1]);
    }
  };

  const processFileBuffer = async (buffer: ArrayBuffer, name: string) => {
    suppressLiveSaveRef.current = true;
    try {
      const parser = new GFXParser(buffer);
      const modernFormat = await parser.toModernFormat();
      console.log('Parsed GFX:', modernFormat);
      parserRef.current = parser;

      getElementsRef.current = modernFormat.getElementsForFrame;
      setHistory([modernFormat.elements]);
      setHistoryIndex(0);
      setElements(modernFormat.elements);
      setCurrentScripts(modernFormat.scripts || []);
      const allScriptsNow = modernFormat.allScripts || [];
      setAllScripts(allScriptsNow);
      setFileName(name);
      setGfxMeta(modernFormat.gfxMeta);
      setLibrary(modernFormat.library);
      setCurrentFrame(0);
      setCurrentFrameCount(modernFormat.gfxMeta?.frameCount || 1);

      // ── Initialize AVM2 runtime ──────────────────────────────────────────
      try {
        const rt = new AVMRuntime();
        // Load all AS3 ABC payloads
        for (const s of allScriptsNow) {
          if (s.abc instanceof Uint8Array) rt.loadABC(s.abc);
        }
        // Build display object tree from elements
        rt.buildDisplayTree(modernFormat.elements);
        // Run script initializers (registers event listeners, sets text, etc.)
        rt.runScriptInits();
        // Wire change callback to update canvas elements via setElements
        rt.onChanges = (changes: DisplayChange[]) => {
          setElements(prev => {
            let next = prev;
            for (const ch of changes) {
              const idx = next.findIndex(e => e.name === ch.objName);
              if (idx === -1) continue;
              next = next.map((e, i) => {
                if (i !== idx) return e;
                if (ch.prop === 'text')    return { ...e, text: String(ch.value ?? '') };
                if (ch.prop === 'visible') return { ...e, visible: Boolean(ch.value) };
                if (ch.prop === 'x')       return { ...e, x: Number(ch.value ?? e.x) };
                if (ch.prop === 'y')       return { ...e, y: Number(ch.value ?? e.y) };
                if (ch.prop === 'alpha')   return { ...e, opacity: Number(ch.value ?? 1) };
                if (ch.prop === 'scaleX')  return { ...e, scaleX: Number(ch.value ?? 1) };
                if (ch.prop === 'scaleY')  return { ...e, scaleY: Number(ch.value ?? 1) };
                return e;
              });
            }
            return next;
          });
        };
        avmRtRef.current = rt;
      } catch (e) {
        console.warn('AVM runtime init failed:', e);
      }
      setCurrentContext(0);
      setNavigationStack([]);
      setIsPlaying(false);

      const sw = modernFormat.gfxMeta?.stageW || 1920;
      const sh = modernFormat.gfxMeta?.stageH || 1080;
      setStageSize({ width: sw, height: sh });

      setTimeout(() => {
        if (canvasContainerRef.current) {
          const containerW = canvasContainerRef.current.clientWidth;
          const containerH = canvasContainerRef.current.clientHeight;
          const fitZoom = Math.min(containerW / sw, containerH / sh) * 0.95;
          setZoom(fitZoom);
          setPanOffset({ x: (containerW - sw * fitZoom) / 2, y: (containerH - sh * fitZoom) / 2 });
        }
        suppressLiveSaveRef.current = false; // allow live saves after load settles
      }, 100);
    } catch (err) {
      suppressLiveSaveRef.current = false;
      alert('Failed to parse GFX: ' + (err as Error).message);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await processFileBuffer(buffer, file.name);
  };

  // Desktop-native file open. Checks the window flag at call-time (not the static
  // module-level constant) to avoid timing issues with module evaluation order.
  // Falls back to the hidden <input type="file"> if the WebView2 bridge is unavailable.
  const handleNativeOpenFile = async () => {
    const bridgeAvailable =
      !!(window as any).__isNativeApp && !!(window as any).chrome?.webview;

    if (!bridgeAvailable) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const result = await nativeOpenFile();
      if (result.cancelled || !result.dataBase64 || !result.name) return;
      const bytes = base64ToUint8(result.dataBase64);
      await processFileBuffer(bytes.buffer as ArrayBuffer, result.name);
      // Remember the path so Live Mode can write back to the same file
      if (result.path) {
        nativeLiveSourceRef.current = result.path;
        setNativeLiveSourcePath(result.path);
      }
    } catch (err) {
      console.error('[Native open] failed:', err);
      // Bridge call failed — fall back to normal file input
      fileInputRef.current?.click();
    }
  };

  const handleEnableLiveMode = async () => {
    if (!parserRef.current) {
      alert('Import a GFX file first, then enable Live Mode.');
      return;
    }

    if (liveEditMode) {
      // Toggle off
      setLiveEditMode(false);
      stagingDirHandleRef.current = null;
      setStagingDirName('');
      return;
    }

    // ── Desktop native path — no dialog needed, write to the imported file ──
    if (isNative) {
      if (!nativeLiveSourceRef.current) {
        alert('Import a GFX file first — Live Mode will auto-save changes directly back to that file.');
        return;
      }
      setLiveEditMode(true);
      setLiveEditStatus('idle');
      return;
    }

    // ── Web browser path (staging folder + watcher.mjs) ──────────────────────
    if (!window.showDirectoryPicker) {
      alert('Live Mode requires Chrome or Edge (File System Access API), or the desktop app.');
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      stagingDirHandleRef.current = dirHandle;
      setStagingDirName(dirHandle.name);
      setLiveEditMode(true);
      setLiveEditStatus('idle');
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        alert('Could not open staging folder: ' + (err as Error).message);
      }
    }
  };

  const handleExport = async () => {
    try {
      if (!parserRef.current) {
        alert('No GFX file loaded. Please import a .gfx file first.');
        return;
      }
      const compiled = await parserRef.current.compile(elements, gfxMeta);
      const exportName = fileName.toLowerCase().endsWith('.gfx') ? fileName : fileName + '.gfx';

      // ── Desktop native save ───────────────────────────────────────────────
      if (isNative) {
        const b64 = uint8ToBase64(compiled as Uint8Array);
        const result = await nativeSaveFile(null, b64, exportName);
        if (!result.cancelled && result.path) {
          // Update native live source to the just-saved file
          nativeLiveSourceRef.current = result.path;
          setNativeLiveSourcePath(result.path);
        }
        return;
      }

      // ── Browser save ──────────────────────────────────────────────────────
      const blob = new Blob([compiled as any], { type: 'application/octet-stream' });

      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: exportName,
            types: [{ description: 'GFX File', accept: { 'application/octet-stream': ['.gfx', '.GFX'] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (err: any) {
          if (err.name === 'AbortError') return;
          console.warn('File picker failed, falling back to download', err);
        }
      }

      // Fallback download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = exportName; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to compile GFX: ' + (err as Error).message);
    }
  };

  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) return;
    const newEls = elements.filter(el => !selectedIds.includes(el.id));
    pushHistory(newEls);
    setSelectedIds([]);
  };

  const handleAddRect = () => {
    const stage = stageRef.current;
    const cx = stage ? (stage.width() / 2 - panOffset.x) / zoom : 400;
    const cy = stage ? (stage.height() / 2 - panOffset.y) / zoom : 300;
    const id = `el_new_${Date.now()}`;
    const newEl: GFXElement = {
      id, name: 'New Rectangle', type: 'rect',
      x: cx - 100, y: cy - 50, width: 200, height: 100,
      scaleX: 1, scaleY: 1,
      fill: '#6366f1', opacity: 1, visible: true, locked: false,
    };
    pushHistory([...elements, newEl]);
    setSelectedIds([id]);
  };

  const handleAddText = () => {
    const stage = stageRef.current;
    const cx = stage ? (stage.width() / 2 - panOffset.x) / zoom : 400;
    const cy = stage ? (stage.height() / 2 - panOffset.y) / zoom : 300;
    const id = `el_new_${Date.now()}`;
    const newEl: GFXElement = {
      id, name: 'New Text', type: 'text',
      x: cx - 100, y: cy - 20, width: 200, height: 40,
      scaleX: 1, scaleY: 1,
      fill: '#ffffff', color: '#ffffff', text: 'New Text',
      fontSize: 24, opacity: 1, visible: true, locked: false,
    };
    pushHistory([...elements, newEl]);
    setSelectedIds([id]);
  };

  const handleSelect = (id: string | null, multi = false) => {
    if (id === null) {
      setSelectedIds([]);
      return;
    }
    if (multi) {
      setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    } else {
      setSelectedIds([id]);
    }
  };

  const handleElementChange = (idOrIds: string | string[], newAttrs: Partial<GFXElement>) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const newElements = elements.map(el => ids.includes(el.id) ? { ...el, ...newAttrs } : el);
    pushHistory(newElements);
  };

  const handleDragMove = (id: string, e: any) => {
    if (!selectedIds.includes(id)) return;
    const originalEl = elements.find(el => el.id === id);
    if (!originalEl) return;

    const dx = e.target.x() - originalEl.x;
    const dy = e.target.y() - originalEl.y;

    selectedIds.forEach(selectedId => {
      if (selectedId !== id) {
        const node = stageRef.current?.findOne('#' + selectedId);
        const selOriginal = elements.find(el => el.id === selectedId);
        if (node && selOriginal) {
          node.x(selOriginal.x + dx);
          node.y(selOriginal.y + dy);
        }
      }
    });
  };

  const handleDragEnd = (id: string, e: any) => {
    const originalEl = elements.find(el => el.id === id);
    if (!originalEl) return;

    if (!selectedIds.includes(id)) {
      handleElementChange(id, { x: e.target.x(), y: e.target.y() });
      return;
    }

    const dx = e.target.x() - originalEl.x;
    const dy = e.target.y() - originalEl.y;

    const newElements = elements.map(el => {
      if (selectedIds.includes(el.id)) {
        return { ...el, x: el.x + dx, y: el.y + dy };
      }
      return el;
    });
    pushHistory(newElements);
  };

  // Keep currentFrameRef in sync for use inside setInterval closures
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);

  // Initialize sprite frames whenever library or context changes
  useEffect(() => {
    const map = new Map<number, number>();
    for (const [idStr, def] of Object.entries(library)) {
      if ((def as any).type === 'sprite' && (def as any).frameCount > 1) {
        map.set(parseInt(idStr), 0);
      }
    }
    spriteFramesRef.current = map;
  }, [library, currentContext]);

  // Helper: check if a sprite def has stop() on a given frame
  const spriteHasStop = (def: any, frameIdx: number): boolean => {
    for (const t of (def.frames?.[frameIdx] || [])) {
      if (t.actions || t.data) {
        const raw: Uint8Array = t.data instanceof Uint8Array ? t.data : new Uint8Array(t.data || []);
        if (parseAS2Actions(raw).some((a: any) => a.type === 'stop')) return true;
      }
    }
    return false;
  };

  // --- Animation Playback Engine ---
  useEffect(() => {
    const hasRootAnim = currentFrameCount > 1;
    const hasSpriteAnim = compositeMode && spriteFramesRef.current.size > 0;
    if (!isPlaying || (!hasRootAnim && !hasSpriteAnim)) return;

    const fps = (gfxMeta?.frameRate || 30) * playbackSpeed;
    const interval = setInterval(() => {
      // 1. Advance sprite frames (composite mode)
      if (hasSpriteAnim) {
        const next = new Map(spriteFramesRef.current);
        for (const [spriteId, frame] of next.entries()) {
          const def = library[spriteId];
          if (!def) continue;
          const fc = def.frameCount || 1;
          const nextFrame = isLooping ? (frame + 1) % fc : Math.min(frame + 1, fc - 1);
          if (!spriteHasStop(def, nextFrame)) next.set(spriteId, nextFrame);
        }
        spriteFramesRef.current = next;
      }

      // 2. Advance root frame
      if (hasRootAnim) {
        setCurrentFrame(prev => {
          const next = prev + 1;
          const looped = next >= currentFrameCount;
          if (looped && !isLooping) { setIsPlaying(false); return prev; }
          const nextFrame = looped ? 0 : next;
          if (getElementsRef.current) {
            const { elements: fe, scripts: sc } = getElementsRef.current(nextFrame, currentContext, hasSpriteAnim ? new Map(spriteFramesRef.current) : undefined);
            setElements(fe); setCurrentScripts(sc);
          }
          return nextFrame;
        });
      } else {
        // Sprite-only — re-render with same root frame
        if (getElementsRef.current) {
          const { elements: fe, scripts: sc } = getElementsRef.current(currentFrameRef.current, currentContext, new Map(spriteFramesRef.current));
          setElements(fe); setCurrentScripts(sc);
        }
      }
    }, 1000 / fps);
    return () => clearInterval(interval);
  }, [isPlaying, currentFrameCount, currentContext, gfxMeta, isLooping, playbackSpeed, compositeMode, library]);

  // Precompute which frames have scripts so the script map strip can display them all at once
  useEffect(() => {
    if (!getElementsRef.current || currentFrameCount <= 0) { setAllFrameScripts(new Map()); return; }
    const map = new Map<number, any[]>();
    for (let i = 0; i < currentFrameCount; i++) {
      const { scripts } = getElementsRef.current(i, currentContext);
      if (scripts.length > 0) map.set(i, scripts);
    }
    setAllFrameScripts(map);
  }, [currentContext, currentFrameCount]);

  const handleFrameChange = (frame: number) => {
    if (!getElementsRef.current) return;
    setCurrentFrame(frame);
    const { elements: newElements, scripts } = getElementsRef.current(frame, currentContext, compositeMode ? new Map(spriteFramesRef.current) : undefined);
    setElements(newElements);
    setCurrentScripts(scripts);
  };

  // Jump to a specific sprite frame within composite mode
  const jumpSpriteToFrame = (spriteId: number, frame: number) => {
    spriteFramesRef.current = new Map(spriteFramesRef.current).set(spriteId, frame);
    if (getElementsRef.current) {
      const { elements: fe, scripts: sc } = getElementsRef.current(currentFrameRef.current, currentContext, new Map(spriteFramesRef.current));
      setElements(fe); setCurrentScripts(sc);
    }
  };

  // ── Label categories ──────────────────────────────────────────────────────
  const LABEL_CATS: Record<string, string[]> = {
    entry:  ['intro', 'in', 'open', 'show', 'appear', 'start', 'fadein', 'fade_in', 'enter', 'transition_in'],
    idle:   ['idle', 'normal', 'default', 'loop', 'looping', 'off', 'unfocused', 'blur', 'base', 'rest'],
    hover:  ['over', 'hover', 'focused', 'focus', 'highlight', 'selected', 'rollover', 'on', 'active_over'],
    press:  ['press', 'pressed', 'down', 'click', 'active', 'pushed'],
    exit:   ['outro', 'out', 'close', 'hide', 'end', 'fadeout', 'fade_out', 'exit', 'transition_out'],
    disabled: ['disabled', 'inactive', 'locked', 'grayed'],
  };
  const CAT_COLORS: Record<string, {color: string; bg: string}> = {
    entry:    { color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
    idle:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)'  },
    hover:    { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)'  },
    press:    { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    exit:     { color: '#fb923c', bg: 'rgba(251,146,60,0.12)'  },
    disabled: { color: '#6b7280', bg: 'rgba(107,114,128,0.1)'  },
    unknown:  { color: '#c084fc', bg: 'rgba(192,132,252,0.1)'  },
  };
  const classifyLabel = (label: string): string => {
    const lower = label.toLowerCase();
    for (const [cat, names] of Object.entries(LABEL_CATS)) {
      if (names.some(n => lower === n || lower.startsWith(n) || lower.endsWith(n))) return cat;
    }
    return 'unknown';
  };

  // ── Hover simulation ──────────────────────────────────────────────────────
  const triggerSpriteLabel = (spriteId: number, label: string) => {
    const def = library[spriteId];
    if (!def?.frameLabels) return;
    const lbl = def.frameLabels.find((l: any) => l.label === label);
    if (!lbl) return;
    // Enable composite + play so the animation actually runs from this label
    if (!compositeMode) setCompositeMode(true);
    if (!isPlaying) setIsPlaying(true);
    jumpSpriteToFrame(spriteId, lbl.frame);
  };

  const handleElementHover = (el: GFXElement) => {
    // AS3 event dispatch
    if (hoverSimulation && avmRtRef.current && el.name) {
      avmRtRef.current.dispatchEvent(el.name, 'rollOver');
      avmRtRef.current.dispatchEvent(el.name, 'mouseOver');
    }
    // Sprite-frame label hover (existing behavior)
    if (!hoverSimulation || !el._spriteId || (el._spriteFrameCount ?? 1) <= 1) return;
    const def = library[el._spriteId];
    const labels: any[] = def?.frameLabels || [];
    const hoverLabel = labels.find((l: any) => LABEL_CATS.hover.some(n => l.label.toLowerCase().startsWith(n) || l.label.toLowerCase() === n));
    if (!hoverLabel) return;
    hoveredSpritesRef.current.set(el._spriteId, hoverLabel.label);
    triggerSpriteLabel(el._spriteId, hoverLabel.label);
  };

  const handleElementLeave = (el: GFXElement) => {
    // AS3 event dispatch
    if (hoverSimulation && avmRtRef.current && el.name) {
      avmRtRef.current.dispatchEvent(el.name, 'rollOut');
      avmRtRef.current.dispatchEvent(el.name, 'mouseOut');
    }
    // Sprite-frame label hover (existing behavior)
    if (!hoverSimulation || !el._spriteId) return;
    if (!hoveredSpritesRef.current.has(el._spriteId)) return;
    hoveredSpritesRef.current.delete(el._spriteId);
    const def = library[el._spriteId];
    const labels: any[] = def?.frameLabels || [];
    const idleLabel = labels.find((l: any) => LABEL_CATS.idle.some(n => l.label.toLowerCase() === n || l.label.toLowerCase().startsWith(n)));
    if (idleLabel) triggerSpriteLabel(el._spriteId, idleLabel.label);
    else jumpSpriteToFrame(el._spriteId, 0);
  };

  // ── Entry animation preview ───────────────────────────────────────────────
  const previewEntry = () => {
    // Reset all sprites to frame 0, enable composite + play
    const map = new Map<number, number>();
    for (const [idStr, def] of Object.entries(library)) {
      if ((def as any).type === 'sprite') map.set(parseInt(idStr), 0);
    }
    spriteFramesRef.current = map;
    setCompositeMode(true);
    setIsPlaying(true);
    // Also reset root frame
    setCurrentFrame(0);
    if (getElementsRef.current) {
      const { elements: fe, scripts: sc } = getElementsRef.current(0, currentContext, map);
      setElements(fe); setCurrentScripts(sc);
    }
  };

  const enterSprite = (id: number) => {
    const def = library[id];
    if (!def || def.type !== 'sprite') return;
    setNavigationStack(prev => [...prev, { id, name: def.className || `Sprite #${id}` }]);
    setCurrentContext(id);
    setCurrentFrameCount(def.frameCount || 1);
    setCurrentFrame(0);
    if (getElementsRef.current) {
        const { elements: newElements, scripts } = getElementsRef.current(0, id);
        setElements(newElements);
        setCurrentScripts(scripts);
    }
  };

  const exitSprite = (index: number) => {
    let nextCtx = 0;
    let nextCount = gfxMeta?.frameCount || 1;
    if (index === -1) {
        setNavigationStack([]);
        setCurrentContext(0);
        nextCtx = 0;
        nextCount = gfxMeta?.frameCount || 1;
    } else {
        const item = navigationStack[index];
        const def = library[item.id];
        setNavigationStack(prev => prev.slice(0, index + 1));
        setCurrentContext(item.id);
        nextCtx = item.id;
        nextCount = def?.frameCount || 1;
    }
    setCurrentFrameCount(nextCount);
    setCurrentFrame(0);
    if (getElementsRef.current) {
        const { elements: newElements, scripts } = getElementsRef.current(0, nextCtx);
        setElements(newElements);
        setCurrentScripts(scripts);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        handleRedo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.length > 0) {
          const newEls = elements.filter(el => !selectedIds.includes(el.id));
          pushHistory(newEls);
          setSelectedIds([]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [history, historyIndex, elements, selectedIds]);

  useEffect(() => {
    if (trRef.current && stageRef.current) {
      if (selectedIds.length > 0) {
        const nodes = selectedIds.map(id => stageRef.current.findOne('#' + id)).filter(Boolean);
        trRef.current.nodes(nodes);
      } else {
        trRef.current.nodes([]);
      }

      const layer = trRef.current.getLayer();
      if (layer) layer.batchDraw();

      if (selectedIds.length === 1) {
        const sidebarEl = document.getElementById(`layer-item-${selectedIds[0]}`);
        if (sidebarEl) {
          sidebarEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  }, [selectedIds, elements]);

  // Subscribe to live-edit status pushed from the C# side (e.g. backup created).
  useEffect(() => {
    if (!isNative) return;
    return onLiveEditStatus(status => {
      if (!status.Ok) {
        setLiveEditStatus('error');
      }
      // The main export path already sets 'saved'/'error', so we only care about
      // unexpected C#-side errors here (e.g. backup failure).
    });
  }, []);

  // Live-edit auto-export: fires whenever elements change (debounced 400 ms)
  // Native mode: writes directly to game file via C# bridge.
  // Browser mode: writes to staging folder; watcher.mjs copies it to the game dir.
  useEffect(() => {
    const nativeSource = isNative ? nativeLiveSourceRef.current : '';
    const hasNativeTarget = isNative && !!nativeSource;
    const hasBrowserTarget = !isNative && !!stagingDirHandleRef.current;
    if (!liveEditMode || (!hasNativeTarget && !hasBrowserTarget) || !parserRef.current) return;
    if (suppressLiveSaveRef.current) return; // still loading

    if (liveEditTimerRef.current) clearTimeout(liveEditTimerRef.current);
    setLiveEditStatus('saving');

    liveEditTimerRef.current = setTimeout(async () => {
      try {
        const compiled = await parserRef.current!.compile(elements, null);

        if (hasNativeTarget) {
          const b64 = uint8ToBase64(compiled as Uint8Array);
          await nativeLiveEditWrite(b64, nativeSource);
        } else {
          const dirHandle = stagingDirHandleRef.current!;
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(compiled as unknown as ArrayBuffer);
          await writable.close();
        }

        setLiveEditStatus('saved');
        setTimeout(() => setLiveEditStatus('idle'), 2000);
      } catch (err) {
        console.error('[Live Edit] Export failed:', err);
        setLiveEditStatus('error');
      }
    }, 400);

    return () => {
      if (liveEditTimerRef.current) clearTimeout(liveEditTimerRef.current);
    };
  }, [elements, liveEditMode, fileName]);

  // Global mouse listeners: end pan/marquee if pointer leaves the canvas mid-drag
  useEffect(() => {
    const onGlobalMouseMove = (e: MouseEvent) => {
      if (isPanningRef.current) {
        const dx = e.clientX - panStartRef.current.px;
        const dy = e.clientY - panStartRef.current.py;
        setPanOffset({ x: panStartRef.current.ox + dx, y: panStartRef.current.oy + dy });
      }
    };
    const onGlobalMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
      }
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
        hasDraggedRef.current = false;
        setSelectionBox(null);
      }
    };
    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', onGlobalMouseMove);
      window.removeEventListener('mouseup', onGlobalMouseUp);
    };
  }, []); // no deps — uses only refs and stable setters

  // Update canvas cursor based on interaction state
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const updateCursor = (e: MouseEvent) => {
      if (isPanningRef.current) {
        container.style.cursor = 'grabbing';
      } else if (e.button === 1 || (e.buttons & 4)) {
        container.style.cursor = 'grab';
      } else {
        container.style.cursor = 'default';
      }
    };
    const resetCursor = () => { container.style.cursor = 'default'; };
    window.addEventListener('mousemove', updateCursor);
    window.addEventListener('mouseup', resetCursor);
    return () => {
      window.removeEventListener('mousemove', updateCursor);
      window.removeEventListener('mouseup', resetCursor);
    };
  }, []);

  return (
    <>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {/* App-level mode switcher strip */}
      <div style={{ height: '36px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px', padding: '0 0.75rem', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-color)', zIndex: 10 }}>
        <button
          className={`btn btn-sm ${appMode === 'gfx' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: '0.65rem', padding: '3px 10px', borderRadius: '20px', gap: '5px' }}
          onClick={() => setAppMode('gfx')}
        >
          <FileJson size={12} /> GFX / SWF
        </button>
        <button
          className={`btn btn-sm ${appMode === 'textures' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: '0.65rem', padding: '3px 10px', borderRadius: '20px', gap: '5px' }}
          onClick={() => setAppMode('textures')}
        >
          <FileImage size={12} /> Texture Packs
        </button>
      </div>

      {/* Texture Pack Editor (full area when active) */}
      {appMode === 'textures' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <TexturePackEditor />
        </div>
      )}

      {/* GFX / SWF editor layout */}
      <div style={{ display: appMode === 'gfx' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Left Sidebar: Layers / Library / Scripts */}
      <aside className="sidebar">
        <div style={{ height: '44px', flexShrink: 0, padding: '0 0.75rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            className={`btn btn-sm ${leftSidebarMode === 'layers' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, fontSize: '0.7rem', borderRadius: '4px', overflow: 'hidden', whiteSpace: 'nowrap' }}
            onClick={() => setLeftSidebarMode('layers')}
          >
            <Layers size={13} style={{ marginRight: '4px', flexShrink: 0 }} />
            Layers
          </button>
          <button
            className={`btn btn-sm ${leftSidebarMode === 'library' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, fontSize: '0.7rem', borderRadius: '4px', overflow: 'hidden', whiteSpace: 'nowrap' }}
            onClick={() => setLeftSidebarMode('library')}
          >
            <Maximize size={13} style={{ marginRight: '4px', flexShrink: 0 }} />
            Library
          </button>
          <button
            className={`btn btn-sm ${leftSidebarMode === 'scripts' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, fontSize: '0.7rem', borderRadius: '4px', overflow: 'hidden', whiteSpace: 'nowrap' }}
            onClick={() => setLeftSidebarMode('scripts')}
          >
            <FileJson size={13} style={{ marginRight: '4px', flexShrink: 0 }} />
            Scripts
            {allScripts.length > 0 && (
              <span style={{ marginLeft: '3px', fontSize: '0.55rem', opacity: 0.55, flexShrink: 0 }}>{allScripts.length}</span>
            )}
          </button>
        </div>

        <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto' }}>
          {leftSidebarMode === 'scripts' ? (
            <div style={{ padding: '0.5rem' }}>
              {allScripts.length === 0 && (
                <div style={{ padding: '1.5rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', opacity: 0.6 }}>
                  No scripts found.<br />Load a GFX file with ActionScript.
                </div>
              )}
              {allScripts.map((s, i) => {
                const isAS3 = s.abc instanceof Uint8Array || s.scriptType === 'AS3';
                return (
                  <div
                    key={i}
                    onClick={() => setScriptEditorTarget(s)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-md)',
                      marginBottom: '2px', cursor: 'pointer',
                      background: 'transparent', border: '1px solid transparent',
                      transition: 'all 0.12s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <FileJson size={13} color={isAS3 ? '#c084fc' : '#60a5fa'} style={{ flexShrink: 0 }} />
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s._label ?? (isAS3 ? 'AS3 Script' : 'AS2 Script')}
                      </span>
                      <span style={{ fontSize: '0.6rem', opacity: 0.4 }}>
                        {isAS3 ? 'AVM2' : 'AVM1'} · {(s.data?.length ?? s.abc?.length ?? 0)} B
                      </span>
                    </div>
                    <span style={{ marginLeft: 'auto', fontSize: '0.55rem', padding: '1px 5px', borderRadius: '3px', flexShrink: 0, fontWeight: 700,
                      color: isAS3 ? '#c084fc' : '#60a5fa',
                      background: isAS3 ? 'rgba(192,132,252,0.1)' : 'rgba(96,165,250,0.1)',
                    }}>
                      {isAS3 ? 'AS3' : 'AS2'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : leftSidebarMode === 'layers' ? (
            <div style={{ padding: '0.5rem' }}>
              {elements.map(el => (
                <div
                  id={`layer-item-${el.id}`}
                  key={el.id}
                  onClick={(e) => handleSelect(el.id, e.ctrlKey || e.metaKey)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.6rem 0.75rem',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: '2px',
                    cursor: 'pointer',
                    backgroundColor: selectedIds.includes(el.id) ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    border: selectedIds.includes(el.id) ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid transparent',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {el.type === 'rect' ? <Square size={14} style={{ marginRight: '10px', flexShrink: 0 }} /> : <Type size={14} style={{ marginRight: '10px', flexShrink: 0 }} />}
                  <span style={{ fontSize: '0.75rem', flex: 1, color: selectedIds.includes(el.id) ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {el.name}
                  </span>
                  {(el._spriteFrameCount ?? 1) > 1 && (
                    <span
                      onClick={(e) => { e.stopPropagation(); if (el._spriteId) enterSprite(el._spriteId); }}
                      title={`Inside animated sprite #${el._spriteId} (${el._spriteFrameCount} frames) — click to enter`}
                      style={{
                        fontSize: '0.55rem', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
                        color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.3)',
                        cursor: 'pointer', marginRight: '4px',
                      }}
                    >
                      ⟳{el._spriteFrameCount}
                    </span>
                  )}
                  <div
                    style={{ display: 'flex', gap: '8px', opacity: selectedIds.includes(el.id) ? 1 : 0.4, flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleElementChange(el.id, { visible: !el.visible });
                    }}
                  >
                    {el.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '0.5rem' }}>
              {Object.values(library).map((item: any) => (
                <div
                  key={item.id || item.type + Math.random()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.6rem 0.75rem',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: '2px',
                    cursor: 'pointer',
                    backgroundColor: 'transparent',
                    opacity: 0.8
                  }}
                  onClick={() => {
                    if (item.type === 'sprite') enterSprite(item.id);
                  }}
                >
                  {item.type === 'sprite' ? <Maximize size={14} style={{ marginRight: '10px', color: 'var(--accent-primary)' }} /> : 
                   item.type === 'text' ? <Type size={14} style={{ marginRight: '10px' }} /> : 
                   item.type === 'script' ? <FileJson size={14} style={{ marginRight: '10px', color: 'var(--success)' }} /> :
                   <Square size={14} style={{ marginRight: '10px' }} />}
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {item.className ? item.className : `${item.type.toUpperCase()} #${item.id}`}
                    </span>
                    {item.type === 'sprite' && (
                        <span style={{ fontSize: '0.6rem', opacity: 0.5 }}>{item.frameCount} Frames</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-secondary"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              const newEl: GFXElement = {
                id: Math.random().toString(36).substr(2, 9),
                name: 'New Rectangle',
                type: 'rect',
                x: 100,
                y: 100,
                width: 100,
                height: 100,
                fill: '#6366f1',
                visible: true,
                locked: false,
                opacity: 1
              };
              const newHistory = [...elements, newEl];
              pushHistory(newHistory);
              setSelectedIds([newEl.id]);
            }}
          >
            <Square size={16} /> Rect
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              const newEl: GFXElement = {
                id: Math.random().toString(36).substr(2, 9),
                name: 'New Text',
                type: 'text',
                x: 150,
                y: 150,
                width: 200,
                height: 50,
                text: 'New Text Element',
                fill: '#ffffff',
                visible: true,
                locked: false,
                opacity: 1
              };
              const newHistory = [...elements, newEl];
              pushHistory(newHistory);
              setSelectedIds([newEl.id]);
            }}
          >
            <Type size={16} /> Text
          </button>
        </div>
      </aside>

      {/* Main Editor Section */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar — Row 1: file info + file actions */}
        <div className="toolbar">
          <div className="toolbar-row">
            {/* Left: file breadcrumb + meta */}
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-tertiary)', padding: '3px 10px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)', flexShrink: 0 }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-primary)', cursor: 'pointer' }} onClick={() => exitSprite(-1)}>GFX</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>/</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
              </div>

              {navigationStack.length > 0 && (
                <div className="breadcrumb scroll-thin" style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-secondary)', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', maxWidth: '220px', overflowX: 'auto', flexShrink: 1, whiteSpace: 'nowrap' }}>
                  {navigationStack.map((nav, i) => (
                    <React.Fragment key={`${nav.id}-${i}`}>
                      {i > 0 && <ChevronRight size={12} style={{ opacity: 0.5, flexShrink: 0 }} />}
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', color: i === navigationStack.length - 1 ? 'var(--text-primary)' : 'var(--text-secondary)', flexShrink: 0 }} onClick={() => exitSprite(i)}>
                        {nav.name}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}

              {gfxMeta && (
                <>
                  <div style={{ width: '1px', height: '18px', background: 'var(--border-color)', flexShrink: 0 }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                      <Maximize size={11} style={{ opacity: 0.5 }} />
                      <span style={{ fontWeight: 600 }}>{Math.round(gfxMeta.stageW || 0)}×{Math.round(gfxMeta.stageH || 0)}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                      <Settings size={11} style={{ opacity: 0.5 }} />
                      <span style={{ fontWeight: 600 }}>{gfxMeta.frameRate || 0} FPS</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                      <Layers size={11} style={{ opacity: 0.5 }} />
                      <span style={{ fontWeight: 600 }}>{gfxMeta.frameCount || 1} fr</span>
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Right: file-level actions */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
              {/* Live Mode */}
              <button
                className="btn btn-secondary"
                onClick={handleEnableLiveMode}
                title={liveEditMode
                  ? isNative ? `Live active → ${nativeLiveSourcePath}\nClick to disable` : `Live active → ${stagingDirName}\nClick to disable`
                  : isNative ? 'Enable Live Mode: auto-export to game file on save' : 'Enable Live Mode: auto-export to staging folder'}
                style={{ border: liveEditMode ? '1px solid #10b981' : undefined, color: liveEditMode ? '#10b981' : undefined, fontSize: '0.7rem', gap: '5px', padding: '5px 10px' }}
              >
                <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: liveEditMode ? '#10b981' : 'var(--text-muted)', flexShrink: 0 }} />
                {liveEditMode ? 'LIVE' : 'Live'}
                {liveEditMode && liveEditStatus !== 'idle' && (
                  <span style={{ fontSize: '0.6rem', color: liveEditStatus === 'saving' ? '#fb923c' : liveEditStatus === 'saved' ? '#10b981' : '#ef4444' }}>
                    {liveEditStatus === 'saving' ? '…' : liveEditStatus === 'saved' ? '✓' : '✗'}
                  </span>
                )}
              </button>
              {liveEditMode && (isNative ? nativeLiveSourcePath : stagingDirName) && (
                <span style={{ fontSize: '0.6rem', color: '#64748b', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={isNative ? `Game file: ${nativeLiveSourcePath}` : `Staging: ${stagingDirName}`}>
                  → {isNative ? nativeLiveSourcePath.split(/[\\/]/).pop() : stagingDirName}
                </span>
              )}
              <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />
              <button className="btn btn-secondary" onClick={handleNativeOpenFile} style={{ fontSize: '0.7rem', padding: '5px 10px', gap: '5px' }}>
                <FileJson size={14} /> Import
              </button>
              <button className="btn btn-secondary" onClick={handleExport} style={{ fontSize: '0.7rem', padding: '5px 10px', gap: '5px' }}>
                <Download size={14} /> Download
              </button>
              <button className="btn btn-primary" onClick={handleExport} style={{ fontSize: '0.7rem', padding: '5px 12px', gap: '5px' }}>
                <Save size={14} /> Export GFX
              </button>
              <input ref={fileInputRef} type="file" accept=".gfx,.swf" onChange={handleFileUpload} style={{ display: 'none' }} />
            </div>
          </div>

          {/* Toolbar — Row 2: editing tools */}
          <div className="toolbar-row">
            {/* Left: view toggle + undo/redo + add/delete */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div className="mode-toggle" style={{ display: 'flex', background: 'var(--bg-tertiary)', borderRadius: '20px', padding: '2px' }}>
                <button className={`btn btn-sm ${viewMode === 'canvas' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('canvas')} style={{ borderRadius: '18px', padding: '3px 10px', fontSize: '0.7rem' }}>
                  <Layout size={13} style={{ marginRight: '4px' }} /> Canvas
                </button>
                <button className={`btn btn-sm ${viewMode === 'code' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('code')} style={{ borderRadius: '18px', padding: '3px 10px', fontSize: '0.7rem' }}>
                  <FileJson size={13} style={{ marginRight: '4px' }} /> JSON
                </button>
              </div>

              <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />

              <div style={{ display: 'flex', gap: '0.25rem' }}>
                <button className="btn btn-secondary" style={{ padding: '5px', opacity: historyIndex > 0 ? 1 : 0.4 }} onClick={handleUndo} title="Undo (Ctrl+Z)" disabled={historyIndex <= 0}><Undo size={15} /></button>
                <button className="btn btn-secondary" style={{ padding: '5px', opacity: historyIndex < history.length - 1 ? 1 : 0.4 }} onClick={handleRedo} title="Redo (Ctrl+Y)" disabled={historyIndex >= history.length - 1}><Redo size={15} /></button>
              </div>

              <div style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />

              <div style={{ display: 'flex', gap: '0.25rem' }}>
                <button className="btn btn-secondary" style={{ padding: '5px 9px', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={handleAddRect} title="Add Rectangle">
                  <Square size={13} /> Rect
                </button>
                <button className="btn btn-secondary" style={{ padding: '5px 9px', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={handleAddText} title="Add Text">
                  <Type size={13} /> Text
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '5px 9px', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '4px', opacity: selectedIds.length > 0 ? 1 : 0.4, color: selectedIds.length > 0 ? '#ef4444' : undefined, borderColor: selectedIds.length > 0 ? '#ef4444' : undefined }}
                  onClick={handleDeleteSelected} title="Delete selected (Delete)" disabled={selectedIds.length === 0}
                >
                  ✕ Delete
                </button>
              </div>
            </div>

            {/* Right: canvas-level actions */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
              <button
                className="btn btn-secondary"
                onClick={() => { if (elements.length === 0) return; if (window.confirm('Clear all elements from the canvas?')) { pushHistory([]); setSelectedIds([]); } }}
                title="Clear canvas"
                style={{ fontSize: '0.7rem', gap: '5px', padding: '5px 10px' }}
              >
                <Trash2 size={13} /> Clear
              </button>
            </div>
          </div>
        </div>

        {/* Canvas/Code Area */}
        <div className="canvas-container" ref={canvasContainerRef} onClick={(e) => { if (e.target === e.currentTarget) handleSelect(null); }} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} style={{ display: 'flex', position: 'relative', overflow: 'hidden' }}>
          {viewMode === 'canvas' ? (
            <>
              <Stage
                width={canvasContainerRef.current?.clientWidth || (window.innerWidth - 580)}
                height={canvasContainerRef.current?.clientHeight || (window.innerHeight - 56)}
                ref={stageRef}
                scaleX={zoom}
                scaleY={zoom}
                x={panOffset.x}
                y={panOffset.y}
                draggable={false}
                onMouseDown={(e) => {
                  const stage = e.target.getStage();
                  const isBg = e.target === stage;

                  // Middle mouse → pan (anywhere on canvas)
                  if (e.evt.button === 1) {
                    isPanningRef.current = true;
                    panStartRef.current = { ox: panOffset.x, oy: panOffset.y, px: e.evt.clientX, py: e.evt.clientY };
                    e.evt.preventDefault();
                    return;
                  }

                  // Left click on empty background → start marquee tracking
                  if (isBg && e.evt.button === 0) {
                    const ptr = stage!.getPointerPosition();
                    if (ptr) {
                      selStartRef.current = { x: (ptr.x - stage!.x()) / stage!.scaleX(), y: (ptr.y - stage!.y()) / stage!.scaleY() };
                      isSelectingRef.current = true;
                      hasDraggedRef.current = false;
                    }
                  }
                }}
                onMouseMove={(e) => {
                  // Pan
                  if (isPanningRef.current) {
                    const dx = e.evt.clientX - panStartRef.current.px;
                    const dy = e.evt.clientY - panStartRef.current.py;
                    setPanOffset({ x: panStartRef.current.ox + dx, y: panStartRef.current.oy + dy });
                    return;
                  }

                  // Marquee selection
                  if (isSelectingRef.current) {
                    const stage = e.target.getStage();
                    const ptr = stage?.getPointerPosition();
                    if (ptr && stage) {
                      const pos = { x: (ptr.x - stage.x()) / stage.scaleX(), y: (ptr.y - stage.y()) / stage.scaleY() };
                      const sx = selStartRef.current.x;
                      const sy = selStartRef.current.y;
                      const dx = pos.x - sx;
                      const dy = pos.y - sy;
                      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        hasDraggedRef.current = true;
                        setSelectionBox({
                          visible: true, sx, sy,
                          x: Math.min(sx, pos.x), y: Math.min(sy, pos.y),
                          width: Math.abs(dx), height: Math.abs(dy),
                        });
                      }
                    }
                  }
                }}
                onMouseUp={(e) => {
                  // Pan end
                  if (isPanningRef.current) {
                    isPanningRef.current = false;
                    return;
                  }

                  // Marquee end
                  if (isSelectingRef.current) {
                    isSelectingRef.current = false;
                    if (hasDraggedRef.current && selectionBox?.visible) {
                      const bx1 = selectionBox.x, by1 = selectionBox.y;
                      const bx2 = bx1 + selectionBox.width, by2 = by1 + selectionBox.height;
                      const selected: string[] = [];
                      elements.forEach(el => {
                        if (!el.visible || el.locked) return;
                        // element.width/height are already visual size (scaleX baked in)
                        const ex1 = el.x, ey1 = el.y;
                        const ex2 = el.x + (el.width || 0);
                        const ey2 = el.y + (el.height || 0);
                        if (ex1 < bx2 && ex2 > bx1 && ey1 < by2 && ey2 > by1) selected.push(el.id);
                      });
                      if (e.evt.shiftKey) setSelectedIds(prev => Array.from(new Set([...prev, ...selected])));
                      else setSelectedIds(selected);
                    } else if (!hasDraggedRef.current) {
                      // Plain click on background → deselect
                      handleSelect(null);
                    }
                    setSelectionBox(null);
                  }
                }}
                onWheel={(e) => {
                  e.evt.preventDefault();
                  const scaleBy = 1.08;
                  const stage = e.target.getStage();
                  if (!stage) return;
                  const oldScale = zoom;
                  const pointer = stage.getPointerPosition();
                  if (!pointer) return;
                  const mousePointTo = {
                    x: (pointer.x - panOffset.x) / oldScale,
                    y: (pointer.y - panOffset.y) / oldScale,
                  };
                  const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
                  setZoom(newScale);
                  setPanOffset({
                    x: pointer.x - mousePointTo.x * newScale,
                    y: pointer.y - mousePointTo.y * newScale,
                  });
                }}
              >
                <Layer>
                  {elements.map((el) => (
                    <RenderElement
                      key={el.id}
                      element={el}
                      onSelect={(e) => handleSelect(el.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey)}
                      onChange={(newAttrs) => handleElementChange(el.id, newAttrs)}
                      onDragMove={(e) => handleDragMove(el.id, e)}
                      onDragEnd={(e) => handleDragEnd(el.id, e)}
                      onHoverEnter={hoverSimulation ? () => handleElementHover(el) : undefined}
                      onHoverLeave={hoverSimulation ? () => handleElementLeave(el) : undefined}
                      onElementClick={hoverSimulation ? () => {
                        if (avmRtRef.current && el.name) avmRtRef.current.dispatchEvent(el.name, 'click');
                      } : undefined}
                      isInteractive={hoverSimulation && (
                        ((el._spriteFrameCount ?? 1) > 1 && !!library[el._spriteId ?? 0]?.frameLabels?.some((l: any) => LABEL_CATS.hover.some(n => l.label.toLowerCase().startsWith(n))))
                        || !!(avmRtRef.current?.getOrCreateDisplayObject(el.name)?.eventListeners?.size)
                      )}
                    />
                  ))}
                  {selectedIds.length > 0 && <Transformer ref={trRef} boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < 5 || newBox.height < 5) return oldBox;
                    return newBox;
                  }} />}
                  {selectionBox?.visible && (
                    <Rect
                      x={selectionBox.x}
                      y={selectionBox.y}
                      width={selectionBox.width}
                      height={selectionBox.height}
                      fill="rgba(99, 102, 241, 0.2)"
                      stroke="#6366f1"
                      strokeWidth={1 / zoom}
                    />
                  )}
                </Layer>
              </Stage>

              {/* Zoom & View Controls Layer */}
              <div style={{ position: 'absolute', bottom: '20px', right: '20px', display: 'flex', gap: '10px' }}>
                <div className="glass-panel" style={{ display: 'flex', padding: '5px', gap: '5px', alignItems: 'center' }}>
                  <button className="btn btn-secondary" style={{ padding: '8px' }} onClick={() => {
                    setZoom(z => Math.min(z * 1.25, 5));
                  }}><Maximize size={16} /></button>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', fontSize: '0.8rem', fontWeight: 600, minWidth: '50px', justifyContent: 'center' }}>{Math.round(zoom * 100)}%</div>
                  <button className="btn btn-secondary" style={{ padding: '8px' }} onClick={() => {
                    setZoom(z => Math.max(z / 1.25, 0.05));
                  }}><Minimize size={16} /></button>
                  <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
                  <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.7rem', fontWeight: 600 }} onClick={() => {
                    if (canvasContainerRef.current) {
                      const containerW = canvasContainerRef.current.clientWidth;
                      const containerH = canvasContainerRef.current.clientHeight;
                      const fitZoom = Math.min(containerW / stageSize.width, containerH / stageSize.height) * 0.95;
                      setZoom(fitZoom);
                      setPanOffset({
                        x: (containerW - stageSize.width * fitZoom) / 2,
                        y: (containerH - stageSize.height * fitZoom) / 2
                      });
                    }
                  }}>FIT</button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, padding: '2rem', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="glass-panel" style={{ flex: 1, padding: '1rem', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>MODERN_UI_REPRESENTATION.JSON</span>
                  <span style={{ color: 'var(--success)' }}>Editable</span>
                </div>
                <textarea
                  value={JSON.stringify(elements, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      setElements(parsed);
                    } catch (err) { }
                  }}
                  onBlur={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      pushHistory(parsed);
                    } catch (err) { }
                  }}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    color: '#a5b4fc',
                    fontFamily: 'monospace',
                    resize: 'none',
                    outline: 'none',
                    fontSize: '0.9rem',
                    lineHeight: '1.5'
                  }}
                  className="scroll-thin"
                />
              </div>
            </div>
          )}
        </div>

        {/* Timeline Controls */}
        {(currentFrameCount > 1 || spriteFramesRef.current.size > 0) && (
           <div style={{ position: 'absolute', bottom: '16px', left: '16px', right: '16px', zIndex: 10 }}>
              <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', padding: '8px 16px', gap: '6px' }}>
                 {/* Top row: controls */}
                 <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {/* Play/Pause */}
                    <button
                      className={`btn btn-secondary ${isPlaying ? 'btn-primary' : ''}`}
                      style={{ padding: '5px 10px', minWidth: 52, fontSize: '0.7rem', fontWeight: 700 }}
                      onClick={() => setIsPlaying(!isPlaying)}
                    >
                      {isPlaying ? '⏸ PAUSE' : '▶ PLAY'}
                    </button>

                    {/* Loop toggle */}
                    <button
                      className={`btn btn-secondary ${isLooping ? 'btn-primary' : ''}`}
                      style={{ padding: '5px 8px', fontSize: '0.65rem', fontWeight: 700, opacity: isLooping ? 1 : 0.5 }}
                      onClick={() => setIsLooping(!isLooping)}
                      title="Toggle Loop"
                    >
                      ↻ LOOP
                    </button>

                    {/* Composite toggle */}
                    <button
                      className={`btn btn-secondary ${compositeMode ? 'btn-primary' : ''}`}
                      style={{ padding: '5px 8px', fontSize: '0.65rem', fontWeight: 700, opacity: compositeMode ? 1 : 0.5 }}
                      onClick={() => {
                        setCompositeMode(c => !c);
                        if (!compositeMode) {
                          const map = new Map<number, number>();
                          for (const [idStr, def] of Object.entries(library)) {
                            if ((def as any).type === 'sprite' && (def as any).frameCount > 1) map.set(parseInt(idStr), 0);
                          }
                          spriteFramesRef.current = map;
                        }
                      }}
                      title="Composite mode: animate all sprites simultaneously"
                    >
                      ◈ ALL
                    </button>

                    {/* Hover simulation toggle */}
                    <button
                      className={`btn btn-secondary ${hoverSimulation ? 'btn-primary' : ''}`}
                      style={{ padding: '5px 8px', fontSize: '0.65rem', fontWeight: 700, opacity: hoverSimulation ? 1 : 0.5, color: hoverSimulation ? '#60a5fa' : undefined }}
                      onClick={() => setHoverSimulation(h => !h)}
                      title="Hover simulation: mouse over canvas elements to trigger their hover animations"
                    >
                      ⊙ HOVER
                    </button>

                    {/* Preview entry */}
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '5px 8px', fontSize: '0.65rem', fontWeight: 700, color: '#4ade80' }}
                      onClick={previewEntry}
                      title="Reset all sprites to frame 0 and play entry animations"
                    >
                      ⟳ ENTRY
                    </button>

                    {/* Speed control */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {[0.25, 0.5, 1, 2].map(sp => (
                        <button
                          key={sp}
                          className={`btn btn-secondary ${playbackSpeed === sp ? 'btn-primary' : ''}`}
                          style={{ padding: '3px 6px', fontSize: '0.6rem', fontWeight: 700 }}
                          onClick={() => setPlaybackSpeed(sp)}
                        >
                          {sp}×
                        </button>
                      ))}
                    </div>

                    {/* Frame counter */}
                    <div style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      F {currentFrame + 1} / {currentFrameCount}
                      {gfxMeta && (
                        <span style={{ marginLeft: 8, opacity: 0.5 }}>
                          @ {Math.round((gfxMeta.frameRate || 30) * playbackSpeed)} fps
                        </span>
                      )}
                    </div>
                 </div>

                 {/* Scrubber + labels */}
                 <div style={{ position: 'relative' }}>
                    <input
                      type="range"
                      min="0"
                      max={currentFrameCount - 1}
                      value={currentFrame}
                      onChange={(e) => handleFrameChange(parseInt(e.target.value))}
                      style={{ width: '100%', height: '4px', margin: '2px 0' }}
                    />
                    {/* Frame label markers */}
                    {gfxMeta?.frameLabels?.length > 0 && (
                      <div style={{ position: 'relative', height: '16px', marginTop: '2px' }}>
                        {gfxMeta.frameLabels.map((lbl: any) => {
                          const pct = (lbl.offset / Math.max(1, currentFrameCount - 1)) * 100;
                          return (
                            <div
                              key={`${lbl.offset}-${lbl.name}`}
                              style={{
                                position: 'absolute',
                                left: `${pct}%`,
                                transform: 'translateX(-50%)',
                                fontSize: '0.5rem',
                                color: 'var(--accent-primary)',
                                fontWeight: 700,
                                whiteSpace: 'nowrap',
                                cursor: 'pointer',
                              }}
                              onClick={() => handleFrameChange(lbl.offset)}
                              title={`Jump to "${lbl.name}" (frame ${lbl.offset})`}
                            >
                              ▲ {lbl.name}
                            </div>
                          );
                        })}
                      </div>
                    )}
                 </div>
              </div>
           </div>
        )}
      </main>

      {/* Right Sidebar: Properties */}
      <aside className="property-panel">
        <div style={{ marginBottom: '1.5rem', flexShrink: 0 }}>
          <h2 style={{ fontSize: '0.9rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={18} color="var(--accent-primary)" />
            Properties
          </h2>
        </div>

        {selectedIds.length > 0 ? (
          <AnimatePresence mode="wait">
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="scroll-thin"
              style={{ overflowY: 'auto', flex: 1 }}
            >
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>Name {selectedIds.length > 1 && '(Multiple)'}</label>
                <input
                  type="text"
                  value={selectedIds.length === 1 ? elements.find(e => e.id === selectedIds[0])?.name : ''}
                  onChange={(e) => handleElementChange(selectedIds, { name: e.target.value })}
                  placeholder={selectedIds.length > 1 ? 'Multiple Selected...' : ''}
                  style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Position X</label>
                  <input
                    type="number"
                    value={Math.round(elements.find(e => e.id === selectedIds[0])?.x || 0)}
                    onChange={(e) => handleElementChange(selectedIds, { x: parseInt(e.target.value) })}
                    style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Position Y</label>
                  <input
                    type="number"
                    value={Math.round(elements.find(e => e.id === selectedIds[0])?.y || 0)}
                    onChange={(e) => handleElementChange(selectedIds, { y: parseInt(e.target.value) })}
                    style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                  />
                </div>
              </div>

              {(() => {
                const selEl = elements.find(e => e.id === selectedIds[0]);
                const isText = selEl?.type === 'text';
                const toHex = (css: string | undefined): string => {
                  if (!css) return '#ffffff';
                  if (/^#[0-9a-fA-F]{6}$/.test(css)) return css;
                  const m = css.match(/\d+/g);
                  if (!m || m.length < 3) return '#ffffff';
                  return '#' + [+m[0], +m[1], +m[2]].map(v => v.toString(16).padStart(2, '0')).join('');
                };
                return isText ? (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>Text Color</label>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <input
                        type="color"
                        value={toHex(selEl?.color)}
                        onChange={(ev) => {
                          const hex = ev.target.value;
                          const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
                          handleElementChange(selectedIds, { color: `rgb(${r},${g},${b})` });
                        }}
                        style={{ height: '38px', width: '60px', border: 'none', background: 'none' }}
                      />
                      <input
                        type="text"
                        value={selEl?.color || ''}
                        onChange={(ev) => handleElementChange(selectedIds, { color: ev.target.value })}
                        style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>Fill Color</label>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <input
                        type="color"
                        value={toHex(selEl?.fill)}
                        onChange={(ev) => handleElementChange(selectedIds, { fill: ev.target.value })}
                        style={{ height: '38px', width: '60px', border: 'none', background: 'none' }}
                      />
                      <input
                        type="text"
                        value={selEl?.fill || ''}
                        onChange={(ev) => handleElementChange(selectedIds, { fill: ev.target.value })}
                        style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                      />
                    </div>
                  </div>
                );
              })()}

              {selectedIds.length === 1 && elements.find(e => e.id === selectedIds[0])?.type === 'text' && (() => {
                const el = elements.find(e => e.id === selectedIds[0])!;
                return (
                  <div style={{ marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Text Content</label>
                      <textarea
                        value={el.text || ''}
                        onChange={(e) => handleElementChange(selectedIds, { text: e.target.value })}
                        style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px', height: '80px', resize: 'none' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Variable Name (ActionScript Map)</label>
                      <input
                        type="text"
                        value={el.variableName || ''}
                        onChange={(e) => handleElementChange(selectedIds, { variableName: e.target.value || undefined })}
                        placeholder="e.g. ammo_count"
                        style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                      />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Max Length</label>
                        <input
                          type="number"
                          min="0"
                          value={el.maxLength || ''}
                          onChange={(e) => handleElementChange(selectedIds, { maxLength: e.target.value ? parseInt(e.target.value) : undefined })}
                          placeholder="No limit"
                          style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '4px' }}
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '16px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!el.readOnly} onChange={(e) => handleElementChange(selectedIds, { readOnly: e.target.checked })} /> Read Only
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!el.password} onChange={(e) => handleElementChange(selectedIds, { password: e.target.checked })} /> Password
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!el.html} onChange={(e) => handleElementChange(selectedIds, { html: e.target.checked })} /> HTML Text
                        </label>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const el = elements.find(e => e.id === selectedIds[0]);
                const objOpacity = el?.opacity ?? 1;
                // Detect fill-color alpha (e.g. rgba(r,g,b,0.5))
                const fillAlpha = (() => {
                  const f = el?.fill;
                  if (!f) return null;
                  const m = f.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
                  return m ? parseFloat(m[1]) : null;
                })();
                const hasAlphaFill = fillAlpha !== null && fillAlpha < 0.999;
                return (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Opacity</label>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {Math.round(objOpacity * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0" max="1" step="0.01"
                      value={objOpacity}
                      onChange={(e) => handleElementChange(selectedIds, { opacity: parseFloat(e.target.value) })}
                      style={{ width: '100%' }}
                    />
                    {hasAlphaFill && (
                      <div style={{ marginTop: '6px', fontSize: '0.65rem', color: '#fb923c', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span>⚠</span>
                        <span>Fill color alpha: {Math.round(fillAlpha! * 100)}% — shape appears {Math.round(objOpacity * fillAlpha! * 100)}% opaque total</span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem', overflowY: 'auto', paddingRight: '4px' }} className="scroll-thin">
            <div style={{ background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <Layout size={16} color="var(--accent-primary)" />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{currentContext === 0 ? 'Document Root' : navigationStack[navigationStack.length-1]?.name}</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    Frame {currentFrame + 1} of {gfxMeta?.frameCount || 1}
                </div>
            </div>

            {/* Frame Script Map — shows all frames in the current context, dots = has script */}
            {currentFrameCount > 1 && (
              <div style={{ background: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <FileJson size={12} color="var(--accent-primary)" />
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Script Map</span>
                  {allFrameScripts.size > 0 && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
                      {allFrameScripts.size} scripted frame{allFrameScripts.size !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                  {Array.from({ length: currentFrameCount }, (_, i) => {
                    const hasScript = allFrameScripts.has(i);
                    const isCurrent = i === currentFrame;
                    return (
                      <div
                        key={i}
                        onClick={() => handleFrameChange(i)}
                        title={`Frame ${i + 1}${hasScript ? ' — has script' : ''}`}
                        style={{
                          width: '8px', height: '16px', borderRadius: '2px', cursor: 'pointer', flexShrink: 0,
                          background: isCurrent
                            ? 'var(--accent-primary)'
                            : hasScript
                              ? 'rgba(34, 197, 94, 0.7)'
                              : 'var(--bg-tertiary)',
                          outline: isCurrent ? '1px solid white' : hasScript ? '1px solid rgba(34,197,94,0.4)' : 'none',
                          transition: 'background 0.1s',
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Animations panel — list active animated sprites with controls */}
            {(() => {
              // Collect unique animated sprite IDs from current elements
              const animSprites: Map<number, {frameCount: number, frameLabels: any[], className?: string}> = new Map();
              for (const el of elements) {
                const sid = el._spriteId;
                const fc  = el._spriteFrameCount ?? 1;
                if (sid && fc > 1 && !animSprites.has(sid)) {
                  const def = library[sid];
                  animSprites.set(sid, { frameCount: fc, frameLabels: def?.frameLabels || [], className: def?.className });
                }
              }
              if (animSprites.size === 0) return null;
              return (
                <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0.6rem 0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#fb923c' }}>⟳ Animations</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                      {animSprites.size} sprite{animSprites.size !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {Array.from(animSprites.entries()).map(([spriteId, info]) => {
                    const curFrame = compositeMode ? (spriteFramesRef.current.get(spriteId) ?? 0) : 0;
                    return (
                      <div key={spriteId} style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '0.65rem', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {info.className || `Sprite #${spriteId}`}
                          </span>
                          <span style={{ fontSize: '0.55rem', color: '#fb923c', flexShrink: 0 }}>{info.frameCount}fr</span>
                          <button
                            onClick={() => enterSprite(spriteId)}
                            style={{ fontSize: '0.55rem', padding: '1px 6px', borderRadius: '3px', cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', flexShrink: 0 }}
                            title="Enter sprite timeline"
                          >Enter</button>
                        </div>
                        {/* Mini frame scrubber for this sprite */}
                        {compositeMode && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '0.55rem', color: 'var(--text-secondary)', flexShrink: 0, minWidth: '28px' }}>
                              {curFrame + 1}/{info.frameCount}
                            </span>
                            <input
                              type="range" min={0} max={info.frameCount - 1} value={curFrame}
                              onChange={e => jumpSpriteToFrame(spriteId, parseInt(e.target.value))}
                              style={{ flex: 1, height: '4px' }}
                            />
                          </div>
                        )}
                        {/* Frame labels — categorized by state */}
                        {info.frameLabels.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                            {info.frameLabels.map((lbl: any, li: number) => {
                              const cat = classifyLabel(lbl.label);
                              const c = CAT_COLORS[cat] || CAT_COLORS.unknown;
                              const isActive = compositeMode && (spriteFramesRef.current.get(spriteId) ?? 0) === lbl.frame;
                              return (
                                <button
                                  key={li}
                                  onClick={() => triggerSpriteLabel(spriteId, lbl.label)}
                                  title={`[${cat}] frame ${lbl.frame + 1}: "${lbl.label}"`}
                                  style={{
                                    fontSize: '0.55rem', padding: '1px 6px', borderRadius: '3px', cursor: 'pointer',
                                    background: isActive ? c.color : c.bg,
                                    border: `1px solid ${c.color}`,
                                    color: isActive ? '#000' : c.color,
                                    fontFamily: 'monospace',
                                    fontWeight: isActive ? 700 : 400,
                                  }}
                                >
                                  {lbl.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* Current frame action cards */}
            {currentScripts.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <FileJson size={14} color="var(--success)" />
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>
                          Frame {currentFrame + 1} Actions
                        </span>
                    </div>
                    {currentScripts.map((s, i) => (
                        <FrameActionCard
                          key={`${s._actionKey ?? i}`}
                          script={s}
                          parserRef={parserRef}
                          onExpand={() => setScriptEditorTarget(s)}
                          onPatched={() => {
                            // Refresh display after patching
                            if (getElementsRef.current) {
                              const { elements: fe, scripts: sc } = getElementsRef.current(currentFrame, currentContext);
                              setElements(fe);
                              setCurrentScripts(sc);
                            }
                          }}
                        />
                    ))}
                </div>
            ) : (
                <div style={{ textAlign: 'center', padding: '2rem 1rem', opacity: 0.4 }}>
                    <FileJson size={32} style={{ margin: '0 auto 0.75rem', display: 'block', opacity: 0.3 }} />
                    <p style={{ fontSize: '0.75rem' }}>No scripts on this frame.</p>
                    {allFrameScripts.size > 0 && (
                      <p style={{ fontSize: '0.65rem', marginTop: '0.5rem', color: 'var(--text-secondary)' }}>
                        Click a green bar above to jump to a scripted frame.
                      </p>
                    )}
                </div>
            )}
          </div>
        )}
      </aside>
      </div>{/* end GFX editor flex row */}
    </div>{/* end outer column wrapper */}

    {/* Script Editor Modal */}
    {scriptEditorTarget && (
      <ScriptEditorModal
        script={scriptEditorTarget}
        parserRef={parserRef}
        onClose={() => setScriptEditorTarget(null)}
        onPatched={() => {
          setScriptEditorTarget(null);
          if (getElementsRef.current) {
            const { elements: fe, scripts: sc } = getElementsRef.current(currentFrame, currentContext);
            setElements(fe);
            setCurrentScripts(sc);
          }
        }}
      />
    )}
    </>
  );
};

// --- Sub-components ---

const ACTION_TYPE_LABELS: Record<string, string> = {
  stop: 'Stop', play: 'Play', nextFrame: 'NextFrame', prevFrame: 'PrevFrame',
  gotoFrame: 'GotoFrame', gotoLabel: 'GotoLabel', gotoAndPlay: 'GotoAndPlay', gotoAndStop: 'GotoAndStop',
};
const ACTION_COLORS: Record<string, { color: string; bg: string }> = {
  stop:        { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  play:        { color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  nextFrame:   { color: '#4ade80', bg: 'rgba(74,222,128,0.08)' },
  prevFrame:   { color: '#4ade80', bg: 'rgba(74,222,128,0.08)' },
  gotoFrame:   { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  gotoLabel:   { color: '#c084fc', bg: 'rgba(192,132,252,0.12)' },
  gotoAndPlay: { color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  gotoAndStop: { color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  raw:         { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};
const SIMPLE_ACTION_TYPES = ['stop', 'play', 'nextFrame', 'prevFrame'];
const LABEL_ACTION_TYPES  = ['gotoLabel', 'gotoAndPlay', 'gotoAndStop'];

interface FrameActionCardProps {
  script: any;
  parserRef: React.RefObject<GFXParser | null>;
  onPatched: () => void;
  onExpand?: () => void;
}

const FrameActionCard: React.FC<FrameActionCardProps> = ({ script, parserRef, onPatched, onExpand }) => {
  const isAVM2 = script.abc instanceof Uint8Array || script.scriptType === 'AS3';
  const rawSize = script.data?.length ?? script.abc?.length ?? 0;
  const dis: string = script.disassembly || '';

  // Parsed structured actions (from raw bytes)
  const parsedActions = React.useMemo<EditableAction[]>(() => {
    if (isAVM2) return [];
    const raw: Uint8Array = script.data instanceof Uint8Array ? script.data : new Uint8Array(script.data || []);
    return parseAS2Actions(raw);
  }, [script.data, isAVM2]);

  const [editMode, setEditMode]     = React.useState(false);
  const [editActions, setEditActions] = React.useState<EditableAction[]>([]);
  const [rawExpanded, setRawExpanded] = React.useState(false);
  const [applyError, setApplyError]   = React.useState('');

  const startEdit = () => {
    setEditActions(parsedActions.map(a => ({ ...a } as EditableAction)));
    setEditMode(true);
    setApplyError('');
  };

  const cancelEdit = () => { setEditMode(false); setApplyError(''); };

  const applyEdit = () => {
    const patcher = parserRef.current?._patcher;
    if (!patcher) { setApplyError('No patcher available.'); return; }
    if (!script._actionKey) { setApplyError('No action key — cannot locate this tag in the binary.'); return; }
    const newBody = encodeAS2Actions(editActions);
    const ok = patcher.patchActionBody(script._actionKey, newBody);
    if (!ok) { setApplyError(`Key "${script._actionKey}" not found in binary. Was the file reloaded?`); return; }
    setEditMode(false);
    setApplyError('');
    onPatched();
  };

  const updateAction = (idx: number, next: EditableAction) => {
    setEditActions(prev => prev.map((a, i) => i === idx ? next : a));
  };

  const removeAction = (idx: number) => {
    setEditActions(prev => prev.filter((_, i) => i !== idx));
  };

  const addAction = () => {
    setEditActions(prev => [...prev, { type: 'stop' }]);
  };

  const changeType = (idx: number, newType: string) => {
    const defaults: Record<string, EditableAction> = {
      stop: { type: 'stop' }, play: { type: 'play' },
      nextFrame: { type: 'nextFrame' }, prevFrame: { type: 'prevFrame' },
      gotoFrame: { type: 'gotoFrame', frame: 0 },
      gotoLabel: { type: 'gotoLabel', label: '' },
      gotoAndPlay: { type: 'gotoAndPlay', label: '' },
      gotoAndStop: { type: 'gotoAndStop', label: '' },
    };
    updateAction(idx, defaults[newType] ?? { type: 'stop' });
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
    color: 'white', padding: '3px 6px', borderRadius: '3px', fontSize: '0.65rem',
    fontFamily: 'monospace', minWidth: 0,
  };
  const btnStyle = (accent?: string): React.CSSProperties => ({
    fontSize: '0.6rem', padding: '2px 8px', borderRadius: '3px', cursor: 'pointer',
    border: `1px solid ${accent ?? 'var(--border-color)'}`,
    background: accent ? `${accent}18` : 'transparent',
    color: accent ?? 'var(--text-secondary)',
  });

  return (
    <div style={{ background: 'var(--bg-tertiary)', border: `1px solid ${editMode ? 'var(--accent-primary)' : 'var(--border-color)'}`, borderRadius: '6px', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border-color)' }}>
        <span style={{ fontSize: '0.6rem', fontWeight: 700, opacity: 0.5 }}>TAG {script.type}</span>
        <span style={{
          fontSize: '0.55rem', padding: '1px 5px', borderRadius: '3px',
          color: isAVM2 ? '#c084fc' : '#60a5fa',
          background: isAVM2 ? 'rgba(192,132,252,0.1)' : 'rgba(96,165,250,0.1)',
          fontWeight: 600,
        }}>{isAVM2 ? 'AVM2' : 'AVM1'}</span>
        {rawSize > 0 && <span style={{ fontSize: '0.55rem', opacity: 0.35 }}>{rawSize}B</span>}
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          {!editMode && onExpand && (
            <button onClick={onExpand} style={btnStyle()} title="Open in Script Editor">⤢</button>
          )}
          {!isAVM2 && !editMode && script._actionKey && (
            <button onClick={startEdit} style={btnStyle('var(--accent-primary)')}>Edit</button>
          )}
          {!editMode && (
            <button onClick={() => setRawExpanded(e => !e)} style={btnStyle()}>
              {rawExpanded ? 'Hide' : 'Raw'}
            </button>
          )}
          {editMode && (
            <>
              <button onClick={cancelEdit} style={btnStyle()}>Cancel</button>
              <button onClick={applyEdit} style={btnStyle('#4ade80')}>Apply</button>
            </>
          )}
        </div>
      </div>

      {/* Edit mode: action list */}
      {editMode ? (
        <div style={{ padding: '0.6rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {editActions.map((action, idx) => {
            const { color } = ACTION_COLORS[action.type] ?? ACTION_COLORS.raw;
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {/* Type selector */}
                <select
                  value={action.type === 'raw' ? 'raw' : action.type}
                  onChange={e => changeType(idx, e.target.value)}
                  style={{ ...inputStyle, color, flexShrink: 0 }}
                >
                  {Object.entries(ACTION_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                  {action.type === 'raw' && <option value="raw">[Raw]</option>}
                </select>

                {/* Arg input */}
                {action.type === 'gotoFrame' && (
                  <input
                    type="number" min={1}
                    value={(action.frame ?? 0) + 1}
                    onChange={e => updateAction(idx, { type: 'gotoFrame', frame: Math.max(0, parseInt(e.target.value) - 1) || 0 })}
                    style={{ ...inputStyle, width: '60px' }}
                    title="Frame number (1-based)"
                  />
                )}
                {(LABEL_ACTION_TYPES.includes(action.type)) && (
                  <input
                    type="text"
                    value={'label' in action ? action.label : ''}
                    onChange={e => updateAction(idx, { ...action, label: e.target.value } as EditableAction)}
                    placeholder="label name"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                )}
                {action.type === 'raw' && (
                  <span style={{ fontSize: '0.55rem', opacity: 0.4, flex: 1 }}>
                    [{action.bytes.length}B raw — not editable]
                  </span>
                )}

                {/* Remove */}
                <button
                  onClick={() => removeAction(idx)}
                  style={{ ...btnStyle('#f87171'), flexShrink: 0, padding: '1px 6px' }}
                  title="Remove action"
                >✕</button>
              </div>
            );
          })}
          <button onClick={addAction} style={{ ...btnStyle(), marginTop: '4px', alignSelf: 'flex-start', padding: '3px 10px' }}>
            + Add Action
          </button>
          {applyError && (
            <p style={{ fontSize: '0.6rem', color: '#f87171', margin: '4px 0 0' }}>{applyError}</p>
          )}
        </div>
      ) : (
        /* View mode: action badges */
        parsedActions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '0.5rem 0.75rem', borderBottom: rawExpanded ? '1px solid var(--border-color)' : 'none' }}>
            {parsedActions.map((action, j) => {
              const { color, bg } = ACTION_COLORS[action.type] ?? ACTION_COLORS.raw;
              let label = ACTION_TYPE_LABELS[action.type] ?? action.type;
              if (action.type === 'gotoFrame')   label += `(${action.frame + 1})`;
              if ('label' in action)              label += `("${action.label}")`;
              if (action.type === 'raw')          label = `[Raw ${action.bytes.length}B]`;
              return (
                <span key={j} style={{
                  fontSize: '0.6rem', padding: '2px 8px', borderRadius: '4px', fontFamily: 'monospace', fontWeight: 600,
                  color, background: bg, border: `1px solid ${color}44`,
                }}>{label}</span>
              );
            })}
          </div>
        ) : null
      )}

      {/* Raw disassembly */}
      {!editMode && rawExpanded && (
        <pre style={{
          margin: 0, padding: '0.6rem 0.75rem', fontSize: '0.6rem', fontFamily: 'monospace', lineHeight: 1.6,
          color: '#86efac', background: '#0a0f0a', overflowX: 'auto', overflowY: 'auto',
          maxHeight: '260px', whiteSpace: 'pre',
        }}>
          {dis || `[No disassembly — raw bytecode: ${rawSize} bytes]`}
        </pre>
      )}
    </div>
  );
};

// ─── Script Editor Modal ──────────────────────────────────────────────────────

interface ScriptEditorModalProps {
  script: any;
  parserRef: React.RefObject<GFXParser | null>;
  onClose: () => void;
  onPatched: () => void;
}

const ScriptEditorModal: React.FC<ScriptEditorModalProps> = ({ script, parserRef, onClose, onPatched }) => {
  const isAVM2 = script.abc instanceof Uint8Array || script.scriptType === 'AS3';
  const rawData = React.useMemo<Uint8Array>(() => {
    if (script.data instanceof Uint8Array) return script.data;
    if (script.abc instanceof Uint8Array) return script.abc;
    if (Array.isArray(script.data)) return new Uint8Array(script.data);
    return new Uint8Array();
  }, [script]);

  const [activeTab, setActiveTab] = React.useState<'dis' | 'hex' | 'actions' | 'as3'>('dis');
  const [hexText, setHexText]         = React.useState('');
  const [hexError, setHexError]       = React.useState('');
  const [editActions, setEditActions] = React.useState<EditableAction[]>([]);
  const [actionsError, setActionsError] = React.useState('');
  const [as3Source, setAs3Source]     = React.useState('// AS3 source not yet decompiled.\n// Edit here, then click Compile & Save.');
  const [as3Error, setAs3Error]       = React.useState('');
  const [as3Status, setAs3Status]     = React.useState('');

  React.useEffect(() => {
    // Format hex as 16 bytes per line
    const lines: string[] = [];
    for (let i = 0; i < rawData.length; i += 16) {
      lines.push(Array.from(rawData.slice(i, i + 16))
        .map(b => b.toString(16).padStart(2, '0')).join(' '));
    }
    setHexText(lines.join('\n'));
    if (!isAVM2) {
      setEditActions(parseAS2Actions(rawData).map(a => ({ ...a } as EditableAction)));
    } else {
      try {
        const src = decompileABCClass(rawData, script._className ?? '');
        setAs3Source(src);
      } catch (e) {
        setAs3Source(`// Decompile error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, [rawData, isAVM2]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const patchScript = (newBytes: Uint8Array): boolean => {
    const patcher = parserRef.current?._patcher;
    if (!patcher) return false;
    if (isAVM2 && script._abcKey) return patcher.patchDoABC(script._abcKey, newBytes);
    if (script._actionKey)        return patcher.patchActionBody(script._actionKey, newBytes);
    return false;
  };

  const canPatch = isAVM2 ? !!script._abcKey : !!script._actionKey;

  const applyHex = () => {
    try {
      const tokens = hexText.trim().split(/[\s\n]+/).filter(Boolean);
      const bytes = tokens.map(h => {
        const n = parseInt(h, 16);
        if (isNaN(n) || n < 0 || n > 255) throw new Error(`Invalid hex byte: "${h}"`);
        return n;
      });
      const patcher = parserRef.current?._patcher;
      if (!patcher) { setHexError('No patcher available.'); return; }
      if (!canPatch) { setHexError('No patch key — cannot modify.'); return; }
      const ok = patchScript(new Uint8Array(bytes));
      if (!ok) { setHexError('Patch key not found in binary. Was the file reloaded?'); return; }
      setHexError('');
      onPatched();
    } catch (e: any) { setHexError(e.message); }
  };

  const applyActions = () => {
    const patcher = parserRef.current?._patcher;
    if (!patcher) { setActionsError('No patcher available.'); return; }
    if (!script._actionKey) { setActionsError('No action key.'); return; }
    const ok = patcher.patchActionBody(script._actionKey, encodeAS2Actions(editActions));
    if (!ok) { setActionsError('Key not found in binary.'); return; }
    setActionsError('');
    onPatched();
  };

  const compileAndSave = () => {
    setAs3Error('');
    setAs3Status('');
    try {
      const patcher = parserRef.current?._patcher;
      if (!patcher) { setAs3Error('No patcher available.'); return; }
      if (!script._abcKey) { setAs3Error('No ABC key — cannot patch.'); return; }

      // Compile the edited source to a new single-class ABC
      const cls = parseAS3(as3Source);
      const newABCFile = compileAS3(cls);
      const newClassBytes = serialiseABC(newABCFile);

      // Merge the compiled class back into the ORIGINAL full ABC
      // (the DoABC tag may contain many classes — we only replace the target one)
      const origABCBytes = rawData; // rawData = the full ABC bytes for this DoABC tag
      const mergedBytes = mergeClassIntoABC(origABCBytes, newClassBytes, script._className ?? cls.name);

      const ok = patcher.patchDoABC(script._abcKey, mergedBytes);
      if (!ok) { setAs3Error(`ABC key "${script._abcKey}" not found in binary.`); return; }
      setAs3Status(`Compiled & merged ${mergedBytes.length} bytes → ${script._abcKey}`);
      onPatched();
    } catch (e: any) {
      setAs3Error((e as Error).message ?? String(e));
    }
  };

  const monoFont = '"Cascadia Code","Fira Code","Consolas",monospace';
  const codeStyle: React.CSSProperties = {
    flex: 1, margin: 0, padding: '16px', fontSize: '0.72rem', fontFamily: monoFont,
    lineHeight: 1.7, overflow: 'auto', whiteSpace: 'pre', background: '#070a07',
    color: isAVM2 ? '#c4b5fd' : '#86efac',
  };

  const tabs = [
    { id: 'dis',     label: 'Disassembly' },
    { id: 'hex',     label: 'Hex Editor'  },
    ...(!isAVM2 ? [{ id: 'actions', label: 'Actions'    }] : []),
    ...(isAVM2  ? [{ id: 'as3',     label: 'AS3 Source' }] : []),
  ] as { id: 'dis' | 'hex' | 'actions' | 'as3'; label: string }[];

  const btnSm = (col?: string): React.CSSProperties => ({
    padding: '4px 14px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', borderRadius: '4px',
    border: `1px solid ${col ?? '#2d2d33'}`,
    background: col ? `${col}18` : 'transparent',
    color: col ?? '#94a3b8',
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#141417', border: '1px solid #2d2d33', borderRadius: '10px', width: '90vw', maxWidth: '1150px', height: '84vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderBottom: '1px solid #2d2d33', flexShrink: 0 }}>
          <FileJson size={16} color={isAVM2 ? '#c084fc' : '#60a5fa'} />
          <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Script Editor</span>
          <span style={{ fontSize: '0.6rem', padding: '2px 8px', borderRadius: '4px', fontWeight: 700, color: isAVM2 ? '#c084fc' : '#60a5fa', background: isAVM2 ? 'rgba(192,132,252,0.12)' : 'rgba(96,165,250,0.12)' }}>
            {isAVM2 ? 'AVM2 / AS3' : 'AVM1 / AS2'}
          </span>
          <span style={{ fontSize: '0.6rem', opacity: 0.35 }}>{rawData.length} bytes</span>
          {(script._actionKey || script._abcKey) && (
            <span style={{ fontSize: '0.55rem', opacity: 0.3, fontFamily: monoFont }}>
              key: {script._abcKey ?? script._actionKey}
            </span>
          )}
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#64748b', fontSize: '1.1rem', cursor: 'pointer', padding: '2px 6px', borderRadius: '4px' }}>✕</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #2d2d33', flexShrink: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              padding: '8px 22px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
              background: activeTab === t.id ? '#1a1a22' : 'transparent',
              border: 'none', borderBottom: activeTab === t.id ? '2px solid #6366f1' : '2px solid transparent',
              color: activeTab === t.id ? '#e2e8f0' : '#64748b',
            }}>{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {/* Disassembly tab */}
          {activeTab === 'dis' && (
            <pre style={codeStyle}>
              {script.disassembly || `[No disassembly — ${rawData.length} bytes raw bytecode]`}
            </pre>
          )}

          {/* Hex Editor tab */}
          {activeTab === 'hex' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px', gap: '8px', overflow: 'hidden', background: '#09090d' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                  Hex bytes — 16 per line. Edit then Apply to patch the binary.
                </span>
                {isAVM2 && (
                  <span style={{ fontSize: '0.65rem', color: '#fbbf24' }}>⚠ Editing AVM2 bytecode may corrupt the file.</span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6rem', color: '#475569', fontFamily: monoFont }}>{rawData.length} B</span>
                  {canPatch
                    ? <button onClick={applyHex} style={btnSm('#4ade80')}>Apply</button>
                    : <span style={{ fontSize: '0.65rem', color: '#475569' }}>Read-only</span>
                  }
                </div>
              </div>
              {hexError && <p style={{ fontSize: '0.65rem', color: '#f87171', margin: 0, flexShrink: 0 }}>{hexError}</p>}
              <textarea
                value={hexText}
                onChange={e => setHexText(e.target.value)}
                readOnly={!canPatch}
                spellCheck={false}
                style={{
                  flex: 1, fontFamily: monoFont, fontSize: '0.7rem', lineHeight: 1.9,
                  background: '#070a07', border: '1px solid #1e2820', borderRadius: '6px',
                  color: '#86efac', padding: '14px', resize: 'none', outline: 'none',
                  opacity: !canPatch ? 0.6 : 1,
                }}
              />
            </div>
          )}

          {/* Actions tab (AS2 only) */}
          {activeTab === 'actions' && !isAVM2 && (
            <div style={{ flex: 1, overflow: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px', background: '#09090d' }}>
              {editActions.map((action, idx) => {
                const { color } = ACTION_COLORS[action.type] ?? ACTION_COLORS.raw;
                const inp: React.CSSProperties = {
                  background: '#141417', border: '1px solid #2d2d33', color: 'white',
                  padding: '5px 9px', borderRadius: '4px', fontSize: '0.72rem', fontFamily: monoFont,
                };
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', background: '#141417', borderRadius: '6px', border: '1px solid #222228' }}>
                    <span style={{ fontSize: '0.6rem', opacity: 0.3, minWidth: '28px', fontFamily: monoFont, textAlign: 'right' }}>{idx}</span>
                    <select value={action.type}
                      onChange={e => {
                        const defs: Record<string, EditableAction> = {
                          stop:{type:'stop'}, play:{type:'play'}, nextFrame:{type:'nextFrame'}, prevFrame:{type:'prevFrame'},
                          gotoFrame:{type:'gotoFrame',frame:0}, gotoLabel:{type:'gotoLabel',label:''},
                          gotoAndPlay:{type:'gotoAndPlay',label:''}, gotoAndStop:{type:'gotoAndStop',label:''},
                        };
                        setEditActions(prev => prev.map((a, i) => i === idx ? (defs[e.target.value] ?? {type:'stop'}) : a));
                      }}
                      style={{ ...inp, color }}
                    >
                      {Object.entries(ACTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      {action.type === 'raw' && <option value="raw">[Raw]</option>}
                    </select>
                    {action.type === 'gotoFrame' && (
                      <input type="number" min={1} value={(action.frame ?? 0) + 1}
                        onChange={e => setEditActions(prev => prev.map((a, i) => i === idx ? { type:'gotoFrame', frame: Math.max(0, parseInt(e.target.value)-1)||0 } : a))}
                        style={{ ...inp, width: '80px' }} />
                    )}
                    {LABEL_ACTION_TYPES.includes(action.type) && (
                      <input type="text" value={'label' in action ? action.label : ''}
                        onChange={e => setEditActions(prev => prev.map((a, i) => i === idx ? { ...a, label: e.target.value } as EditableAction : a))}
                        placeholder="label name" style={{ ...inp, flex: 1 }} />
                    )}
                    {action.type === 'raw' && (
                      <span style={{ fontSize: '0.6rem', opacity: 0.3, flex: 1 }}>[{(action as any).bytes?.length ?? 0}B raw]</span>
                    )}
                    <button onClick={() => setEditActions(prev => prev.filter((_,i) => i!==idx))}
                      style={{ background:'rgba(248,113,113,0.1)', border:'1px solid #f8717140', color:'#f87171', padding:'3px 8px', borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer' }}>✕</button>
                  </div>
                );
              })}
              <div style={{ display:'flex', gap:'8px', marginTop:'8px', flexShrink:0 }}>
                <button onClick={() => setEditActions(prev => [...prev, {type:'stop'}])}
                  style={btnSm('#6366f1')}>+ Add Action</button>
                <button onClick={applyActions} style={btnSm('#4ade80')}>Apply</button>
                {actionsError && <span style={{ fontSize:'0.65rem', color:'#f87171', alignSelf:'center' }}>{actionsError}</span>}
              </div>
            </div>
          )}

          {/* AS3 Source tab (AVM2 only) */}
          {activeTab === 'as3' && isAVM2 && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px', gap: '8px', overflow: 'hidden', background: '#09090d' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                  Edit AS3 source, then Compile &amp; Save to rewrite the DoABC tag.
                </span>
                {!script._abcKey && (
                  <span style={{ fontSize: '0.65rem', color: '#fbbf24' }}>⚠ No abc key — save disabled.</span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {script._abcKey && (
                    <button onClick={compileAndSave} style={btnSm('#c084fc')}>Compile &amp; Save</button>
                  )}
                </div>
              </div>
              {as3Error  && <p style={{ fontSize: '0.65rem', color: '#f87171', margin: 0, flexShrink: 0 }}>{as3Error}</p>}
              {as3Status && <p style={{ fontSize: '0.65rem', color: '#4ade80', margin: 0, flexShrink: 0 }}>{as3Status}</p>}
              <textarea
                value={as3Source}
                onChange={e => { setAs3Source(e.target.value); setAs3Error(''); setAs3Status(''); }}
                spellCheck={false}
                style={{
                  flex: 1, fontFamily: '"Cascadia Code","Fira Code","Consolas",monospace',
                  fontSize: '0.72rem', lineHeight: 1.8,
                  background: '#070a07', border: '1px solid #2d1a3a', borderRadius: '6px',
                  color: '#c4b5fd', padding: '14px', resize: 'none', outline: 'none',
                }}
              />
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

interface RenderElementProps {
  element: GFXElement;
  onSelect: (e: any) => void;
  onChange: (attrs: Partial<GFXElement>) => void;
  onDragMove: (e: any) => void;
  onDragEnd: (e: any) => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  onElementClick?: () => void;
  /** When true, renders a subtle dashed outline indicating hover-interactive element */
  isInteractive?: boolean;
}

const RenderElement: React.FC<RenderElementProps> = ({ element, onSelect, onChange, onDragMove, onDragEnd, onHoverEnter, onHoverLeave, onElementClick, isInteractive }) => {
  const shapeRef = useRef<any>(null);

  if (!element.visible) return null;

  const interactiveStroke = isInteractive ? { stroke: '#f97316', strokeWidth: 1.5, dash: [4, 2] } : {};

  const commonProps = {
    id: element.id,
    x: element.x,
    y: element.y,
    scaleX: element.scaleX || 1,
    scaleY: element.scaleY || 1,
    rotation: (element.rotate0 || 0) * (180 / Math.PI),
    opacity: element.opacity,
    draggable: !element.locked,
    onClick: onElementClick ? (e: any) => { onElementClick(); onSelect(e); } : onSelect,
    onTap: onSelect,
    ref: shapeRef,
    onDragMove: onDragMove,
    onDragEnd: onDragEnd,
    onMouseEnter: onHoverEnter,
    onMouseLeave: onHoverLeave,
    onTransformEnd: (e: any) => {
      const node = shapeRef.current;
      const newScaleX = node.scaleX();
      const newScaleY = node.scaleY();

      // Persist the new accumulated scale AND the new visual size.
      // Path elements ignore element.width/height for rendering — they rely on
      // scaleX/scaleY — so we must update scale here or they snap back.
      // Rect elements use width/scaleX as intrinsic width, which also stays
      // correct: (old_w * drag) / (old_scaleX * drag) = old_w / old_scaleX.
      onChange({
        x: node.x(),
        y: node.y(),
        scaleX: newScaleX,
        scaleY: newScaleY,
        width: Math.max(5, node.width() * Math.abs(newScaleX)),
        height: Math.max(5, node.height() * Math.abs(newScaleY)),
      });
    },
  };

  if (element.type === 'rect') {
    const toKonvaStops = (stops: Array<{offset:number,r:number,g:number,b:number,a:number}>) =>
      stops.flatMap(s => [s.offset, `rgba(${s.r},${s.g},${s.b},${s.a.toFixed(3)})`]);

    // If we have an SVG path, render it as a proper vector shape
    if (element.svgPath) {
      const gf = element.gradientFill;
      const slb = element.shapeLocalBounds;
      if (gf && slb && gf.stops.length >= 2) {
        const stops = toKonvaStops(gf.stops);
        const cx = slb.x + slb.w / 2;
        const cy = slb.y + slb.h / 2;
        if (gf.type === 'radial') {
          return <Path
            {...commonProps}
            data={element.svgPath}
            fillRadialGradientStartPoint={{ x: cx, y: cy }}
            fillRadialGradientEndPoint={{ x: cx, y: cy }}
            fillRadialGradientStartRadius={0}
            fillRadialGradientEndRadius={Math.max(slb.w, slb.h) / 2}
            fillRadialGradientColorStops={stops}
            stroke={isInteractive ? '#f97316' : element.stroke}
            strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
            dash={isInteractive ? [4, 2] : undefined}
          />;
        }
        return <Path
          {...commonProps}
          data={element.svgPath}
          fillLinearGradientStartPoint={{ x: slb.x, y: cy }}
          fillLinearGradientEndPoint={{ x: slb.x + slb.w, y: cy }}
          fillLinearGradientColorStops={stops}
          stroke={isInteractive ? '#f97316' : element.stroke}
          strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
          dash={isInteractive ? [4, 2] : undefined}
        />;
      }
      return <Path
        {...commonProps}
        data={element.svgPath}
        fill={element.fill === 'transparent' ? undefined : element.fill}
        stroke={isInteractive ? '#f97316' : element.stroke}
        strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
        dash={isInteractive ? [4, 2] : undefined}
      />;
    }

    const gf = element.gradientFill;
    if (gf && gf.stops.length >= 2) {
      const stops = toKonvaStops(gf.stops);
      const w = element.width / Math.abs(element.scaleX || 1);
      const h = element.height / Math.abs(element.scaleY || 1);
      if (gf.type === 'radial') {
        return <Rect
          {...commonProps}
          width={w}
          height={h}
          fillRadialGradientStartPoint={{ x: w / 2, y: h / 2 }}
          fillRadialGradientEndPoint={{ x: w / 2, y: h / 2 }}
          fillRadialGradientStartRadius={0}
          fillRadialGradientEndRadius={Math.max(w, h) / 2}
          fillRadialGradientColorStops={stops}
          stroke={isInteractive ? '#f97316' : element.stroke}
          strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
          dash={isInteractive ? [4, 2] : undefined}
        />;
      }
      return <Rect
        {...commonProps}
        width={w}
        height={h}
        fillLinearGradientStartPoint={{ x: 0, y: h / 2 }}
        fillLinearGradientEndPoint={{ x: w, y: h / 2 }}
        fillLinearGradientColorStops={stops}
        stroke={isInteractive ? '#f97316' : element.stroke}
        strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
        dash={isInteractive ? [4, 2] : undefined}
      />;
    }

    return <Rect
      {...commonProps}
      width={element.width / Math.abs(element.scaleX || 1)}
      height={element.height / Math.abs(element.scaleY || 1)}
      fill={element.fill}
      stroke={isInteractive ? '#f97316' : element.stroke}
      strokeWidth={isInteractive ? 1.5 : (element.strokeWidth || 0)}
      dash={isInteractive ? [4, 2] : undefined}
    />;
  }

  if (element.type === 'text') {
    return <Text
      {...commonProps}
      text={element.text || '[Dynamic Text]'}
      width={element.width / Math.abs(element.scaleX || 1)}
      height={element.height / Math.abs(element.scaleY || 1)}
      fill={element.color || element.fill || '#ffffff'}
      fontSize={(element.fontSize || 14) * 0.75}
      fontFamily="Inter, Arial, sans-serif"
      align={element.align || 'left'}
      verticalAlign="middle"
      lineHeight={1}
      letterSpacing={element.letterSpacing || 0}
      wrap={element.wordWrap ? 'word' : 'none'}
      stroke={isInteractive ? '#f97316' : undefined}
      strokeWidth={isInteractive ? 1 : undefined}
    />;
  }

  return null;
};

export default App;
