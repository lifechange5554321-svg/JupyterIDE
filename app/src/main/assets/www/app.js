/**
 * Jupyter IDE v0.5 – fast boot, autosave, sticky chrome, finance checklist
 */
let pyodide = null;
let cells = [];
let cellIdCounter = 0;
let isReady = false;
let activeEditor = null;
let activeCell = null;
let ctrlHeld = false;
let shiftHeld = false;
let ctxTarget = null;

const statusEl = document.getElementById("status");
const notebookEl = document.getElementById("notebook");
const hasBridge = typeof AndroidBridge !== "undefined";
let notebookDirty = false;
let notebookPath = ""; // relative under assets, e.g. notebooks/foo.ipynb
let pendingCloseAction = null;

const FINANCE_PKGS = [
  { name: "numpy", desc: "Numerical arrays" },
  { name: "pandas", desc: "DataFrames / CSV" },
  { name: "matplotlib", desc: "Charts" },
  { name: "yfinance", desc: "Yahoo Finance data" },
  { name: "requests", desc: "HTTP" },
  { name: "plotly", desc: "Interactive charts" },
  { name: "scipy", desc: "Scientific" },
  { name: "scikit-learn", desc: "ML (if available)" },
  { name: "statsmodels", desc: "Stats models" },
  { name: "ta", desc: "Technical analysis" },
];

const DEFAULTS = {
  theme: "dark", codeTheme: "vscode-dark", codeFont: "monospace",
  faFont: "system-ui, sans-serif", customFontFile: "",
  codeSize: 14, outSize: 13, indentGuides: false, lineWrap: false,
  lastFolder: "",
};

const PYTHON_KEYWORDS = [
  "False","None","True","and","as","assert","async","await","break","class","continue",
  "def","del","elif","else","except","finally","for","from","global","if","import",
  "in","is","lambda","nonlocal","not","or","pass","raise","return","try","while",
  "with","yield","print","len","range","enumerate","zip","map","filter","sorted",
  "list","dict","set","tuple","str","int","float","bool","type","isinstance",
  "open","input","sum","min","max","abs","round","any","all","self","Exception"
];

function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("jide_settings") || "{}")); }
  catch (_) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(s) { localStorage.setItem("jide_settings", JSON.stringify(s)); }
let settings = loadSettings();

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status " + (type || "");
}

function applySettings() {
  document.body.classList.toggle("theme-light", settings.theme === "light");
  document.body.classList.toggle("indent-guides", !!settings.indentGuides);
  document.documentElement.style.setProperty("--code-size", settings.codeSize + "px");
  document.documentElement.style.setProperty("--out-size", settings.outSize + "px");
  document.documentElement.style.setProperty("--font-mono", settings.codeFont);
  document.documentElement.style.setProperty("--font-fa", settings.faFont === "custom" ? "system-ui, sans-serif" : settings.faFont);
  cells.forEach((c) => {
    if (c.editor) {
      c.editor.setOption("theme", settings.codeTheme);
      c.editor.setOption("lineWrapping", !!settings.lineWrap);
      c.editor.refresh();
    }
  });
}

/* ---------- Autosave (preserve newlines) ---------- */
function flushAllEditors() {
  cells.forEach((c) => {
    if (c.editor) {
      try { c.content = c.editor.getValue(); } catch (_) {}
    }
  });
}

function serializeNotebook() {
  flushAllEditors();
  return {
    v: 6,
    cells: cells.map((c) => ({
      id: c.id, type: c.type, title: c.title || "",
      content: c.content || "",
      editorHeight: c.editorHeight || 160,
      outputHeight: c.outputHeight || 120,
      collapsed: !!c.collapsed,
      outCollapsed: !!c.outCollapsed,
      moveLocked: !!c.moveLocked,
      editLocked: !!c.editLocked,
      moveLocked: !!c.moveLocked,
      editLocked: !!c.editLocked,
    })),
  };
}


/** First comment line → safe title for cell / save */
function titleFromCode(code) {
  if (!code) return "";
  const lines = String(code).split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let raw = "";
    if (t.startsWith("#")) raw = t.replace(/^#+\s*/, "");
    else if (t.startsWith("//")) raw = t.replace(/^\/\/\s*/, "");
    else if (t.startsWith("/*")) raw = t.replace(/^\/\*+\s*/, "").replace(/\*+\/$/, "");
    else break; // first non-comment ends search (top of file only)
    if (!raw) continue;
    // strip illegal filename chars
    let name = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
    if (name.length > 48) name = name.slice(0, 48).trim();
    return name;
  }
  return "";
}

function applyAutoTitle(cell) {
  if (!cell || cell.type !== "code") return;
  if (cell.titleLocked) return;
  const code = cell.editor ? cell.editor.getValue() : (cell.content || "");
  const auto = titleFromCode(code);
  if (auto) {
    cell.title = auto;
    const el = document.getElementById("cell-" + cell.id);
    const t = el && el.querySelector(".cell-title");
    if (t && !t.classList.contains("editing")) t.textContent = auto;
  }
}

function markDirty() {
  notebookDirty = true;
}

/** Standard Jupyter .ipynb JSON */
function toIpynb() {
  flushAllEditors();
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3 (Pyodide)", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.12" },
      jupyteride: { version: 7 }
    },
    cells: cells.map((c) => {
      const src = (c.content || "").split("\n").map((line, i, arr) =>
        i < arr.length - 1 ? line + "\n" : line
      );
      if (c.type === "markdown") {
        return { cell_type: "markdown", metadata: { jupyteride_title: c.title || "" }, source: src };
      }
      return {
        cell_type: "code",
        execution_count: null,
        metadata: { jupyteride_title: c.title || "" },
        source: src,
        outputs: []
      };
    })
  };
  return JSON.stringify(nb, null, 2);
}

function loadFromIpynb(text) {
  const nb = JSON.parse(text);
  if (!nb.cells) throw new Error("Not a valid .ipynb");
  cells = [];
  notebookEl.innerHTML = "";
  cellIdCounter = 0;
  nb.cells.forEach((jc) => {
    const type = jc.cell_type === "markdown" ? "markdown" : "code";
    let content = "";
    if (Array.isArray(jc.source)) content = jc.source.join("");
    else content = jc.source || "";
    const title = (jc.metadata && jc.metadata.jupyteride_title) || "";
    addCell(type, content, title);
  });
  notebookDirty = false;
}

let _saveTimer = null;
function saveNotebookLocal(immediate) {
  const doSave = () => {
    try {
      const data = serializeNotebook();
      localStorage.setItem("jide_notebook", JSON.stringify(data));
      if (hasBridge) {
        try {
          AndroidBridge.saveUserFile("notebooks/autosave.json", JSON.stringify(data, null, 2));
        } catch (_) {}
      }
    } catch (e) { console.warn("autosave", e); }
  };
  if (immediate) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = null;
    doSave();
  } else {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(doSave, 400);
  }
}

