/**
 * Texture Pack Editor
 * Loads Halo MCC .perm.bin + .temp.bin, shows a texture grid,
 * lets users import PNG/DDS replacements, and saves the modified pack.
 */
import React, { useState, useRef, useCallback } from 'react';
import {
  Upload,
  Download,
  Save,
  Image,
  RefreshCw,
  X,
  ChevronLeft,
  FileImage,
  Info,
} from 'lucide-react';
import {
  parsePerm,
  loadPixels,
  makeDDS,
  writePackPatches,
  type TextureEntry,
  type PatchedTexture,
  TexFmt,
} from '../lib/texturePack';
import { decodeDDSPixels, decodedToDataURL, parseDDSHeader, stripDDSHeader } from '../lib/ddsDecoder';

// ─── Format display helpers ────────────────────────────────────────────────

const FMT_NAMES: Record<number, string> = {
  [TexFmt.A8R8G8B8]:     'A8R8G8B8',
  [TexFmt.DXT1]:         'DXT1',
  [TexFmt.DXT3]:         'DXT3',
  [TexFmt.DXT5]:         'DXT5',
  [TexFmt.R5G6B5]:       'R5G6B5',
  [TexFmt.A1R5G5B5]:     'A1R5G5B5',
  [TexFmt.X8]:           'X8',
  [TexFmt.X16]:          'X16',
  [TexFmt.CXT1]:         'CXT1',
  [TexFmt.DXN]:          'DXN',
  [TexFmt.BC6H_UF16]:    'BC6H_UF16',
  [TexFmt.BC6H_SF16]:    'BC6H_SF16',
  [TexFmt.BC7_UNORM]:    'BC7_UNORM',
  [TexFmt.BC7_UNORM_SRGB]: 'BC7_SRGB',
  [TexFmt.R32F]:         'R32F',
};

function fmtName(fmt: number): string {
  return FMT_NAMES[fmt] ?? `0x${fmt.toString(16).padStart(2,'0')}`;
}

function fmtBadgeColor(fmt: number): string {
  if (fmt === TexFmt.DXT1) return '#3b82f6';
  if (fmt === TexFmt.DXT3 || fmt === TexFmt.DXT5) return '#8b5cf6';
  if (fmt === TexFmt.A8R8G8B8) return '#10b981';
  if (fmt === TexFmt.BC6H_UF16 || fmt === TexFmt.BC6H_SF16) return '#f59e0b';
  if (fmt === TexFmt.BC7_UNORM || fmt === TexFmt.BC7_UNORM_SRGB) return '#ef4444';
  return '#64748b';
}

// ─── Per-entry preview ─────────────────────────────────────────────────────

function useTexturePreview(entry: TextureEntry | null, tempBytes: Uint8Array | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  const prevRef = React.useRef<{ entryIdx: number; url: string } | null>(null);

  React.useEffect(() => {
    if (!entry || !tempBytes) { setUrl(null); return; }
    if (prevRef.current?.entryIdx === entry.index) { setUrl(prevRef.current.url); return; }

    const pixels = loadPixels(entry, tempBytes);
    try {
      const decoded = decodeDDSPixels(pixels, entry.width, entry.height, entry.format);
      const dataUrl = decodedToDataURL(decoded);
      prevRef.current = { entryIdx: entry.index, url: dataUrl };
      setUrl(dataUrl);
    } catch {
      setUrl(null);
    }
  }, [entry, tempBytes]);

  return url;
}

// ─── Thumbnail component (lazy-decodes on mount) ─────────────────────────

