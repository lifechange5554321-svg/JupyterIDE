# Jupyter IDE – Finance (v0.6.1)

Android Jupyter-style notebook (WebView + **Pyodide**).

## Phase 2 (this release)

### Offline runtime cache
- First launch can download Pyodide core (~30–50MB) into:
  `…/JupyterIDE/runtime/pyodide/`
- Later launches: WebView **intercepts** CDN requests and serves local files → works **offline** after cache.
- Menu: **☰ → Offline runtime**

### Durable folder (SAF)
- Pick a folder that keeps packages/notebooks even after app data issues (persistable URI).
- Menu: **☰ → Durable folder**

### Still true from v0.6
- Fast boot: stdlib only; packages on import
- Local-first packages + manifest
- Autosave, sticky cells, finance checklist
- No Chaquopy

## Assets layout
```
Android/data/com.lifechange.jupyteride/files/JupyterIDE/
  runtime/pyodide/   ← offline Python runtime
  packages/
  fonts/
  data/
  notebooks/
  packages_manifest.txt
```

## Build
Push to `main` → Actions → **JupyterIDE-debug-apk**

```bash
gradle assembleDebug
```

## License
MIT