function restoreNotebook() {
  try {
    const raw = localStorage.getItem("jide_notebook");
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.cells) || !data.cells.length) return false;
    cells = [];
    notebookEl.innerHTML = "";
    cellIdCounter = 0;
    data.cells.forEach((c) => {
      const cell = addCell(c.type || "code", c.content || "", c.title || "");
      cell.editorHeight = c.editorHeight || 160;
      cell.outputHeight = c.outputHeight || 120;
      cell.collapsed = !!c.collapsed;
      cell.outCollapsed = !!c.outCollapsed;
      // re-render with sizes
      renderCell(cell);
    });
    return true;
  } catch (e) {
    console.warn("restore", e);
    return false;
  }
}

setInterval(() => saveNotebookLocal(true), 120000); // Jupyter-like ~120s
window.addEventListener("beforeunload", () => saveNotebookLocal(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNotebookLocal(true);
});
document.addEventListener("pause", () => saveNotebookLocal(true));

/* ---------- Fast boot: pure Python only ---------- */
async function ensureOfflineRuntime() {
  if (!hasBridge) return { ok: true, offline: false };
  try {
    if (AndroidBridge.isRuntimeReady()) {
      setStatus("Using local offline runtime…", "busy");
      return { ok: true, offline: true };
    }
    const missing = JSON.parse(AndroidBridge.listMissingRuntime() || "[]");
    if (!missing.length) return { ok: true, offline: true };
    const msg = "Runtime not cached locally (" + missing.length + " files).\n" +
      "Download once (~30–50MB) for offline use?\n\n" +
      "Without this, internet is required every launch.";
    if (!confirm(msg)) return { ok: true, offline: false };
    setStatus("Downloading offline runtime…", "busy");
    // Native blocking download of core files
    const result = JSON.parse(AndroidBridge.cacheFullRuntime() || "{}");
    if (result.ready || result.ok) {
      setStatus("Runtime cached offline", "ready");
      return { ok: true, offline: true };
    }
    setStatus("Partial runtime cache – online fallback", "busy");
    return { ok: true, offline: false };
  } catch (e) {
    console.warn(e);
    return { ok: true, offline: false };
  }
}

async function initPyodide() {
  try {
    await ensureOfflineRuntime();
    setStatus("Loading Python (stdlib only)…", "busy");
    const indexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/";
    pyodide = await loadPyodide({ indexURL: indexURL });
    await pyodide.runPythonAsync(`
import sys, io, traceback, base64
_namespace = {"__name__": "__main__"}

def _capture_run(source: str):
    stdout = io.StringIO()
    stderr = io.StringIO()
    images = []
    error_line = error_type = error_msg = None
    # lazy matplotlib hook
    try:
        import matplotlib
        matplotlib.use("AGG")
        import matplotlib.pyplot as plt
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        original_show = plt.show
        def capture_show(*a, **k):
            for num in plt.get_fignums():
                fig = plt.figure(num)
                canvas = FigureCanvasAgg(fig)
                canvas.draw()
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight", dpi=120)
                buf.seek(0)
                images.append(base64.b64encode(buf.read()).decode("ascii"))
                plt.close(fig)
        plt.show = capture_show
    except Exception:
        original_show = None
        plt = None
    try:
        import contextlib
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(source, _namespace, _namespace)
    except Exception as e:
        tb = traceback.TracebackException.from_exception(e)
        traceback.print_exc(file=stderr)
        error_type = type(e).__name__
        error_msg = str(e)
        frames = list(tb.stack)
        if frames:
            for fr in reversed(frames):
                if fr.filename in ("<string>", "<exec>"):
                    error_line = fr.lineno
                    break
            if error_line is None:
                error_line = frames[-1].lineno
    finally:
        if plt is not None and original_show is not None:
            plt.show = original_show
    return {
        "stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
        "images": images, "error_line": error_line,
        "error_type": error_type, "error_msg": error_msg,
    }
`);
    isReady = true;
    const ver = pyodide.runPython("import sys; sys.version.split()[0]");
    setStatus("Ready • Python " + ver + " • packages on demand", "ready");
    document.getElementById("header-sub").textContent = "Python " + ver + " • on-demand pkgs";

    if (!restoreNotebook()) {
      addCell("code", "# Fast boot: only stdlib loaded\n# import numpy / pandas when you need them\n\nprint('Hello from Jupyter IDE')\n");
      addCell("markdown", "## Tip\nUse **☰ → Finance checklist** to download market libraries once.");
    }
  } catch (err) {
    console.error(err);
    setStatus("Failed: " + err.message + " (need network first time for runtime)", "error");
  }
}

function pkgLog(msg) {
  const el = document.getElementById("pkg-log");
  if (el) el.textContent += msg + "\n";
}

async function ensurePackage(name) {
  name = (name || "").trim();
  if (!name || !pyodide) return false;
  const mod = name.split(/[<>=!]/)[0].replace("-", "_");
  try {
    await pyodide.runPythonAsync("import " + mod);
    return true;
  } catch (_) {}

  if (hasBridge && AndroidBridge.hasLocalPackage(name)) {
    setStatus("Loading " + name + " from local…", "busy");
    try {
      await pyodide.loadPackage(name);
      setStatus("Loaded " + name, "ready");
      return true;
    } catch (e) { pkgLog("local fail: " + e.message); }
  }

  if (!confirm('Package "' + name + '" not local.\nDownload and keep?')) {
    setStatus("Skipped " + name, "error");
    return false;
  }
  setStatus("Downloading " + name + "…", "busy");
  try {
    // Prefer official Pyodide package build (real files on CDN)
    try {
      await pyodide.loadPackage(name);
    } catch (_) {
      await pyodide.loadPackage("micropip");
      await pyodide.runPythonAsync(
        "import micropip\nawait micropip.install(" + JSON.stringify(name) + ")"
      );
    }
    // Persist inventory + try to cache CDN package payloads into assets/packages
    if (hasBridge) {
      const meta = JSON.stringify({
        name: name,
        installedAt: new Date().toISOString(),
        source: "pyodide"
      }, null, 2);
      AndroidBridge.saveUserFile("packages/" + name + "/installed.json", meta);
      // Best-effort: pull common pyodide artifact names into local packages/
      const base = (typeof AndroidBridge.getPyodideCdnBase === "function")
        ? AndroidBridge.getPyodideCdnBase()
        : "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/";
      try {
        if (typeof AndroidBridge.downloadToAssets === "function") {
          // pyodide-lock helps; still try name-prefixed files later via manifest
          AndroidBridge.saveUserFile("packages/" + name + "/README.txt",
            "Package " + name + " installed via Pyodide.\n" +
            "Runtime cache: runtime/pyodide\nCDN: " + base + "\n");
        }
      } catch (_) {}
      try {
        AndroidBridge.savePackage(name, "installed", name + "/installed.json", btoa("installed"), "pyodide");
      } catch (_) {}
    }
    setStatus("Installed " + name, "ready");
    return true;
  } catch (e) {
    setStatus("Install failed: " + name, "error");
    pkgLog(String(e));
    return false;
  }
}