const TextureThumbnail: React.FC<{ entry: TextureEntry; tempBytes: Uint8Array; isPending: boolean; onClick: () => void; selected: boolean }> =
  ({ entry, tempBytes, isPending, onClick, selected }) => {
  const [url, setUrl] = useState<string | null>(null);
  const decoded = useRef(false);

  React.useEffect(() => {
    if (decoded.current) return;
    decoded.current = true;
    const pixels = loadPixels(entry, tempBytes);
    try {
      const img = decodeDDSPixels(pixels, entry.width, entry.height, entry.format);
      setUrl(decodedToDataURL(img));
    } catch {
      setUrl(null);
    }
  }, [entry, tempBytes]);

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column',
        background: selected ? 'rgba(99,102,241,0.18)' : 'var(--bg-tertiary)',
        border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        borderRadius: '8px', overflow: 'hidden', cursor: 'pointer',
        transition: 'all 0.15s',
        outline: isPending ? '2px solid #f59e0b' : undefined,
      }}
    >
      <div style={{ width: '100%', paddingBottom: '100%', position: 'relative', background: 'repeating-conic-gradient(#1e1e22 0% 25%, #141417 0% 50%) 0 0 / 16px 16px' }}>
        {url ? (
          <img
            src={url}
            alt={entry.name}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.6rem' }}>
            <RefreshCw size={16} style={{ opacity: 0.4 }} />
          </div>
        )}
        {isPending && (
          <div style={{ position: 'absolute', top: 4, right: 4, background: '#f59e0b', borderRadius: '4px', padding: '1px 5px', fontSize: '0.55rem', fontWeight: 700, color: '#000' }}>
            PENDING
          </div>
        )}
      </div>
      <div style={{ padding: '6px 8px' }}>
        <div style={{ fontSize: '0.65rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={entry.name}>
          {entry.name || `tex_${entry.index}`}
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '3px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{entry.width}×{entry.height}</span>
          <span style={{ fontSize: '0.55rem', background: fmtBadgeColor(entry.format), color: '#fff', borderRadius: '3px', padding: '0 4px' }}>
            {fmtName(entry.format)}
          </span>
        </div>
      </div>
    </div>
  );
};

// ─── Detail panel for selected texture ────────────────────────────────────

