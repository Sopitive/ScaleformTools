# Scaleform Tools

A desktop application for editing Halo MCC Scaleform UI assets — GFX/SWF files and UFG texture packs.

Built with React + TypeScript (UI) and WPF + WebView2 (desktop shell).

## Features

- **GFX / SWF editor** — parse and visually inspect Scaleform UI layouts; edit element properties, text, positions; export modified GFX files
- **AS3 script editor** — decompile AVM2 bytecode to AS3 source, edit, recompile, and patch back into the DoABC tag
- **AVM2 runtime** — live hover/click simulation that fires AS3 event handlers and updates canvas elements in real time
- **Texture pack editor** — load `.perm.bin` / `.temp.bin` pairs, browse and preview textures, import PNG/DDS replacements, export individual textures, save modified packs
- **Live Edit mode** — auto-export modified GFX files directly to a game installation on save

## Project Structure

```
ScaleformTools/
  src/                          # React + TypeScript app
    App.tsx                     # Root component — GFX editor UI, mode switcher
    index.css                   # Global styles and CSS variables
    main.tsx                    # Entry point
    components/
      TexturePackEditor.tsx     # Texture pack browser/editor UI
    lib/
      gfx.ts                    # GFX/SWF binary parser
      gfxPatcher.ts             # AS2 action patching
      abcFile.ts                # AVM2 ABC binary serialiser
      abcMerger.ts              # Surgical ABC class replacement (compile & save)
      as3Lexer.ts               # AS3 lexer
      as3Parser.ts              # AS3 parser
      as3Compiler.ts            # AS3 -> AVM2 bytecode compiler
      as3Decompiler.ts          # AVM2 bytecode -> AS3 source decompiler
      as3Runtime.ts             # AVM2 interpreter for live event simulation
      texturePack.ts            # UFG .perm.bin / .temp.bin parser and writer
      ddsDecoder.ts             # DDS pixel data -> RGBA canvas decoder
      native.ts                 # WebView2 desktop bridge
  desktop/                      # WPF + WebView2 desktop shell (C# / .NET 8)
    ScaleformTools.csproj
    MainWindow.xaml / .cs       # Main window with custom title bar
    App.xaml / .cs
    Bridge/
      NativeBridge.cs           # JS <-> C# message bridge (file dialogs, live edit)
      LiveEditService.cs        # Writes GFX bytes directly to game files
  scripts/
    walkgfx.mjs                 # CLI: dump GFX structure to JSON
    showmatrices.cjs            # CLI: print transform matrices from GFX
```

## Building

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [.NET 8 SDK](https://dotnet.microsoft.com/download)
- Windows 10/11 (WebView2 is Windows-only)

### 1 - Build the React app

```bash
npm install
npm run build
# Output goes to dist/
```

### 2 - Build the desktop shell

```bash
cd desktop
dotnet publish -c Release -r win-x64 --self-contained false
```

The `.csproj` automatically picks up `../dist/**` and copies it into the published `wwwroot/` folder so the app runs fully offline.

### Development (hot-reload)

```bash
# Terminal 1 — start the Vite dev server
npm run dev

# Terminal 2 — set DevMode = true in desktop/MainWindow.xaml.cs, then run the shell
cd desktop
dotnet run
```

The app loads from `http://localhost:5173` with full hot-reload.

## Supported Formats

| Format | Read | Write |
|---|---|---|
| `.gfx` / `.swf` (Scaleform) | Yes | Yes |
| `.perm.bin` / `.temp.bin` (UFG texture pack) | Yes | Yes |
| DXT1 / DXT3 / DXT5 textures | Yes (decode) | via DDS import |
| A8R8G8B8 / R5G6B5 textures | Yes (decode) | Yes (PNG import) |
| BC6H / BC7 textures | placeholder | via DDS import |

## Contributing

PRs welcome. The UI is pure TypeScript with no backend — everything runs client-side inside the WebView2 host.