function pythonHint(cm) {
  const cur = cm.getCursor();
  const token = cm.getTokenAt(cur);
  let start = token.start, end = cur.ch, word = token.string;
  if (!word || /[^\\w]/.test(token.string)) { word = ""; start = end; }
  else {
    const m = word.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (m) { start = end - m[0].length; word = m[0]; }
  }
  const found = new Set(PYTHON_KEYWORDS);
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m, doc = cm.getValue();
  while ((m = re.exec(doc))) if (m[0].length > 1) found.add(m[0]);
  const list = Array.from(found).filter(w => w.toLowerCase().startsWith(word.toLowerCase()) && w !== word).sort().slice(0, 40);
  return { list, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
}

function addCell(type, content, title) {
  const id = ++cellIdCounter;
  const cell = {
    id, type: type || "code",
    title: title || (type === "markdown" ? "markdown-" + id : "cell-" + id + ".py"),
    content: content || "", editorHeight: 160, outputHeight: 120,
    collapsed: false, outCollapsed: false, editor: null, outputHtml: "", error: false,
  };
  cells.push(cell);
  renderCell(cell);
  notebookEl.scrollTop = notebookEl.scrollHeight;
  markDirty();
  saveNotebookLocal();
  return cell;
}

function bindResize(handle, getH, setH, minH, maxH, onResize) {
  if (!handle) return;
  let startY = 0, startH = 0, dragging = false;
  const start = (y) => { dragging = true; startY = y; startH = getH(); };
  const move = (y) => {
    if (!dragging) return;
    const nh = Math.max(minH, Math.min(maxH, startH + (y - startY)));
    setH(nh);
    if (onResize) onResize(nh);
  };
  const end = () => { dragging = false; saveNotebookLocal(); };
  handle.addEventListener("touchstart", (e) => { start(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  handle.addEventListener("touchmove", (e) => { move(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  handle.addEventListener("touchend", end);
  handle.addEventListener("mousedown", (e) => {
    start(e.clientY);
    const mm = (ev) => move(ev.clientY);
    const mu = () => { end(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
  });
}

function renderCell(cell) {
  let el = document.getElementById("cell-" + cell.id);
  if (!el) {
    el = document.createElement("div");
    el.id = "cell-" + cell.id;
    notebookEl.appendChild(el);
  }
  el.className = "cell " + cell.type
    + (cell.moveLocked ? " locked-move" : "")
    + (cell.editLocked ? " locked-edit" : "")
    + (cell.maximized ? " maximized" : "");

  const eh = cell.editorHeight || 160;
  const oh = cell.outputHeight || 120;
  el.innerHTML = `
    <div class="cell-chrome">
      <div class="cell-titlebar">
        <span class="cell-type-badge ${cell.type === "code" ? "" : "md"}">${cell.type === "code" ? "CODE" : "MD"}</span>
        <span class="cell-title" data-action="rename">${escapeHtml(cell.title || "")}</span>
        <span class="cell-lock-badge" data-action="lock-hint">${cell.moveLocked ? "🔒" : ""}${cell.editLocked ? "✏️🔒" : ""}</span>
      </div>
      <div class="cell-toolbar">
        <button data-action="undo" title="Undo">↶</button>
        <button data-action="redo" title="Redo">↷</button>
        <button data-action="toggle-size" title="Minimize">${cell.collapsed ? "▢" : "—"}</button>
        <button data-action="maximize" title="Maximize">${cell.maximized ? "🗗" : "🗖"}</button>
        <button data-action="toggle-move-lock" class="${cell.moveLocked ? "lock-on" : ""}" title="Move lock">🔒</button>
        <button data-action="toggle-edit-lock" class="${cell.editLocked ? "lock-on" : ""}" title="Edit lock">✏️</button>
        <button data-action="up" title="Move up">↑</button>
        <button data-action="down" title="Move down">↓</button>
        <button data-action="delete" title="Delete">✕</button>
        <span class="spacer"></span>
        ${cell.type === "code" ? '<button class="run" data-action="run" title="Run">▶</button>' : '<button data-action="preview" title="Preview">👁</button>'}
      </div>
    </div>
    <div class="editor-wrap ${cell.collapsed ? "collapsed" : ""}" style="height:${eh}px">
      <textarea class="cell-editor" spellcheck="false"></textarea>
    </div>
    <div class="resize-handle" data-resize="editor"><span class="grip"></span><span class="grip-btn">↕</span></div>
    ${cell.type === "markdown" ? '<div class="cell-md-preview"></div>' : ""}
    <div class="output-section">
      <div class="output-header">
        <span>OUTPUT</span>
        <span>
          <button data-action="toggle-out">${cell.outCollapsed ? "▢" : "—"}</button>
          <button data-action="copy-output">Copy</button>
        </span>
      </div>
      <div class="output-wrap ${cell.outCollapsed ? "collapsed" : ""}" style="height:${oh}px">
        <div class="cell-output ${cell.error ? "error" : ""}" tabindex="0"></div>
      </div>
      <div class="resize-handle" data-resize="output"><span class="grip"></span><span class="grip-btn">↕</span></div>
    </div>
  `;

  const textarea = el.querySelector(".cell-editor");
  const wrap = el.querySelector(".editor-wrap");
  const outWrap = el.querySelector(".output-wrap");
  const outputEl = el.querySelector(".cell-output");
  textarea.value = cell.content || "";
  if (cell.outputHtml) outputEl.innerHTML = cell.outputHtml;

  // rename title (long press)
  const titleEl = el.querySelector(".cell-title");
  let titleTimer = null;
  titleEl.addEventListener("touchstart", () => {
    titleTimer = setTimeout(() => startRename(cell, titleEl), 450);
  });
  titleEl.addEventListener("touchend", () => clearTimeout(titleTimer));
  titleEl.addEventListener("touchmove", () => clearTimeout(titleTimer));
  titleEl.addEventListener("dblclick", () => startRename(cell, titleEl));

  // resize ONLY via center button (.grip-btn), not whole bar
  const edHandle = el.querySelector('[data-resize="editor"] .grip-btn') || el.querySelector('[data-resize="editor"]');
  const outHandle = el.querySelector('[data-resize="output"] .grip-btn') || el.querySelector('[data-resize="output"]');
  bindResize(
    edHandle,
    () => wrap.getBoundingClientRect().height,
    (h) => { wrap.style.height = h + "px"; cell.editorHeight = h; },
    64, 700,
    (h) => { if (cell.editor) { cell.editor.setSize("100%", h + "px"); cell.editor.refresh(); } }
  );
  bindResize(
    outHandle,
    () => outWrap.getBoundingClientRect().height,
    (h) => { outWrap.style.height = h + "px"; cell.outputHeight = h; },
    28, 500, null
  );

  // output select-all isolation
  outputEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault(); e.stopPropagation();
      const r = document.createRange(); r.selectNodeContents(outputEl);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });
  // Long-press on output: select-all that box only + small menu
  let outLp = null;
  outputEl.addEventListener("touchstart", (e) => {
    outLp = setTimeout(() => {
      const r = document.createRange(); r.selectNodeContents(outputEl);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      ctxTarget = { type: "output", el: outputEl };
      showCtx(e.touches[0].clientX, e.touches[0].clientY);
    }, 480);
  }, { passive: true });
  outputEl.addEventListener("touchend", () => clearTimeout(outLp));
  outputEl.addEventListener("touchmove", () => clearTimeout(outLp));

  if (cell.type === "code" && window.CodeMirror) {
    if (cell.editor) {
      try { cell.editor.toTextArea(); } catch (_) {}
      cell.editor = null;
    }
    const editor = CodeMirror.fromTextArea(textarea, {
      mode: "python",
      theme: settings.codeTheme || "vscode-dark",
      lineNumbers: true,
      indentUnit: 4, tabSize: 4, indentWithTabs: false,
      electricChars: true, autoCloseBrackets: true, matchBrackets: true,
      lineWrapping: !!settings.lineWrap,
      viewportMargin: Infinity,
      extraKeys: {
        Tab(cm) {
          if (cm.somethingSelected()) cm.indentSelection("add");
          else if (cm.state.completionActive) return CodeMirror.Pass;
          else cm.replaceSelection("    ", "end");
        },
        "Shift-Tab"(cm) { cm.indentSelection("subtract"); },
        "Ctrl-A": "selectAll", "Cmd-A": "selectAll",
        "Ctrl-Space"(cm) { cm.showHint({ hint: pythonHint, completeSingle: false }); },
      },
    });
    cell.editor = editor;
    editor.setValue(cell.content || "");
    editor.setSize("100%", eh + "px");
    const syncEditor = () => { cell.content = editor.getValue(); applyAutoTitle(cell); markDirty(); saveNotebookLocal(false); };
    editor.on("change", syncEditor);
    editor.on("cursorActivity", () => { cell.content = editor.getValue(); });
    editor.on("blur", () => { cell.content = editor.getValue(); saveNotebookLocal(true); });
    editor.on("focus", () => {
      activeEditor = editor; activeCell = cell;
      setTimeout(() => stickCellUnderDashboard(el), 200);
      setTimeout(() => stickCellUnderDashboard(el), 450);
    });
    editor.on("cursorActivity", () => {
      // keep content flushed
      try { cell.content = editor.getValue(); } catch (_) {}
    });
    if (cell.editLocked) editor.setOption("readOnly", true);

    // long-press small menu (not native huge menu)
    const wrapper = editor.getWrapperElement();
    let lpTimer = null;
    wrapper.addEventListener("touchstart", (e) => {
      lpTimer = setTimeout(() => {
        ctxTarget = { type: "editor", cell, editor };
        showCtx(e.touches[0].clientX, e.touches[0].clientY);
      }, 480);
    }, { passive: true });
    wrapper.addEventListener("touchend", () => clearTimeout(lpTimer));
    wrapper.addEventListener("touchmove", () => clearTimeout(lpTimer));
    // suppress default context menu
    wrapper.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      ctxTarget = { type: "editor", cell, editor };
      showCtx(e.clientX, e.clientY);
    });

    let hintTimer = null;
    editor.on("inputRead", (cm, change) => {
      const ch = (change.text[0] || "");
      if (/[A-Za-z0-9_\\.]/.test(ch)) {
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => {
          if (!cm.state.completionActive) cm.showHint({ hint: pythonHint, completeSingle: false });
        }, 120);
      }
    });
    requestAnimationFrame(() => editor.refresh());
  } else {
    cell.editor = null;
    textarea.addEventListener("input", () => {
      cell.content = textarea.value;
      saveNotebookLocal();
    });
  }

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const a = btn.dataset.action;
      activeCell = cell;

      if (a === "toggle-move-lock") {
        cell.moveLocked = !cell.moveLocked;
        renderCell(cell); markDirty();
        setStatus(cell.moveLocked ? "Move locked" : "Move unlocked", "ready");
        return;
      }
      if (a === "toggle-edit-lock") {
        cell.editLocked = !cell.editLocked;
        if (cell.editor) cell.editor.setOption("readOnly", !!cell.editLocked);
        renderCell(cell); markDirty();
        setStatus(cell.editLocked ? "Edit locked" : "Edit unlocked", "ready");
        return;
      }
      if (a === "run") return runCell(cell);
      if (a === "copy-code") return copyText(cell.editor ? cell.editor.getValue() : cell.content);
      if (a === "copy-output") return copyText(outputEl.innerText || "");
      if (a === "paste") {
        await pasteIntoEditor(cell.editor);
        return;
      }
      if (a === "cut") {
        if (cell.editor) {
          const t = cell.editor.getSelection();
          if (t) { await copyText(t); cell.editor.replaceSelection(""); }
        }
        return;
      }
      if (a === "undo" && cell.editor) return cell.editor.undo();
      if (a === "redo" && cell.editor) return cell.editor.redo();
      if (a === "toggle-size") {
        cell.collapsed = !cell.collapsed;
        if (!cell.collapsed && !cell.editorHeight) cell.editorHeight = 160;
        renderCell(cell); saveNotebookLocal(); return;
      }
      if (a === "toggle-out") {
        cell.outCollapsed = !cell.outCollapsed;
        renderCell(cell); saveNotebookLocal(); return;
      }
      if (a === "preview") {
        const p = el.querySelector(".cell-md-preview");
        if (p) p.innerHTML = simpleMarkdown(cell.content);
        return;
      }
      if (a === "delete") {
        const idx = cells.findIndex((c) => c.id === cell.id);
        if (idx >= 0) cells.splice(idx, 1);
        el.remove(); saveNotebookLocal(); return;
      }
      if (a === "up") {
        if (cell.moveLocked) { setStatus("Move locked — hold title 3s to unlock", "busy"); return; }
        const idx = cells.findIndex((c) => c.id === cell.id);
        if (idx <= 0) return;
        const prev = cells[idx - 1];
        cells[idx - 1] = cell;
        cells[idx] = prev;
        const prevEl = document.getElementById("cell-" + prev.id);
        if (prevEl) notebookEl.insertBefore(el, prevEl);
        markDirty(); saveNotebookLocal(true);
        setStatus("Cell moved up", "ready");
        return;
      }
      if (a === "down") {
        if (cell.moveLocked) { setStatus("Move locked — hold title 3s to unlock", "busy"); return; }
        const idx = cells.findIndex((c) => c.id === cell.id);
        if (idx < 0 || idx >= cells.length - 1) return;
        const next = cells[idx + 1];
        cells[idx + 1] = cell;
        cells[idx] = next;
        const nextEl = document.getElementById("cell-" + next.id);
        if (nextEl) notebookEl.insertBefore(nextEl, el);
        markDirty(); saveNotebookLocal(true);
        setStatus("Cell moved down", "ready");
        return;
      }
      if (a === "maximize") {
        cells.forEach((c) => {
          if (c !== cell && c.maximized) {
            c.maximized = false;
            const o = document.getElementById("cell-" + c.id);
            if (o) {
              o.classList.remove("maximized");
              // restore heights on other cells via re-render
              renderCell(c);
            }
          }
        });
        cell.maximized = !cell.maximized;
        if (cell.maximized) {
          cell._preMax = {
            eh: cell.editorHeight, oh: cell.outputHeight,
            collapsed: cell.collapsed, outCollapsed: cell.outCollapsed
          };
          cell.collapsed = false;
          cell.outCollapsed = false;
        } else if (cell._preMax) {
          cell.editorHeight = cell._preMax.eh;
          cell.outputHeight = cell._preMax.oh;
          cell.collapsed = cell._preMax.collapsed;
          cell.outCollapsed = cell._preMax.outCollapsed;
        }
        renderCell(cell);
        markDirty();
        setStatus(cell.maximized ? "Maximized (~70% code / 30% output)" : "Cell restored", "ready");
        return;
      }
    });
  });

  // Long-press title (~3s) → toggle move lock; long contextmenu → edit lock
  const titlebar = el.querySelector(".cell-titlebar");
  if (titlebar) {
    let lockTimer = null;
    titlebar.addEventListener("touchstart", (e) => {
      if (e.target && e.target.closest && e.target.closest("[data-action=\"rename\"]")) {
        /* allow rename tap; still allow long press */
      }
      lockTimer = setTimeout(() => {
        cell.moveLocked = !cell.moveLocked;
        renderCell(cell);
        markDirty();
        setStatus(cell.moveLocked ? "Move locked 🔒" : "Move unlocked", "ready");
      }, 3000);
    }, { passive: true });
    titlebar.addEventListener("touchend", () => clearTimeout(lockTimer));
    titlebar.addEventListener("touchmove", () => clearTimeout(lockTimer));
    titlebar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cell.editLocked = !cell.editLocked;
      if (cell.editor) cell.editor.setOption("readOnly", !!cell.editLocked);
      renderCell(cell);
      markDirty();
      setStatus(cell.editLocked ? "Edit locked" : "Edit unlocked", "ready");
    });
  }
}