const TextureDetailPanel: React.FC<{
  entry: TextureEntry;
  tempBytes: Uint8Array;
  pendingPixels: Uint8Array | null;
  onImport: (file: File) => void;
  onExportDDS: () => void;
  onExportPNG: () => void;
  onClearPending: () => void;
}> = ({ entry, tempBytes, pendingPixels, onImport, onExportDDS, onExportPNG, onClearPending }) => {
  const pixelsForDisplay = pendingPixels ?? loadPixels(entry, tempBytes);
  const decoded = React.useMemo(() => {
    try { return decodeDDSPixels(pixelsForDisplay, entry.width, entry.height, entry.format); }
    catch { return null; }
  }, [pixelsForDisplay, entry]);

  const previewUrl = React.useMemo(() => decoded ? decodedToDataURL(decoded) : null, [decoded]);

  const importRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Preview */}
      <div style={{
        flex: '0 0 auto', maxHeight: '40%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'repeating-conic-gradient(#1e1e22 0% 25%, #141417 0% 50%) 0 0 / 16px 16px',
        borderBottom: '1px solid var(--border-color)', minHeight: 120,
      }}>
        {previewUrl
          ? <img src={previewUrl} alt={entry.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', imageRendering: 'pixelated' }} />
          : <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Cannot decode {fmtName(entry.format)}</div>
        }
      </div>

      {/* Info */}
      <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {pendingPixels && (
          <div style={{ marginBottom: '0.75rem', padding: '6px 10px', background: 'rgba(245,158,11,0.12)', border: '1px solid #f59e0b', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 600 }}>Pending replacement</span>
            <button onClick={onClearPending} style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', padding: 0 }}><X size={13} /></button>
          </div>
        )}

        <h4 style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
          {entry.name || `tex_${entry.index}`}
        </h4>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
          {[
            ['Format', fmtName(entry.format)],
            ['Size', `${entry.width}×${entry.height}`],
            ['Mipmaps', String(entry.numMipmaps)],
            ['Depth', String(entry.depth)],
            ['Data size', `${(entry.dataSize / 1024).toFixed(1)} KB`],
            ['Data offset', `0x${entry.dataPos.toString(16)}`],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '2px' }}>{k}</div>
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-primary)' }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <button
            className="btn btn-secondary"
            style={{ width: '100%', fontSize: '0.7rem', gap: '6px', justifyContent: 'center' }}
            onClick={() => importRef.current?.click()}
          >
            <Upload size={13} /> Import PNG / DDS
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".png,.dds"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
            <button className="btn btn-secondary" style={{ fontSize: '0.65rem', gap: '5px' }} onClick={onExportDDS}>
              <Download size={12} /> Export DDS
            </button>
            <button className="btn btn-secondary" style={{ fontSize: '0.65rem', gap: '5px' }} onClick={onExportPNG}>
              <Download size={12} /> Export PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────

export const TexturePackEditor: React.FC = () => {
  const [permBytes, setPermBytes] = useState<Uint8Array | null>(null);
  const [tempBytes, setTempBytes] = useState<Uint8Array | null>(null);
  const [permName, setPermName] = useState('');
  const [tempName, setTempName] = useState('');
  const [entries, setEntries] = useState<TextureEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // Map: entry.index → new pixels (pending)
  const [patches, setPatches] = useState<Map<number, PatchedTexture>>(new Map());
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'format' | 'size'>('name');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File loading ─────────────────────────────────────────────────────────

  const parsePack = useCallback((perm: Uint8Array) => {
    try {
      const parsed = parsePerm(perm);
      setEntries(parsed);
    } catch (e) {
      alert('Failed to parse perm.bin: ' + (e as Error).message);
    }
  }, []);

  // Accepts any mix of .perm.bin and .temp.bin files; ignores anything else
  const handleFiles = useCallback(async (files: File[]) => {
    let newPerm: Uint8Array | null = null;
    let newTemp: Uint8Array | null = null;

    for (const f of files) {
      if (f.name.endsWith('.perm.bin')) {
        const buf = await f.arrayBuffer();
        newPerm = new Uint8Array(buf);
        setPermName(f.name);
        setEntries([]);
        setSelectedIdx(null);
        setPatches(new Map());
        setSaveStatus('idle');
      } else if (f.name.endsWith('.temp.bin')) {
        const buf = await f.arrayBuffer();
        newTemp = new Uint8Array(buf);
        setTempName(f.name);
      }
      // silently ignore any other file types
    }

    if (newPerm) setPermBytes(newPerm);
    if (newTemp) setTempBytes(newTemp);

    const permToUse = newPerm ?? permBytes;
    if (permToUse && (newPerm || newTemp)) parsePack(permToUse);
  }, [permBytes, parsePack]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length) await handleFiles(files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    handleFiles([...e.dataTransfer.files]);
  };

  // ── Selected entry ───────────────────────────────────────────────────────

  const selectedEntry = selectedIdx !== null ? entries[selectedIdx] ?? null : null;
  const pendingPixels = selectedEntry ? (patches.get(selectedEntry.index)?.newPixels ?? null) : null;

  // ── Import PNG / DDS ─────────────────────────────────────────────────────

  const handleImport = useCallback(async (file: File, entry: TextureEntry) => {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (file.name.endsWith('.dds')) {
      // Strip DDS header to get raw pixels
      const info = parseDDSHeader(bytes);
      if (!info) { alert('Invalid DDS file'); return; }
      const raw = stripDDSHeader(bytes);
      setPatches(prev => {
        const next = new Map(prev);
        next.set(entry.index, { entry, newPixels: raw });
        return next;
      });
    } else {
      // PNG → decode with ImageBitmap → render to canvas → get pixel data in entry format
      const blob = new Blob([bytes], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);

      const canvas = document.createElement('canvas');
      canvas.width = entry.width;
      canvas.height = entry.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, entry.width, entry.height);
      const imgData = ctx.getImageData(0, 0, entry.width, entry.height);

      // Convert RGBA → entry format (only uncompressed formats supported for import)
      let raw: Uint8Array;
      if (entry.format === TexFmt.A8R8G8B8) {
        raw = new Uint8Array(entry.width * entry.height * 4);
        for (let i = 0; i < entry.width * entry.height; i++) {
          raw[i*4]   = imgData.data[i*4+3]; // A
          raw[i*4+1] = imgData.data[i*4];   // R
          raw[i*4+2] = imgData.data[i*4+1]; // G
          raw[i*4+3] = imgData.data[i*4+2]; // B
        }
      } else if (entry.format === TexFmt.R5G6B5) {
        raw = new Uint8Array(entry.width * entry.height * 2);
        for (let i = 0; i < entry.width * entry.height; i++) {
          const r = (imgData.data[i*4]   >> 3) & 0x1F;
          const g = (imgData.data[i*4+1] >> 2) & 0x3F;
          const b = (imgData.data[i*4+2] >> 3) & 0x1F;
          const c = (r << 11) | (g << 5) | b;
          raw[i*2] = c & 0xFF; raw[i*2+1] = (c >> 8) & 0xFF;
        }
      } else {
        alert(`PNG import for ${fmtName(entry.format)} is not supported — only A8R8G8B8 and R5G6B5 textures can be imported as PNG. For compressed formats, import a DDS file instead.`);
        return;
      }

      setPatches(prev => {
        const next = new Map(prev);
        next.set(entry.index, { entry, newPixels: raw });
        return next;
      });
    }
  }, []);

  // ── Export ───────────────────────────────────────────────────────────────

  const handleExportDDS = useCallback((entry: TextureEntry, customPixels?: Uint8Array) => {
    if (!tempBytes) return;
    const pixels = customPixels ?? loadPixels(entry, tempBytes);
    const dds = makeDDS(entry, pixels);
    downloadBytes(dds, `${entry.name || `tex_${entry.index}`}.dds`);
  }, [tempBytes]);

  const handleExportPNG = useCallback((entry: TextureEntry, customPixels?: Uint8Array) => {
    if (!tempBytes) return;
    const pixels = customPixels ?? loadPixels(entry, tempBytes);
    try {
      const decoded = decodeDDSPixels(pixels, entry.width, entry.height, entry.format);
      const url = decodedToDataURL(decoded);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entry.name || `tex_${entry.index}`}.png`;
      a.click();
    } catch (e) {
      alert('Export PNG failed: ' + (e as Error).message);
    }
  }, [tempBytes]);

  // ── Save pack ────────────────────────────────────────────────────────────

  const handleSavePack = useCallback(async () => {
    if (!permBytes || !tempBytes || patches.size === 0) return;
    setSaveStatus('saving');
    try {
      const patchList = [...patches.values()];
      const { permBytes: newPerm, tempBytes: newTemp } = writePackPatches(permBytes, tempBytes, patchList);
      downloadBytes(newPerm, permName || 'output.perm.bin');
      downloadBytes(newTemp, tempName || 'output.temp.bin');
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (e) {
      setSaveStatus('error');
      alert('Save failed: ' + (e as Error).message);
    }
  }, [permBytes, tempBytes, patches, permName, tempName]);

  // ── Filtered + sorted entries ────────────────────────────────────────────

  const filteredEntries = React.useMemo(() => {
    let arr = [...entries];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      arr = arr.filter(e => e.name.toLowerCase().includes(q) || fmtName(e.format).toLowerCase().includes(q));
    }
    if (sortBy === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'format') arr.sort((a, b) => a.format - b.format);
    else arr.sort((a, b) => b.dataSize - a.dataSize);
    return arr;
  }, [entries, searchQuery, sortBy]);

  // ── Drop zone ────────────────────────────────────────────────────────────
  const [isDragOver, setIsDragOver] = useState(false);

  // ── Render ────────────────────────────────────────────────────────────────

  const loaded = entries.length > 0;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' }}>
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-tertiary)', padding: '3px 10px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
              <FileImage size={13} style={{ color: 'var(--accent-secondary)' }} />
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-secondary)' }}>Texture Pack</span>
            </div>
            {loaded && (
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {entries.length} textures
                {patches.size > 0 && <span style={{ color: '#f59e0b', marginLeft: '8px' }}>• {patches.size} pending</span>}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} style={{ fontSize: '0.7rem', gap: '5px', padding: '5px 10px' }}>
              <Upload size={13} /> Load Texture Pack
            </button>
            <input ref={fileInputRef} type="file" accept=".bin" multiple style={{ display: 'none' }} onChange={handleFileInput} />

            {patches.size > 0 && (
              <button
                className="btn btn-primary"
                onClick={handleSavePack}
                style={{ fontSize: '0.7rem', gap: '5px', padding: '5px 12px' }}
                disabled={saveStatus === 'saving'}
              >
                <Save size={13} />
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved!' : `Save Pack (${patches.size})`}
              </button>
            )}
          </div>
        </div>

        {/* Search + sort row */}
        {loaded && (
          <div className="toolbar-row">
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 1 }}>
              <input
                type="text"
                placeholder="Search textures…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)', padding: '4px 10px',
                  color: 'var(--text-primary)', fontSize: '0.7rem', width: '220px',
                  outline: 'none',
                }}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{filteredEntries.length} results</span>
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['name', 'format', 'size'] as const).map(s => (
                <button
                  key={s}
                  className={`btn btn-sm ${sortBy === s ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: '0.65rem', padding: '3px 8px' }}
                  onClick={() => setSortBy(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {!loaded ? (
          // Drop zone
          <div
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: '1rem', border: `2px dashed ${isDragOver ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              margin: '2rem', borderRadius: 'var(--radius-lg)',
              background: isDragOver ? 'rgba(99,102,241,0.06)' : 'transparent',
              transition: 'all 0.15s',
            }}
          >
            <FileImage size={48} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Load a Texture Pack</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                Drop your <code style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: '4px' }}>.perm.bin</code> and <code style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: '4px' }}>.temp.bin</code> files here, or browse
              </div>
              <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} style={{ gap: '6px' }}>
                <Upload size={14} /> Select Files
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Texture grid */}
            <div className="scroll-thin" style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: '0.75rem',
              }}>
                {filteredEntries.map((entry, i) => (
                  <TextureThumbnail
                    key={entry.index}
                    entry={entry}
                    tempBytes={tempBytes!}
                    isPending={patches.has(entry.index)}
                    selected={selectedEntry?.index === entry.index}
                    onClick={() => {
                      const realIdx = entries.findIndex(e => e.index === entry.index);
                      setSelectedIdx(realIdx);
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Detail panel */}
            {selectedEntry && (
              <div style={{
                width: '280px', flexShrink: 0,
                borderLeft: '1px solid var(--border-color)',
                background: 'var(--bg-secondary)',
                display: 'flex', flexDirection: 'column',
                overflow: 'hidden',
              }}>
                <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Texture Detail</span>
                  <button onClick={() => setSelectedIdx(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>
                    <X size={14} />
                  </button>
                </div>
                <TextureDetailPanel
                  entry={selectedEntry}
                  tempBytes={tempBytes!}
                  pendingPixels={patches.get(selectedEntry.index)?.newPixels ?? null}
                  onImport={file => handleImport(file, selectedEntry)}
                  onExportDDS={() => handleExportDDS(selectedEntry, patches.get(selectedEntry.index)?.newPixels)}
                  onExportPNG={() => handleExportPNG(selectedEntry, patches.get(selectedEntry.index)?.newPixels)}
                  onClearPending={() => {
                    setPatches(prev => { const n = new Map(prev); n.delete(selectedEntry.index); return n; });
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ─── Utility ──────────────────────────────────────────────────────────────

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