function startRename(cell, titleEl) {
  titleEl.contentEditable = "true";
  titleEl.classList.add("editing");
  titleEl.focus();
  const done = () => {
    titleEl.contentEditable = "false";
    titleEl.classList.remove("editing");
    cell.title = titleEl.textContent.trim() || cell.title;
    saveNotebookLocal();
  };
  titleEl.addEventListener("blur", done, { once: true });
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  });
}

function simpleMarkdown(src) {
  return (src || "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/^### (.*)$/gm,"<h3>$1</h3>").replace(/^## (.*)$/gm,"<h2>$1</h2>")
    .replace(/^# (.*)$/gm,"<h1>$1</h1>").replace(/\\*\\*(.*?)\\*\\*/g,"<strong>$1</strong>")
    .replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\n/g,"<br>");
}

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function copyText(text) {
  text = text == null ? "" : String(text);
  if (hasBridge && typeof AndroidBridge.setClipboardText === "function") {
    try { AndroidBridge.setClipboardText(text); return true; } catch (_) {}
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch (_) { return false; }
}

async function readClipboard() {
  if (hasBridge && typeof AndroidBridge.getClipboardText === "function") {
    try {
      const t = AndroidBridge.getClipboardText();
      if (t != null && t !== "") return t;
    } catch (_) {}
  }
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (_) {}
  return "";
}

async function pasteIntoEditor(editor) {
  if (!editor) return;
  const t = await readClipboard();
  if (t) {
    editor.replaceSelection(t);
    try { editor.focus(); } catch (_) {}
  } else {
    setStatus("Clipboard empty or blocked", "error");
  }
}

async function runCell(cell) {
  if (!isReady || !pyodide || cell.type !== "code") {
    setStatus("Runtime not ready", "error"); return;
  }
  // Flush editor so last typed chars are never lost (before run)
  flushAllEditors();
  if (cell.editor) {
    try {
      if (cell.editor.save) cell.editor.save();
      cell.content = cell.editor.getValue();
      applyAutoTitle(cell);
    } catch (_) {}
  }
  saveNotebookLocal(true);
  // Also persist .ipynb path if known
  if (notebookPath && hasBridge) {
    try { AndroidBridge.saveUserFile(notebookPath, toIpynb()); } catch (_) {}
  }
  const code = cell.content || "";
  const el = document.getElementById("cell-" + cell.id);
  const out = el.querySelector(".cell-output");
  out.classList.remove("error");
  out.textContent = "Running…";
  setStatus("Running…", "busy");

  const importRe = /^\s*(?:import|from)\s+([a-zA-Z0-9_]+)/gm;
  let im; const needed = new Set();
  while ((im = importRe.exec(code))) {
    const mod = im[1];
    if (!["sys","os","io","math","json","re","time","datetime","collections","itertools","functools","traceback","base64","contextlib"].includes(mod))
      needed.add(mod);
  }
  for (const mod of needed) {
    try { await pyodide.runPythonAsync("import " + mod); }
    catch (_) { await ensurePackage(mod); }
  }

  try {
    const result = pyodide.runPython("_capture_run(" + JSON.stringify(code) + ")").toJs({ dict_converter: Object.fromEntries });
    let html = "";
    if (result.stdout) html += escapeHtml(result.stdout);
    if (result.stderr) { html += (html ? "\n" : "") + escapeHtml(result.stderr); cell.error = true; out.classList.add("error"); }
    if (result.images) result.images.forEach((b64) => { html += '<img src="data:image/png;base64,' + b64 + '" />'; });
    if (result.error_line != null) html += "\n[Line " + result.error_line + "] " + (result.error_type || "") + ": " + (result.error_msg || "");
    out.innerHTML = html || "<span style='color:var(--muted)'>(no output)</span>";
    cell.outputHtml = out.innerHTML;
    setStatus("Done", "ready");
    saveNotebookLocal();
  } catch (e) {
    out.textContent = String(e); out.classList.add("error"); cell.error = true;
    setStatus("Error", "error");
  }
}

/* Context menu */
let _ctxIgnoreUntil = 0;

function showCtx(x, y) {
  const m = document.getElementById("ctx-menu");
  if (!m) return;
  m.classList.remove("hidden");
  _ctxIgnoreUntil = Date.now() + 400; // ignore outside-dismiss briefly
  m.style.left = "0px";
  m.style.top = "0px";
  const rect = m.getBoundingClientRect();
  const mw = rect.width || 240;
  const mh = rect.height || 40;
  let left = x + 8;
  let top = y + 28;
  if (left + mw > window.innerWidth - 6) left = window.innerWidth - mw - 6;
  if (left < 6) left = 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, y - mh - 16);
  m.style.left = left + "px";
  m.style.top = top + "px";
}

function hideCtx() {
  const m = document.getElementById("ctx-menu");
  if (m) m.classList.add("hidden");
}

async function handleCtxAction(a) {
  if (!ctxTarget) { hideCtx(); return; }

  // Output box
  if (ctxTarget.type === "output" && ctxTarget.el) {
    const el = ctxTarget.el;
    if (a === "select-all") {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      _ctxIgnoreUntil = Date.now() + 800;
      setStatus("Output selected — use Copy", "ready");
      return;
    }
    hideCtx();
    if (a === "copy") {
      await copyText(el.innerText || "");
      setStatus("Copied output", "ready");
    }
    return;
  }

  if (ctxTarget.type !== "editor" || !ctxTarget.editor) { hideCtx(); return; }
  const cm = ctxTarget.editor;
  try { cm.focus(); } catch (_) {}
  if (a === "select-all") {
    cm.execCommand("selectAll");
    _ctxIgnoreUntil = Date.now() + 800;
    setStatus("Selected — use Copy", "ready");
    return;
  }
  hideCtx();
  if (a === "copy") {
    await copyText(cm.getSelection() || cm.getValue());
    setStatus("Copied", "ready");
  } else if (a === "cut") {
    const t = cm.getSelection();
    if (t) {
      await copyText(t);
      cm.replaceSelection("");
      setStatus("Cut", "ready");
    }
  } else if (a === "paste") {
    await pasteIntoEditor(cm);
  }
}

function wireCtxMenu() {
  const m = document.getElementById("ctx-menu");
  if (!m) return;
  m.querySelectorAll("button").forEach((btn) => {
    const fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCtxAction(btn.dataset.ctx);
    };
    btn.onclick = fire;
    btn.ontouchend = fire;
  });
}
wireCtxMenu();

function dismissFloatingMenus(e) {
  if (Date.now() < _ctxIgnoreUntil) return;
  const t = e && e.target;
  if (!t || !t.closest) return;
  // Context menu
  if (!t.closest("#ctx-menu")) hideCtx();
  // App hamburger menu — close on ANY outside tap
  if (!t.closest("#app-menu") && !t.closest("#btn-menu")) {
    const am = document.getElementById("app-menu");
    if (am) am.classList.add("hidden");
  }
}
document.addEventListener("click", dismissFloatingMenus, true);
document.addEventListener("touchstart", (e) => {
  if (Date.now() < _ctxIgnoreUntil) return;
  const t = e.target;
  if (t && t.closest && t.closest("#ctx-menu")) return;
  if (t && t.closest && (t.closest("#app-menu") || t.closest("#btn-menu"))) return;
  hideCtx();
  const am = document.getElementById("app-menu");
  if (am) am.classList.add("hidden");
}, { passive: true, capture: true });

function setupKeybar() {
  document.querySelectorAll("#keybar .kbtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.key;
      const cm = activeEditor;
      if (key === "ctrl") { ctrlHeld = !ctrlHeld; btn.classList.toggle("active", ctrlHeld); return; }
      if (key === "shift") { shiftHeld = !shiftHeld; btn.classList.toggle("active", shiftHeld); return; }
      if (!cm) return;
      cm.focus();
      if (key === "select-all") return cm.execCommand("selectAll");
      if (key === "copy") { await copyText(cm.getSelection() || cm.getValue()); return; }
      if (key === "cut") {
        const t = cm.getSelection();
        if (t) { await copyText(t); cm.replaceSelection(""); }
        return;
      }
      if (key === "paste") { await pasteIntoEditor(cm); return; }
      if (key === "Tab") {
        if (shiftHeld) cm.indentSelection("subtract");
        else if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.replaceSelection("    ", "end");
        return;
      }
      if (key === "Escape") { if (cm.state.completionActive) cm.state.completionActive.close(); return; }
      const map = { ArrowLeft: "goCharLeft", ArrowRight: "goCharRight", ArrowUp: "goLineUp", ArrowDown: "goLineDown", Home: "goLineStart", End: "goLineEnd" };
      if (map[key]) return cm.execCommand(map[key]);
      if (key.length === 1) cm.replaceSelection(key);
    });
  });
}

function setupKeybarPosition() {
  const bar = document.getElementById("keybar");
  function update() {
    let bottom = 0;
    if (window.visualViewport) {
      const vv = window.visualViewport;
      bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    }
    bar.style.bottom = bottom + "px";
    notebookEl.style.paddingBottom = (48 + 12 + bottom) + "px";
  }
  update();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
  window.addEventListener("resize", update);
  document.addEventListener("focusin", () => setTimeout(update, 300));
  document.addEventListener("focusout", () => setTimeout(update, 300));
}

/* Menu */
document.getElementById("btn-menu").onclick = (e) => {
  e.stopPropagation();
  document.getElementById("app-menu").classList.toggle("hidden");
};
document.querySelectorAll("#app-menu button").forEach((btn) => {
  btn.onclick = () => {
    document.getElementById("app-menu").classList.add("hidden");
    const m = btn.dataset.menu;
    if (m === "settings") openSettings();
    if (m === "packages") openPackages();
    if (m === "browse") openBrowse();
    if (m === "finance") openFinance();
    if (m === "offline") downloadOfflineRuntime();
    if (m === "durable") pickDurableFolder();
    if (m === "file-open") openFilePicker();
    if (m === "file-save") saveNotebookFile();
    if (m === "file-save-as") saveNotebookAs();
    if (m === "file-save-cell") saveActiveCellFile();
    if (m === "migrate") migrateAssetsFolder();
  };
});

function openSettings() {
  const modal = document.getElementById("settings-modal");
  document.getElementById("set-theme").value = settings.theme;
  document.getElementById("set-code-theme").value = settings.codeTheme;
  document.getElementById("set-code-font").value = settings.codeFont;
  document.getElementById("set-fa-font").value = settings.faFont;
  document.getElementById("set-code-size").value = settings.codeSize;
  document.getElementById("set-out-size").value = settings.outSize;
  document.getElementById("set-indent-guides").checked = !!settings.indentGuides;
  document.getElementById("set-line-wrap").checked = !!settings.lineWrap;
  if (hasBridge) {
    document.getElementById("data-root-hint").textContent = "Assets: " + AndroidBridge.getDataRoot();
  }
  modal.classList.remove("hidden");
}
document.getElementById("settings-close").onclick = () => {
  settings.theme = document.getElementById("set-theme").value;
  settings.codeTheme = document.getElementById("set-code-theme").value;
  settings.codeFont = document.getElementById("set-code-font").value;
  settings.faFont = document.getElementById("set-fa-font").value;
  settings.customFontFile = document.getElementById("set-custom-font-file").value;
  settings.codeSize = +document.getElementById("set-code-size").value;
  settings.outSize = +document.getElementById("set-out-size").value;
  settings.indentGuides = document.getElementById("set-indent-guides").checked;
  settings.lineWrap = document.getElementById("set-line-wrap").checked;
  saveSettings(settings); applySettings();
  document.getElementById("settings-modal").classList.add("hidden");
};

function openPackages() {
  setStatus("Scanning packages in assets folder…", "busy");
  document.getElementById("pkg-log").textContent = "";
  document.getElementById("package-modal").classList.remove("hidden");
  if (hasBridge) {
    try {
      const list = JSON.parse(AndroidBridge.listLocalPackages() || "[]");
      document.getElementById("pkg-local-list").textContent =
        list.length ? list.map(p => p.name + " " + (p.version || "")).join("\n") : "(empty)";
    } catch (_) {}
  }
}
document.getElementById("pkg-cancel").onclick = () => document.getElementById("package-modal").classList.add("hidden");
document.getElementById("pkg-install").onclick = async () => {
  const n = document.getElementById("pkg-input").value.trim();
  if (n) await ensurePackage(n);
};

function openBrowse() {
  document.getElementById("browse-modal").classList.remove("hidden");
  if (hasBridge) document.getElementById("browse-root-hint").textContent = "Root: " + AndroidBridge.getDataRoot();
  loadBrowse("packages");
}
document.getElementById("browse-close").onclick = () => document.getElementById("browse-modal").classList.add("hidden");
document.querySelectorAll(".browse-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".browse-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    loadBrowse(tab.dataset.folder);
  };
});
function loadBrowse(folder) {
  const list = document.getElementById("browse-list");
  if (!hasBridge) { list.textContent = "(Android only)"; return; }
  try {
    const items = JSON.parse(AndroidBridge.listFolder(folder || "packages") || "[]");
    list.textContent = items.length ? items.map(it => (it.name || it) + (it.size ? " (" + it.size + " B)" : "")).join("\n") : "(empty)";
  } catch (e) { list.textContent = String(e); }
}

function openFinance() {
  const box = document.getElementById("finance-list");
  box.innerHTML = "";
  FINANCE_PKGS.forEach((p) => {
    const local = hasBridge && AndroidBridge.hasLocalPackage(p.name);
    const row = document.createElement("div");
    row.className = "finance-item";
    row.innerHTML = '<span class="tick">' + (local ? "✓" : "○") + '</span><span class="name"><b>' + p.name + '</b> — ' + p.desc + '</span>';
    const b = document.createElement("button");
    b.textContent = local ? "Load" : "Download";
    b.onclick = async () => { await ensurePackage(p.name); openFinance(); };
    row.appendChild(b);
    box.appendChild(row);
  });
  document.getElementById("finance-modal").classList.remove("hidden");
}
document.getElementById("finance-close").onclick = () => document.getElementById("finance-modal").classList.add("hidden");

function openFilePicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.py,.txt,.json,.tsv,.ipynb";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const text = await f.text();
    if (f.name.endsWith(".ipynb")) {
      try { loadFromIpynb(text); notebookPath = "notebooks/" + f.name; setStatus("Opened " + f.name, "ready"); }
      catch (e) { alert("Invalid notebook: " + e.message); }
      return;
    }
    if (f.name.endsWith(".py")) addCell("code", text, f.name);
    else {
      if (pyodide) pyodide.FS.writeFile("/home/" + f.name, text);
      if (hasBridge) try { AndroidBridge.saveUserFile(f.name, text); } catch (_) {}
      addCell("code", "# Loaded: " + f.name + "\nimport pandas as pd\ndf = pd.read_csv(\"/home/" + f.name + "\")\nprint(df.head())\n", f.name);
    }
  };
  input.click();
}

function openSaveDialog(forceAs) {
  saveNotebookLocal(true);
  const modal = document.getElementById("save-modal");
  const title = document.getElementById("save-modal-title");
  const nameInput = document.getElementById("save-name");
  const pathDisp = document.getElementById("save-path-display");
  title.textContent = forceAs || !notebookPath ? "Save as…" : "Save notebook";
  let defaultName = "notebook.ipynb";
  if (notebookPath) {
    const parts = notebookPath.split("/");
    defaultName = parts[parts.length - 1] || defaultName;
  }
  if (!defaultName.endsWith(".ipynb")) defaultName = defaultName.replace(/\.json$/i, "") + ".ipynb";
  nameInput.value = forceAs ? defaultName.replace(/\.ipynb$/i, "") + "-copy.ipynb" : defaultName;
  if (hasBridge && typeof AndroidBridge.getDataRoot === "function") {
    pathDisp.textContent = AndroidBridge.getDataRoot() + "/notebooks/";
  } else {
    pathDisp.textContent = "notebooks/";
  }
  modal.dataset.forceAs = forceAs ? "1" : "0";
  modal.classList.remove("hidden");
  nameInput.focus();
}

function confirmSaveDialog() {
  const modal = document.getElementById("save-modal");
  let name = (document.getElementById("save-name").value || "notebook.ipynb").trim();
  if (!name) return;
  name = name.replace(/[\\/]/g, "_");
  if (!/\.ipynb$/i.test(name)) name += ".ipynb";
  const data = toIpynb();
  const rel = "notebooks/" + name;
  if (hasBridge) {
    const path = AndroidBridge.saveUserFile(rel, data);
    if (path) {
      notebookPath = rel;
      notebookDirty = false;
      modal.classList.add("hidden");
      alert("Saved:\\n" + path);
      setStatus("Saved: " + path, "ready");
      if (pendingCloseAction) { const a = pendingCloseAction; pendingCloseAction = null; a(true); }
    } else {
      alert("Save failed");
      setStatus("Save failed", "error");
    }
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/x-ipynb+json" }));
    a.download = name; a.click();
    notebookDirty = false;
    modal.classList.add("hidden");
  }
}

function saveNotebookFile() {
  if (notebookPath && !document.getElementById("save-modal").dataset.forceAs) {
    // Quick save to known path
    saveNotebookLocal(true);
    const data = toIpynb();
    if (hasBridge) {
      const path = AndroidBridge.saveUserFile(notebookPath, data);
      if (path) {
        notebookDirty = false;
        setStatus("Saved: " + path, "ready");
        return;
      }
    }
  }
  openSaveDialog(false);
}


window.requestCloseApp = function requestCloseApp() {
  if (!notebookDirty) {
    if (hasBridge && AndroidBridge.finishActivity) AndroidBridge.finishActivity();
    return;
  }
  pendingCloseAction = function() {};
  document.getElementById("unsaved-modal").classList.remove("hidden");
}


function saveActiveCellFile() {
  if (!activeCell) { alert("No active cell"); return; }
  const code = activeCell.editor ? activeCell.editor.getValue() : activeCell.content;
  const name = (activeCell.title || "cell.py").replace(/[^\\w.\\-]+/g, "_");
  if (hasBridge) {
    alert("Saved: " + AndroidBridge.saveUserFile("notebooks/" + name, code));
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
    a.download = name; a.click();
  }
}

document.getElementById("btn-add-code").onclick = () => addCell("code", "");
document.getElementById("btn-add-md").onclick = () => addCell("markdown", "");
document.getElementById("btn-run-all").onclick = async () => {
  flushAllEditors();
  saveNotebookLocal(true);
  setStatus("Running all cells…", "busy");
  for (const c of cells) {
    if (c.type === "code") await runCell(c);
  }
  setStatus("Run all finished", "ready");
};

document.getElementById("btn-add-font").onclick = () => document.getElementById("font-file-input").click();
document.getElementById("set-code-size").oninput = (e) => { document.getElementById("set-code-size-val").textContent = e.target.value; };
document.getElementById("set-out-size").oninput = (e) => { document.getElementById("set-out-size-val").textContent = e.target.value; };

setupKeybar();
setupKeybarPosition();
applySettings();
async function downloadOfflineRuntime() {
  if (!hasBridge) { alert("Android only"); return; }
  if (AndroidBridge.isRuntimeReady()) {
    alert("Offline runtime already ready.\n" + AndroidBridge.getRuntimeDir());
    return;
  }
  if (!confirm("Download Pyodide runtime for offline use? (~30–50MB)")) return;
  setStatus("Downloading offline runtime…", "busy");
  try {
    const result = JSON.parse(AndroidBridge.cacheFullRuntime() || "{}");
    alert(result.ready ? "Offline runtime ready." : "Finished with issues. Check network.");
    setStatus(result.ready ? "Offline runtime ready" : "Runtime incomplete", result.ready ? "ready" : "error");
  } catch (e) {
    alert(String(e));
    setStatus("Runtime download failed", "error");
  }
}

function pickDurableFolder() {
  if (!hasBridge) { alert("Android only"); return; }
  AndroidBridge.pickDurableFolder();
}

window.__onDurableFolderSet = function(uri) {
  setStatus("Durable folder: " + uri, "ready");
};
window.__onAssetsMoved = function(path) {
  setStatus("Assets: " + path, "ready");
  const h = document.getElementById("data-root-hint");
  if (h) h.textContent = "Assets: " + path;
};


function saveNotebookAs() {
  saveNotebookLocal(true);
  const data = JSON.stringify(serializeNotebook(), null, 2);
  let name = prompt("Save as filename:", "notebook-" + Date.now() + ".json");
  if (!name) return;
  if (!/\.json$/i.test(name)) name += ".json";
  name = name.replace(/[\\/]/g, "_");
  if (hasBridge) {
    const path = AndroidBridge.saveUserFile("notebooks/" + name, data);
    if (path) {
      alert("Saved notebook:\n" + path + "\n\nOpen Files app → Documents → JupyterIDE → notebooks");
      setStatus("Saved: " + path, "ready");
    } else alert("Save failed");
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    a.download = name; a.click();
  }
}

function migrateAssetsFolder() {
  if (!hasBridge) { alert("Android only"); return; }
  if (typeof AndroidBridge.migrateToPublicOrPick === "function") {
    AndroidBridge.migrateToPublicOrPick();
  } else if (typeof AndroidBridge.pickDurableFolder === "function") {
    if (confirm("Choose a folder. App will use it for packages, notebooks, runtime.")) {
      AndroidBridge.pickDurableFolder();
    }
  } else {
    alert("Update the Android shell for folder migrate.");
  }
}



// Save / unsaved modal wiring
(function wireSaveUi() {
  const sm = document.getElementById("save-modal");
  if (!sm) return;
  document.getElementById("save-cancel").onclick = () => sm.classList.add("hidden");
  document.getElementById("save-confirm").onclick = () => confirmSaveDialog();
  document.getElementById("save-browse").onclick = () => {
    if (hasBridge && typeof AndroidBridge.pickSaveLocation === "function") {
      AndroidBridge.pickSaveLocation();
    } else {
      alert("Default folder: notebooks/ under assets root");
    }
  };
  const um = document.getElementById("unsaved-modal");
  document.getElementById("unsaved-cancel").onclick = () => um.classList.add("hidden");
  document.getElementById("unsaved-discard").onclick = () => {
    um.classList.add("hidden");
    notebookDirty = false;
    if (hasBridge && typeof AndroidBridge.finishActivity === "function") AndroidBridge.finishActivity();
  };
  document.getElementById("unsaved-save").onclick = () => {
    um.classList.add("hidden");
    openSaveDialog(false);
  };
})();

// Idle sync assets ↔ install cache
setInterval(() => {
  if (!hasBridge) return;
  try {
    if (typeof AndroidBridge.syncAssetsIncremental === "function") {
      AndroidBridge.syncAssetsIncremental();
    }
  } catch (_) {}
}, 45000);

window.__onSavePathPicked = function(path) {
  if (path) {
    notebookPath = path;
    const nameInput = document.getElementById("save-name");
    if (nameInput) {
      const parts = path.split("/");
      nameInput.value = parts[parts.length - 1] || nameInput.value;
    }
    setStatus("Save path: " + path, "ready");
  }
};



/* Floating scroll thumb (Easy Reader style) */
(function setupScrollThumb() {
  const thumb = document.getElementById("scroll-thumb");
  const nb = document.getElementById("notebook");
  if (!thumb || !nb) return;
  function placeThumb() {
    const maxScroll = nb.scrollHeight - nb.clientHeight;
    if (maxScroll <= 8) { thumb.style.display = "none"; return; }
    thumb.style.display = "flex";
    const rect = nb.getBoundingClientRect();
    const ratio = nb.scrollTop / maxScroll;
    const travel = Math.max(20, rect.height - 56);
    const top = rect.top + 8 + ratio * travel;
    thumb.style.top = top + "px";
  }
  nb.addEventListener("scroll", placeThumb, { passive: true });
  window.addEventListener("resize", placeThumb);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", placeThumb);
  placeThumb();
  let dragging = false, startY = 0, startScroll = 0;
  const onStart = (y) => { dragging = true; startY = y; startScroll = nb.scrollTop; };
  const onMove = (y) => {
    if (!dragging) return;
    const maxScroll = nb.scrollHeight - nb.clientHeight;
    const rect = nb.getBoundingClientRect();
    const travel = Math.max(20, rect.height - 56);
    const dy = y - startY;
    nb.scrollTop = Math.max(0, Math.min(maxScroll, startScroll + (dy / travel) * maxScroll));
  };
  const onEnd = () => { dragging = false; };
  thumb.addEventListener("touchstart", (e) => { onStart(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  thumb.addEventListener("touchmove", (e) => { onMove(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  thumb.addEventListener("touchend", onEnd);
  thumb.addEventListener("mousedown", (e) => {
    onStart(e.clientY);
    const mm = (ev) => onMove(ev.clientY);
    const mu = () => { onEnd(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
  });
})();


// Offer Documents assets once
(function offerAssetsMove() {
  if (!hasBridge) return;
  try {
    const flag = localStorage.getItem("jide_assets_prompted");
    if (flag) return;
    localStorage.setItem("jide_assets_prompted", "1");
    setTimeout(() => {
      const root = (typeof AndroidBridge.getDataRoot === "function") ? AndroidBridge.getDataRoot() : "";
      if (root && root.indexOf("/Documents/") >= 0) {
        setStatus("Assets: " + root, "ready");
        return;
      }
      if (confirm("Move all app assets to Documents/JupyterIDE so you can see and back them up?")) {
        if (typeof AndroidBridge.migrateToPublicOrPick === "function") {
          setStatus("Moving assets to Documents…", "busy");
          AndroidBridge.migrateToPublicOrPick();
        }
      }
    }, 1500);
  } catch (_) {}
})();


/* Keybar only while keyboard open (visualViewport) */
(function setupKeybarVisibility() {
  const bar = document.getElementById("keybar");
  if (!bar) return;
  function update() {
    const vv = window.visualViewport;
    if (!vv) {
      bar.classList.remove("hidden-kb");
      return;
    }
    const covered = window.innerHeight - vv.height - vv.offsetTop;
    // keyboard likely open if > 120px covered
    if (covered > 120) {
      bar.classList.remove("hidden-kb");
      bar.style.bottom = Math.max(0, covered - (window.innerHeight - vv.height - vv.offsetTop) + (window.innerHeight - vv.height - vv.offsetTop)) + "px";
      // position above keyboard
      bar.style.bottom = (window.innerHeight - vv.height - vv.offsetTop) > 0
        ? (window.innerHeight - vv.height - vv.offsetTop) + "px"
        : "0px";
      if (activeCell) {
        const el = document.getElementById("cell-" + activeCell.id);
        if (el) stickCellUnderDashboard(el);
      }
    } else {
      bar.classList.add("hidden-kb");
      bar.style.bottom = "0px";
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
  window.addEventListener("focusin", () => setTimeout(update, 100));
  window.addEventListener("focusout", () => setTimeout(update, 100));
  update();
})();

initPyodide();
