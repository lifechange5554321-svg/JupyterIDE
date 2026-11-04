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
const APP_VERSION_FALLBACK = "1.2.6";

function applyAppVersion(v) {
  const ver = (v || window.__APP_VERSION__ || APP_VERSION_FALLBACK || "").toString();
  window.__APP_VERSION__ = ver;
  const el = document.getElementById("app-version");
  if (el) el.textContent = ver.startsWith("v") ? ver : ("v" + ver);
}
applyAppVersion(APP_VERSION_FALLBACK);

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
  codeSize: 14, outSize: 14, indentGuides: true, lineWrap: false,
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

function dashboardBottomY() {
  const dash = document.getElementById("dashboard");
  if (dash) return dash.getBoundingClientRect().bottom;
  const status = document.getElementById("status");
  if (status) return status.getBoundingClientRect().bottom;
  const header = document.querySelector(".header");
  return header ? header.getBoundingClientRect().bottom : 0;
}

function stickCellUnderDashboard(cellEl) {
  if (!cellEl) return;
  try {
    // Maximized cells are fixed under dashboard — do not scroll notebook
    if (cellEl.classList.contains("maximized")) {
      pinMaximizedCell(cellEl);
      return;
    }
    const nb = document.getElementById("notebook");
    if (!nb) return;
    const top = dashboardBottomY() + 2;
    const margin = Math.max(0, top - nb.getBoundingClientRect().top);
    cellEl.style.scrollMarginTop = margin + "px";
    const rect = cellEl.getBoundingClientRect();
    const delta = rect.top - top;
    if (Math.abs(delta) > 1) nb.scrollTop += delta;
  } catch (_) {}
}

function pinMaximizedCell(cellEl) {
  if (!cellEl) return;
  const top = dashboardBottomY();
  cellEl.style.top = top + "px";
  cellEl.style.left = "4px";
  cellEl.style.right = "4px";
  cellEl.style.bottom = "calc(4px + env(safe-area-inset-bottom, 0px))";
  document.documentElement.style.setProperty("--dash-bottom", top + "px");
}

function setMaximizeIsolation(activeCellId, on) {
  const nb = document.getElementById("notebook");
  document.body.classList.toggle("mode-maximized", !!on);
  if (nb) {
    if (on) {
      if (nb.dataset.prevScroll == null) nb.dataset.prevScroll = String(nb.scrollTop || 0);
      nb.dataset.prevOverflow = nb.style.overflow || "";
      nb.style.overflow = "hidden";
    } else {
      nb.style.overflow = nb.dataset.prevOverflow || "";
      const prev = parseInt(nb.dataset.prevScroll || "0", 10);
      delete nb.dataset.prevScroll;
      requestAnimationFrame(() => { try { nb.scrollTop = prev; } catch (_) {} });
    }
  }
  cells.forEach((c) => {
    const el = document.getElementById("cell-" + c.id);
    if (!el) return;
    if (on) {
      if (String(c.id) !== String(activeCellId)) {
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        el.setAttribute("aria-hidden", "true");
      } else {
        el.style.visibility = "visible";
        el.style.pointerEvents = "";
        el.removeAttribute("aria-hidden");
      }
    } else {
      el.style.visibility = "";
      el.style.pointerEvents = "";
      el.removeAttribute("aria-hidden");
      el.style.top = "";
      el.style.left = "";
      el.style.right = "";
      el.style.bottom = "";
    }
  });
}

function layoutMaximizedCell(cell) {
  const cellEl = document.getElementById("cell-" + cell.id);
  if (!cellEl) return;
  pinMaximizedCell(cellEl);
  const wrap = cellEl.querySelector(".editor-wrap");
  const out = cellEl.querySelector(".output-wrap");
  const chrome = (cellEl.querySelector(".cell-chrome") || {}).offsetHeight || 56;
  const grips = 36;
  const usable = Math.max(180, window.innerHeight - dashboardBottomY() - chrome - grips - 8);
  const r = (cell.maxRatio != null) ? cell.maxRatio : 0.7;
  const eh = Math.round(usable * Math.max(0.25, Math.min(0.85, r)));
  const oh = Math.max(48, usable - eh);
  if (wrap) { wrap.style.flex = "none"; wrap.style.height = eh + "px"; }
  if (out) { out.style.flex = "none"; out.style.height = oh + "px"; }
  cell.editorHeight = eh;
  cell.outputHeight = oh;
  cell.maxRatio = eh / usable;
  if (cell.editor) {
    try {
      cell.editor.setSize("100%", eh + "px");
      cell.editor.refresh();
    } catch (_) {}
  }
}

function enterMaximize(cell) {
  // only one maximized
  cells.forEach((c) => {
    if (c !== cell && c.maximized) {
      c.maximized = false;
      const o = document.getElementById("cell-" + c.id);
      if (o) o.classList.remove("maximized");
    }
  });
  cell.maximized = true;
  cell._preMax = {
    eh: cell.editorHeight,
    oh: cell.outputHeight,
    collapsed: cell.collapsed,
    outCollapsed: cell.outCollapsed,
  };
  cell.collapsed = false;
  cell.outCollapsed = false;
  if (cell.maxRatio == null) cell.maxRatio = 0.7;
  renderCell(cell);
  setMaximizeIsolation(cell.id, true);
  setTimeout(() => layoutMaximizedCell(cell), 40);
  setTimeout(() => layoutMaximizedCell(cell), 200);
  setStatus("Maximized — drag ↕ to resize code/output", "ready");
}

function exitMaximize(cell) {
  cell.maximized = false;
  if (cell._preMax) {
    cell.editorHeight = cell._preMax.eh;
    cell.outputHeight = cell._preMax.oh;
    cell.collapsed = cell._preMax.collapsed;
    cell.outCollapsed = cell._preMax.outCollapsed;
    cell._preMax = null;
  }
  setMaximizeIsolation(null, false);
  renderAllCells();
  setStatus("Cell restored", "ready");
}



function applySettings() {
  document.body.classList.toggle("theme-light", settings.theme === "light");
  if (settings.theme === "light" && ["vscode-dark","monokai","dracula"].includes(settings.codeTheme)) {
    settings.codeTheme = "github-light";
  }
  if (settings.theme === "dark" && settings.codeTheme === "github-light") {
    settings.codeTheme = "vscode-dark";
  }
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
      titleLocked: !!c.titleLocked,
    })),
  };
}


/** Top comment lines → title: first comment with English/Persian letters */
function titleFromCode(code) {
  if (!code) return "";
  const lines = String(code).split("\n");
  const hasLetter = (s) => /[A-Za-z\u0600-\u06FF]/.test(s);
  let commentsChecked = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let raw = "";
    if (t.startsWith("#")) raw = t.replace(/^#+\s*/, "");
    else if (t.startsWith("//")) raw = t.replace(/^\/\/\s*/, "");
    else if (t.startsWith("/*")) raw = t.replace(/^\/\*+\s*/, "").replace(/\*+\/$/, "");
    else break;
    commentsChecked++;
    if (commentsChecked > 3) break;
    if (!raw || !hasLetter(raw)) continue;
    let name = raw
      .replace(/[\\/?*"<>|\x00-\x1f]/g, " ")
      .replace(/[^\w\u0600-\u06FF\s.:_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || !hasLetter(name)) continue;
    if (name.length > 64) name = name.slice(0, 64).trim();
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
      cell.editLocked = !!c.editLocked;
      // User title wins when it was manually set
      cell.titleLocked = !!c.titleLocked;
      if (c.title && c.titleLocked) cell.title = c.title;
      else if (!c.titleLocked && (c.type || "code") === "code") {
        cell.titleLocked = false;
        applyAutoTitle(cell);
      }
      // Never leave editor non-typable unless user locked it
      if (cell.editor) {
        try { cell.editor.setOption("readOnly", !!cell.editLocked); } catch (_) {}
      }
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
    // input() → JS prompt (blocking-style via pyodide)
    try {
      pyodide.runPython(`
import js
def _jide_input(prompt=""):
    try:
        fn = getattr(js, "jideBlockingInput", None)
        if fn is not None:
            v = fn(str(prompt) if prompt is not None else "")
        else:
            v = js.prompt(str(prompt) if prompt is not None else "")
        if v is None:
            return ""
        return str(v)
    except Exception:
        return ""
import builtins
builtins.input = _jide_input
`)
    } catch (e) { console.warn("input bridge", e); }
    const ver = pyodide.runPython("import sys; sys.version.split()[0]");
    setStatus("Ready • Python " + ver + " • packages on demand", "ready");
    /* header subtitle hidden — version only in status */

    if (!restoreNotebook()) {
      addCell("code", "# Fast boot: only stdlib loaded\n# import numpy / pandas when you need them\n\nprint('Hello from Jupyter IDE')\n");
      addCell("markdown", "## Tip\nUse **☰ → Finance checklist** to download market libraries once.");
    }
    // One-time unlock after typing-fix version (accidental locks from older builds)
    try {
      if (!localStorage.getItem("jide_typing_fix_104")) {
        localStorage.setItem("jide_typing_fix_104", "1");
        window.globalEditLocked = false;
        cells.forEach((c) => {
          c.editLocked = false;
          if (c.editor) c.editor.setOption("readOnly", false);
        });
        if (typeof syncLockButtons === "function") syncLockButtons();
      }
    } catch (_) {}
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
  const t = type || "code";
  const body = content || "";
  let finalTitle = title;
  let titleLocked = false;
  if (t === "code") {
    // Auto name from top comments; user rename later sets titleLocked
    if (finalTitle === undefined || finalTitle === null || finalTitle === "") {
      finalTitle = titleFromCode(body) || ("cell-" + id + ".py");
      titleLocked = false;
    }
  } else {
    if (!finalTitle) finalTitle = "markdown-" + id;
  }
  const cell = {
    id, type: t,
    title: finalTitle,
    content: body, editorHeight: 160, outputHeight: 120,
    collapsed: false, outCollapsed: false, editor: null, outputHtml: "", error: false,
    editLocked: false, titleLocked: titleLocked, maximized: false,
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

function renderAllCells() {
  flushAllEditors();
  const nb = document.getElementById("notebook");
  if (!nb) return;
  cells.forEach((c) => {
    if (c.editor) {
      try { c.content = c.editor.getValue(); } catch (_) {}
      try { c.editor.toTextArea(); } catch (_) {}
      c.editor = null;
    }
  });
  nb.innerHTML = "";
  cells.forEach((c) => renderCell(c));
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
        <button type="button" class="cell-type-badge ${cell.type === "code" ? "" : "md"}" data-action="${cell.type === "code" ? "refresh-title" : "noop"}" title="${cell.type === "code" ? "Tap: read title from code" : ""}">${cell.type === "code" ? "CODE" : "MD"}</button>
        <span class="cell-title" data-action="rename">${escapeHtml(cell.title || "")}</span>
        <span class="cell-lock-badge" data-action="lock-hint">${cell.editLocked ? "✎🔒" : ""}</span>
      </div>
      <div class="cell-toolbar">
        <button data-action="undo" title="Undo">↶</button>
        <button data-action="redo" title="Redo">↷</button>
        <button data-action="minimize-cell" title="Minimize cell (code+output)">${(cell.collapsed && cell.outCollapsed) ? "□" : "–"}</button>
        <button data-action="maximize" title="Maximize">${cell.maximized ? "❐" : "⛶"}</button>
        <button data-action="toggle-edit-lock" class="${cell.editLocked ? "lock-on" : ""}" title="Edit lock">✎</button>
        <button data-action="up" title="Move up">↑</button>
        <button data-action="down" title="Move down">↓</button>
        <button data-action="delete" title="Delete">×</button>
        <span class="spacer"></span>
        ${cell.type === "code" ? '<button class="run" data-action="run" title="Run">▶</button>' : '<button data-action="preview" title="Preview">◉</button>'}
      </div>
    </div>
    <div class="editor-wrap ${cell.collapsed ? "collapsed" : ""}" style="${cell.maximized ? ("flex:" + ((cell.maxRatio||0.7)*100).toFixed(1) + " 1 0;height:auto;") : ("height:"+eh+"px")}">
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
      <div class="output-wrap ${cell.outCollapsed ? "collapsed" : ""}" style="${cell.maximized ? ("flex:" + ((1-(cell.maxRatio||0.7))*100).toFixed(1) + " 1 0;height:auto;") : ("height:"+oh+"px")}">
        <div class="cell-output ${cell.error ? "error" : ""}" tabindex="0"></div>
      </div>
      <div class="resize-handle" data-resize="output"><span class="grip"></span><span class="grip-btn">↕</span></div>
    </div>
  `;

  const textarea = el.querySelector(".cell-editor");
  const wrap = el.querySelector(".editor-wrap");
  const outWrap = el.querySelector(".output-wrap");
  const outputEl = el.querySelector(".cell-output");
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
  // Long-press edit-lock button toggles this cell's edit lock
  const editLockBtn = el.querySelector('[data-action="toggle-edit-lock"]');
  if (editLockBtn) {
    editLockBtn.title = "Long-press to lock/unlock edit";
    // prevent native Android/iOS menu
    editLockBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
    wireLongPress(editLockBtn, 1800, () => {
      cell.editLocked = !cell.editLocked;
      if (cell.editor) cell.editor.setOption("readOnly", !!cell.editLocked);
      renderCell(cell); markDirty();
      setStatus(cell.editLocked ? "Cell edit locked" : "Cell edit unlocked", "ready");
    });
  }


  // resize ONLY via center .grip-btn
  const edHandle = el.querySelector('[data-resize="editor"] .grip-btn') || el.querySelector('[data-resize="editor"]');
  const outHandle = el.querySelector('[data-resize="output"] .grip-btn') || el.querySelector('[data-resize="output"]');
  function applyMaxLayout(editorH) {
    const chrome = (el.querySelector(".cell-chrome") || {}).offsetHeight || 56;
    const grips = 32;
    const parentH = el.classList.contains("maximized")
      ? (window.innerHeight - dashboardBottomY() - 8)
      : el.getBoundingClientRect().height;
    const usable = Math.max(180, parentH - chrome - grips);
    let eh = Math.max(64, Math.min(usable - 48, editorH));
    let oh = Math.max(48, usable - eh);
    cell.editorHeight = eh;
    cell.outputHeight = oh;
    cell.maxRatio = eh / usable;
    wrap.style.flex = "none";
    outWrap.style.flex = "none";
    wrap.style.height = eh + "px";
    outWrap.style.height = oh + "px";
    if (cell.editor) {
      cell.editor.setSize("100%", eh + "px");
      cell.editor.refresh();
    }
  }

  bindResize(
    edHandle,
    () => wrap.getBoundingClientRect().height,
    (h) => {
      if (cell.maximized) applyMaxLayout(h);
      else {
        wrap.style.height = h + "px";
        cell.editorHeight = h;
        if (cell.editor) { cell.editor.setSize("100%", h + "px"); cell.editor.refresh(); }
      }
    },
    64, 1400,
    null
  );
  bindResize(
    outHandle,
    () => outWrap.getBoundingClientRect().height,
    (h) => {
      if (cell.maximized) {
        const chrome = (el.querySelector(".cell-chrome") || {}).offsetHeight || 56;
        const parentH = window.innerHeight - dashboardBottomY() - 8;
        const usable = Math.max(180, parentH - chrome - 32);
        applyMaxLayout(usable - h);
      } else {
        outWrap.style.height = h + "px";
        cell.outputHeight = h;
      }
    },
    28, 1000, null
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
      fixedGutter: true,
      inputStyle: "textarea",
      indentUnit: 4, tabSize: 4, indentWithTabs: false,
      electricChars: false,
      autoCloseBrackets: true,
      matchBrackets: true,
      lineWrapping: !!settings.lineWrap,
      viewportMargin: 50,
      dragDrop: false,
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
    try {
      const inp = editor.getInputField();
      if (inp) {
        inp.removeAttribute("readonly");
        inp.removeAttribute("disabled");
        inp.setAttribute("autocomplete", "off");
        inp.setAttribute("autocorrect", "off");
        inp.setAttribute("autocapitalize", "off");
        inp.setAttribute("spellcheck", "false");
      }
    } catch (_) {}
    let _saveDeb = null;
    editor.on("change", () => {
      cell.content = editor.getValue();
      markDirty();
      clearTimeout(_saveDeb);
      _saveDeb = setTimeout(() => saveNotebookLocal(true), 800);
    });
    editor.on("blur", () => {
      cell.content = editor.getValue();
      applyAutoTitle(cell);
      saveNotebookLocal(true);
    });
    editor.on("focus", () => {
      activeEditor = editor; activeCell = cell;
      const locked = !!cell.editLocked || !!window.globalEditLocked;
      try { editor.setOption("readOnly", locked); } catch (_) {}
      // Delay pin so native selection gesture is not interrupted by scroll
      try {
        if (cell.maximized) pinMaximizedCell(el);
        else {
          setTimeout(() => {
            try {
              if (!editor.somethingSelected()) stickCellUnderDashboard(el);
            } catch (_) {}
          }, 350);
        }
      } catch (_) {}
    });
    editor.setOption("readOnly", !!cell.editLocked || !!window.globalEditLocked);

    // === Selection / long-press menu (restored from v0.9.1 behavior) ===
    // Simple: 480ms long-press → menu. Copy uses LIVE getSelection() || getValue().
    const wrapper = editor.getWrapperElement();
    wrapper.style.webkitUserSelect = "text";
    wrapper.style.userSelect = "text";
    let lpTimer = null;
    const bindCtx = () => {
      ctxTarget = { type: "editor", cell, editor };
    };
    wrapper.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        bindCtx();
        showCtx(t.clientX, t.clientY);
      }, 480);
    }, { passive: true });
    wrapper.addEventListener("touchmove", () => { clearTimeout(lpTimer); }, { passive: true });
    wrapper.addEventListener("touchend", () => { clearTimeout(lpTimer); }, { passive: true });
    wrapper.addEventListener("touchcancel", () => { clearTimeout(lpTimer); }, { passive: true });
    wrapper.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      bindCtx();
      showCtx(e.clientX, e.clientY);
    });

    // Virtual Ctrl from keybar applies to real soft-keyboard keys (Acode-style sticky modifier)
    editor.on("keydown", (cm, e) => {
      if (!ctrlHeld) return;
      const k = (e.key || "").toLowerCase();
      if (k === "a") { e.preventDefault(); cm.execCommand("selectAll"); return; }
      if (k === "c") {
        e.preventDefault();
        const t = cm.getSelection();
        if (t) copyText(t);
        return;
      }
      if (k === "x") {
        e.preventDefault();
        const t = cm.getSelection();
        if (t) { copyText(t); cm.replaceSelection(""); }
        return;
      }
      if (k === "v") {
        e.preventDefault();
        pasteIntoEditor(cm);
        return;
      }
      if (k === "z") { e.preventDefault(); cm.undo(); return; }
      if (k === "y") { e.preventDefault(); cm.redo(); return; }
    });

    /* Autocomplete: Ctrl-Space only — do NOT rewrite input (was corrupting typing) */

    requestAnimationFrame(() => {
      try {
        editor.setSize("100%", (cell.editorHeight || 160) + "px");
        editor.refresh();
      } catch (_) {}
    });
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

      if (a === "refresh-title") {
        // User asks to take name from code again (overrides previous manual name)
        cell.titleLocked = false;
        const code = cell.editor ? cell.editor.getValue() : (cell.content || "");
        const auto = titleFromCode(code);
        if (auto) {
          cell.title = auto;
          setStatus("Title from code: " + auto, "ready");
        } else {
          setStatus("No title found in top comments", "busy");
        }
        renderCell(cell);
        markDirty(); saveNotebookLocal(true);
        return;
      }
      if (a === "toggle-move-lock") {
        cell.moveLocked = !cell.moveLocked;
        renderCell(cell); markDirty();
        setStatus(cell.moveLocked ? "Move locked" : "Move unlocked", "ready");
        return;
      }
      if (a === "toggle-edit-lock") {
        // only long-press toggles (see editLockBtn wiring)
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
      if (a === "minimize-cell" || a === "toggle-size") {
        const allMin = cell.collapsed && cell.outCollapsed;
        cell.collapsed = !allMin;
        cell.outCollapsed = !allMin;
        if (!cell.collapsed && !cell.editorHeight) cell.editorHeight = 160;
        if (!cell.outCollapsed && !cell.outputHeight) cell.outputHeight = 120;
        renderCell(cell); markDirty(); saveNotebookLocal(true); return;
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
        openCloseCellDialog(cell, el);
        return;
      }
      if (a === "up") {
        if (window.globalMoveLocked) { setStatus("Move locked from dashboard", "busy"); return; }
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
        if (window.globalMoveLocked) { setStatus("Move locked from dashboard", "busy"); return; }
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
        if (cell.maximized) exitMaximize(cell);
        else enterMaximize(cell);
        markDirty();
        return;
      }
    });
  });
}

function startRename(cell, titleEl) {
  titleEl.contentEditable = "true";
  titleEl.classList.add("editing");
  titleEl.focus();
  const prev = cell.title || "";
  const done = () => {
    titleEl.contentEditable = "false";
    titleEl.classList.remove("editing");
    const t = titleEl.textContent.trim();
    if (t && t !== prev) {
      cell.title = t;
      cell.titleLocked = true; // user name has priority over auto
      setStatus("Title set by user", "ready");
    } else if (t) {
      cell.title = t;
    } else {
      titleEl.textContent = prev;
    }
    markDirty();
    saveNotebookLocal(true);
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

async function restartKernel() {
  if (!pyodide) { setStatus("Runtime not ready", "error"); return; }
  try {
    await pyodide.runPythonAsync(`
import sys
# Keep interpreter + imported modules; drop user names from notebook namespace
_ns = _namespace
_keep = {"__name__", "__doc__", "__package__", "__loader__", "__spec__", "__builtins__"}
_mods = set(sys.modules.keys())
for _k in list(_ns.keys()):
    if _k in _keep:
        continue
    _v = _ns.get(_k)
    # keep module objects still in sys.modules
    if _k in _mods or (hasattr(_v, "__name__") and getattr(_v, "__name__", None) in _mods):
        continue
    if isinstance(_v, type(sys)):
        continue
    try:
        del _ns[_k]
    except Exception:
        pass
`)
    setStatus("Kernel restarted — user variables cleared", "ready");
  } catch (e) {
    setStatus("Restart failed: " + e, "error");
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
  /* Acode selectionMenu rules:
     - copy/cut: only when something selected
     - paste/selectall: always
     - always use LIVE editor state, never stale snapshot
     - never setCursor when opening/using menu
  */
  if (!ctxTarget) { hideCtx(); return; }

  if (ctxTarget.type === "output" && ctxTarget.el) {
    const el = ctxTarget.el;
    if (a === "select-all") {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      _ctxIgnoreUntil = Date.now() + 1000;
      setStatus("Output selected — Copy", "ready");
      return;
    }
    hideCtx();
    if (a === "copy" || a === "copy-line") {
      const t = el.innerText || "";
      if (t) await copyText(t);
      setStatus(t ? "Copied output" : "Empty output", t ? "ready" : "busy");
    }
    return;
  }

  if (ctxTarget.type !== "editor" || !ctxTarget.editor) { hideCtx(); return; }
  const cm = ctxTarget.editor;
  try { cm.focus(); } catch (_) {}

  if (a === "select-all") {
    cm.execCommand("selectAll");
    _ctxIgnoreUntil = Date.now() + 1500;
    setStatus("All selected — tap Copy or Cut", "ready");
    return; // keep menu open (Acode flow)
  }

  if (a === "copy") {
    if (!cm.somethingSelected()) {
      setStatus("Select text first", "busy");
      return;
    }
    const t = cm.getSelection();
    hideCtx();
    const ok = await copyText(t);
    setStatus(ok ? ("Copied " + t.length + " chars") : "Copy failed", ok ? "ready" : "error");
    return;
  }

  if (a === "cut") {
    if (!cm.somethingSelected()) {
      setStatus("Select text first", "busy");
      return;
    }
    const t = cm.getSelection();
    hideCtx();
    await copyText(t);
    cm.replaceSelection("");
    markDirty(); saveNotebookLocal(true);
    setStatus("Cut " + t.length + " chars", "ready");
    return;
  }

  if (a === "copy-line") {
    hideCtx();
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line) || "";
    if (line) await copyText(line);
    setStatus(line ? ("Copied line " + (cur.line + 1)) : "Empty line", line ? "ready" : "busy");
    return;
  }

  if (a === "cut-line") {
    hideCtx();
    try {
      const cur = cm.getCursor();
      const lineNo = cur.line;
      const line = cm.getLine(lineNo) || "";
      if (line) await copyText(line);
      const from = { line: lineNo, ch: 0 };
      const last = cm.lastLine();
      if (lineNo < last) cm.replaceRange("", from, { line: lineNo + 1, ch: 0 });
      else if (lineNo > 0) cm.replaceRange("", { line: lineNo - 1, ch: cm.getLine(lineNo - 1).length }, { line: lineNo, ch: line.length });
      else cm.replaceRange("", from, { line: lineNo, ch: line.length });
      markDirty(); saveNotebookLocal(true);
      setStatus("Cut line " + (lineNo + 1), "ready");
    } catch (_) { setStatus("Cut line failed", "error"); }
    return;
  }

  if (a === "paste") {
    hideCtx();
    await pasteIntoEditor(cm);
    return;
  }
  hideCtx();
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
  if (t && t.closest && t.closest("#keybar")) return;
  if (t && t.closest && (t.closest("#app-menu") || t.closest("#btn-menu"))) return;
  hideCtx();
  const am = document.getElementById("app-menu");
  if (am) am.classList.add("hidden");
}, { passive: true, capture: true });

function setupKeybar() {
  // Pattern from Acode QuickTools: sticky modifiers + real key/command dispatch
  function resolveCm() {
    if (activeEditor) return activeEditor;
    if (typeof cells !== "undefined") {
      for (const c of cells) if (c.editor) return c.editor;
    }
    const el = document.querySelector(".CodeMirror");
    return el && el.CodeMirror ? el.CodeMirror : null;
  }
  function sendKey(cm, key, keyCode) {
    // Dispatch into CodeMirror like a physical key (honors keyMap + modifiers)
    const ev = {
      key: key,
      code: key.length === 1 ? ("Key" + key.toUpperCase()) : key,
      keyCode: keyCode,
      which: keyCode,
      ctrlKey: !!ctrlHeld,
      shiftKey: !!shiftHeld,
      altKey: false,
      metaKey: false,
      preventDefault: function () { this.defaultPrevented = true; },
      defaultPrevented: false,
      stopPropagation: function () {},
      type: "keydown",
      target: cm.getInputField && cm.getInputField(),
    };
    try {
      if (typeof cm.triggerOnKeyDown === "function") cm.triggerOnKeyDown(ev);
      else cm.getInputField().dispatchEvent(new KeyboardEvent("keydown", {
        key: key, keyCode: keyCode, which: keyCode,
        ctrlKey: !!ctrlHeld, shiftKey: !!shiftHeld, bubbles: true, cancelable: true
      }));
    } catch (_) {}
  }
  async function fireKey(key, btn) {
    const cm = resolveCm();
    if (key === "ctrl") {
      ctrlHeld = !ctrlHeld;
      if (btn) btn.classList.toggle("active", ctrlHeld);
      document.querySelectorAll('#keybar [data-key="ctrl"]').forEach((b) => b.classList.toggle("active", ctrlHeld));
      if (cm) try { cm.focus(); } catch (_) {}
      setStatus(ctrlHeld ? "Ctrl sticky ON — then All / letter" : "Ctrl off", ctrlHeld ? "busy" : "ready");
      return;
    }
    if (key === "shift") {
      shiftHeld = !shiftHeld;
      if (btn) btn.classList.toggle("active", shiftHeld);
      document.querySelectorAll('#keybar [data-key="shift"]').forEach((b) => b.classList.toggle("active", shiftHeld));
      if (cm) try { cm.focus(); } catch (_) {}
      setStatus(shiftHeld ? "Shift sticky ON" : "Shift off", shiftHeld ? "busy" : "ready");
      return;
    }
    if (!cm) {
      setStatus("Tap inside code first", "busy");
      return;
    }
    try { cm.focus(); } catch (_) {}

    // Commands (Acode-style action: command)
    if (key === "select-all") { cm.execCommand("selectAll"); setStatus("Select all", "ready"); return; }
    if (key === "copy") {
      if (!cm.somethingSelected()) { setStatus("Select text first (or Select all)", "busy"); return; }
      const t = cm.getSelection();
      if (t) { await copyText(t); setStatus("Copied " + t.length + " chars", "ready"); }
      return;
    }
    if (key === "cut") {
      const t = cm.getSelection();
      if (t) { await copyText(t); cm.replaceSelection(""); setStatus("Cut", "ready"); }
      else setStatus("Select text first", "busy");
      return;
    }
    if (key === "paste") { await pasteIntoEditor(cm); return; }

    // Keys by code (Acode: action key + keyCode)
    const keyCodes = {
      Tab: 9, Escape: 27,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Home: 36, End: 35,
    };
    if (key === "Tab") {
      if (shiftHeld) cm.indentSelection("subtract");
      else if (cm.somethingSelected()) cm.indentSelection("add");
      else cm.replaceSelection("    ", "end");
      return;
    }
    if (key === "Escape") {
      if (cm.state.completionActive) cm.state.completionActive.close();
      // drop sticky mods
      ctrlHeld = false; shiftHeld = false;
      document.querySelectorAll("#keybar .kbtn.active").forEach((b) => b.classList.remove("active"));
      return;
    }
    if (keyCodes[key] != null) {
      // With sticky shift: extend selection (AOSP-like)
      if (shiftHeld && (key.startsWith("Arrow") || key === "Home" || key === "End")) {
        const head = cm.getCursor("head");
        const anchor = cm.getCursor("anchor");
        let next = head;
        if (key === "ArrowLeft") next = cm.findPosH(head, -1, ctrlHeld ? "word" : "char", false);
        else if (key === "ArrowRight") next = cm.findPosH(head, 1, ctrlHeld ? "word" : "char", false);
        else if (key === "ArrowUp") { const r = cm.findPosV(head, -1, "line"); next = r.pos || r; }
        else if (key === "ArrowDown") { const r = cm.findPosV(head, 1, "line"); next = r.pos || r; }
        else if (key === "Home") next = ctrlHeld ? { line: 0, ch: 0 } : { line: head.line, ch: 0 };
        else if (key === "End") next = ctrlHeld ? { line: cm.lastLine(), ch: (cm.getLine(cm.lastLine()) || "").length }
          : { line: head.line, ch: (cm.getLine(head.line) || "").length };
        cm.setSelection(anchor, next);
        return;
      }
      if (ctrlHeld && (key === "ArrowLeft" || key === "ArrowRight")) {
        cm.execCommand(key === "ArrowLeft" ? "goWordLeft" : "goWordRight");
        return;
      }
      sendKey(cm, key, keyCodes[key]);
      // Fallback if keyMap did not move
      const map = {
        ArrowLeft: "goCharLeft", ArrowRight: "goCharRight",
        ArrowUp: "goLineUp", ArrowDown: "goLineDown",
        Home: "goLineStart", End: "goLineEnd"
      };
      if (map[key]) cm.execCommand(map[key]);
      return;
    }
    // Single character insert / ctrl+letter
    if (key && key.length === 1) {
      if (ctrlHeld) {
        const k = key.toLowerCase();
        if (k === "a") { cm.execCommand("selectAll"); setStatus("Select all", "ready"); return; }
        if (k === "c") {
          const t = cm.getSelection();
          if (t) { await copyText(t); setStatus("Copied", "ready"); }
          return;
        }
        if (k === "x") {
          const t = cm.getSelection();
          if (t) { await copyText(t); cm.replaceSelection(""); setStatus("Cut", "ready"); }
          return;
        }
        if (k === "v") { await pasteIntoEditor(cm); return; }
        if (k === "z") { cm.undo(); return; }
        if (k === "y") { cm.redo(); return; }
      }
      cm.replaceSelection(shiftHeld ? key.toUpperCase() : key);
    }
  }
  document.querySelectorAll("#keybar .kbtn").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); });
    let lastFire = 0;
    const run = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastFire < 220) return;
      lastFire = now;
      fireKey(btn.dataset.key, btn);
    };
    btn.addEventListener("touchend", run, { passive: false });
    btn.addEventListener("click", run);
  });
}




function setupKeybarPosition() {
  /* merged into setupKeybarVisibility — keep no-op for callers */
}

/* Menu */
const btnOpen = document.getElementById("btn-open-file");
if (btnOpen) btnOpen.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openFilePicker(); };

document.getElementById("btn-menu").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  const am = document.getElementById("app-menu");
  const opening = am.classList.contains("hidden");
  am.classList.toggle("hidden");
  if (opening) {
    // ignore outside-dismiss for a moment so the opening tap doesn't close it
    window._ctxIgnoreUntil = Date.now() + 400;
  }
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
    if (m === "file-open-notebook") openFilePicker(".ipynb");
    if (m === "file-save") saveNotebookFile();
    if (m === "file-save-as") saveNotebookAs();
    if (m === "file-close") closeNotebook();
    if (m === "kernel-restart") restartKernel();
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

function openFilePicker(accept) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept || ".csv,.py,.txt,.json,.tsv,.ipynb,.xlsx";
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


function openCloseCellDialog(cell, el) {
  const modal = document.getElementById("close-cell-modal");
  if (!modal) {
    // fallback
    if (!confirm("Close cell?")) return;
    const idx = cells.findIndex((c) => c.id === cell.id);
    if (idx >= 0) cells.splice(idx, 1);
    el.remove(); markDirty(); saveNotebookLocal(true);
    return;
  }
  const py = document.getElementById("close-save-py");
  const ipynb = document.getElementById("close-save-ipynb");
  const nosave = document.getElementById("close-no-save");
  py.checked = true;
  ipynb.checked = false;
  nosave.checked = false;
  nosave.onchange = () => {
    if (nosave.checked) { py.checked = false; ipynb.checked = false; }
  };
  py.onchange = () => { if (py.checked) nosave.checked = false; };
  ipynb.onchange = () => { if (ipynb.checked) nosave.checked = false; };
  modal.classList.remove("hidden");
  const ok = document.getElementById("close-cell-ok");
  const cancel = document.getElementById("close-cell-cancel");
  const cleanup = () => {
    ok.onclick = null;
    cancel.onclick = null;
    modal.classList.add("hidden");
  };
  cancel.onclick = () => cleanup();
  ok.onclick = () => {
    const doPy = py.checked && !nosave.checked;
    const doNb = ipynb.checked && !nosave.checked;
    if (doPy) {
      flushAllEditors();
      const code = cell.editor ? cell.editor.getValue() : (cell.content || "");
      let name = (cell.title || ("cell-" + cell.id)).replace(/[\\/:*?"<>|]/g, "_");
      if (!name.endsWith(".py")) name += ".py";
      if (hasBridge) {
        const p = AndroidBridge.saveUserFile("notebooks/" + name, code);
        if (p) setStatus("Saved: " + p, "ready");
      }
    }
    if (doNb) {
      try { openSaveDialog(false); } catch (_) {}
    }
    const idx = cells.findIndex((c) => c.id === cell.id);
    if (idx >= 0) cells.splice(idx, 1);
    el.remove();
    markDirty();
    saveNotebookLocal(true);
    setStatus("Cell closed", "ready");
    cleanup();
  };
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
  const fmtEl = document.getElementById("save-format");
  if (fmtEl) fmtEl.value = "ipynb";
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
  let name = (document.getElementById("save-name").value || "notebook").trim();
  if (!name) return;
  name = name.replace(/[\\/]/g, "_");
  const fmtEl = document.getElementById("save-format");
  const fmt = fmtEl ? fmtEl.value : "ipynb";
  let data, mime, rel;
  if (fmt === "py") {
    if (!/\.py$/i.test(name)) name = name.replace(/\.ipynb$/i, "") + ".py";
    flushAllEditors();
    data = cells.filter(c => c.type === "code").map(c => c.content || "").join("\n\n");
    mime = "text/x-python";
  } else {
    if (!/\.ipynb$/i.test(name)) name = name.replace(/\.py$/i, "").replace(/\.json$/i, "") + ".ipynb";
    data = toIpynb();
    mime = "application/x-ipynb+json";
  }
  rel = "notebooks/" + name;
  if (hasBridge) {
    const path = AndroidBridge.saveUserFile(rel, data);
    if (path) {
      if (fmt === "ipynb") notebookPath = rel;
      notebookDirty = false;
      modal.classList.add("hidden");
      setStatus("Saved: " + path, "ready");
      if (pendingCloseAction) { const a = pendingCloseAction; pendingCloseAction = null; a(true); }
    } else {
      setStatus("Save failed", "error");
    }
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: mime }));
    a.download = name; a.click();
    notebookDirty = false;
    modal.classList.add("hidden");
    setStatus("Saved: " + name, "ready");
  }
}

function closeNotebook() {
  const finish = () => {
    cells = [];
    notebookEl.innerHTML = "";
    cellIdCounter = 0;
    notebookPath = "";
    notebookDirty = false;
    addCell("code", "# New notebook\nprint('ready')\n");
    setStatus("Notebook closed", "ready");
  };
  if (!notebookDirty) { finish(); return; }
  const modal = document.getElementById("unsaved-modal");
  if (!modal) {
    if (confirm("Unsaved changes. Close without saving?")) finish();
    return;
  }
  modal.classList.remove("hidden");
  const saveBtn = document.getElementById("unsaved-save");
  const discard = document.getElementById("unsaved-discard");
  const cancel = document.getElementById("unsaved-cancel");
  const cleanup = () => { modal.classList.add("hidden"); };
  if (saveBtn) saveBtn.onclick = () => { cleanup(); pendingCloseAction = () => finish(); saveNotebookFile(); };
  if (discard) discard.onclick = () => { cleanup(); finish(); };
  if (cancel) cancel.onclick = () => cleanup();
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
    thumb.style.display = "block";
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
  thumb.addEventListener("touchstart", (e) => { thumb.classList.add("dragging"); onStart(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  thumb.addEventListener("touchmove", (e) => { onMove(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  thumb.addEventListener("touchend", () => { thumb.classList.remove("dragging"); onEnd(); });
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



/* Keybar: hide until keyboard; slide up from bottom and sit above keyboard */
(function setupKeybarVisibility() {
  const bar = document.getElementById("keybar");
  if (!bar) return;
  function keyboardHeight() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    return kb > 100 ? kb : 0;
  }
  function update() {
    const kb = keyboardHeight();
    if (kb > 0) {
      bar.style.bottom = kb + "px";
      bar.classList.add("show-kb");
      bar.classList.remove("hidden-kb");
      const pad = Math.max(window.innerHeight * 0.55, 48 + 12 + kb);
      if (notebookEl) notebookEl.style.paddingBottom = pad + "px";
      if (activeCell) {
        const el = document.getElementById("cell-" + activeCell.id);
        if (el) {
          try { stickCellUnderDashboard(el); } catch (_) {}
          setTimeout(() => { try { stickCellUnderDashboard(el); } catch (_) {} }, 80);
          setTimeout(() => { try { stickCellUnderDashboard(el); } catch (_) {} }, 220);
        }
      }
    } else {
      bar.classList.remove("show-kb");
      bar.style.bottom = "0px";
      // Do not yank scroll/layout back when keyboard closes
      if (notebookEl) notebookEl.style.paddingBottom = (window.innerHeight * 0.55) + "px";
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
  window.addEventListener("resize", update);
  document.addEventListener("focusin", () => setTimeout(update, 50));
  document.addEventListener("focusout", () => setTimeout(update, 180));
  update();
})();

/* Dashboard global locks — composite icons, state via class only */
window.globalMoveLocked = false;
window.globalEditLocked = false;

function syncLockButtons() {
  const bm = document.getElementById("btn-lock-move");
  const be = document.getElementById("btn-lock-edit");
  if (bm) {
    bm.classList.toggle("active-lock", !!window.globalMoveLocked);
    bm.classList.toggle("unlocked", !window.globalMoveLocked);
    bm.setAttribute("aria-pressed", window.globalMoveLocked ? "true" : "false");
    bm.title = window.globalMoveLocked ? "جابه‌جایی همه باز شود" : "جابه‌جایی همه قفل شود";
  }
  if (be) {
    be.classList.toggle("active-lock", !!window.globalEditLocked);
    be.classList.toggle("unlocked", !window.globalEditLocked);
    be.setAttribute("aria-pressed", window.globalEditLocked ? "true" : "false");
    be.title = window.globalEditLocked ? "ویرایش همه باز شود" : "ویرایش همه قفل شود";
  }
}

function setAllEditLocked(locked) {
  window.globalEditLocked = !!locked;
  cells.forEach((c) => {
    c.editLocked = !!locked;
    if (c.editor) {
      try { c.editor.setOption("readOnly", !!locked); } catch (_) {}
    }
  });
  cells.forEach((c) => {
    try { renderCell(c); } catch (_) {}
  });
  syncLockButtons();
  setStatus(locked ? "All cells: edit locked" : "All cells: edit unlocked", "ready");
  try { saveNotebookLocal(true); } catch (_) {}
}

function wireLongPress(el, ms, fn) {
  if (!el || el.dataset.lpWired) return;
  el.dataset.lpWired = "1";
  let t = null;
  const clear = () => { if (t) clearTimeout(t); t = null; };
  const start = (e) => {
    clear();
    t = setTimeout(() => { t = null; fn(e); }, ms);
  };
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", clear);
  el.addEventListener("touchmove", clear);
  el.addEventListener("touchcancel", clear);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", clear);
  el.addEventListener("mouseleave", clear);
}

function wireDashboardLocks() {
  const bm = document.getElementById("btn-lock-move");
  const be = document.getElementById("btn-lock-edit");
  // Long-press ~2s (standard long-press range 500–2000ms; use 1800)
  if (bm && !bm.dataset.wired) {
    bm.dataset.wired = "1";
    bm.title = "Long-press: lock/unlock move for all cells";
    wireLongPress(bm, 1800, () => {
      window.globalMoveLocked = !window.globalMoveLocked;
      syncLockButtons();
      setStatus(window.globalMoveLocked ? "All cells: move locked" : "All cells: move unlocked", "ready");
    });
  }
  if (be && !be.dataset.wired) {
    be.dataset.wired = "1";
    be.title = "Long-press: lock/unlock edit for all cells";
    wireLongPress(be, 1800, () => {
      setAllEditLocked(!window.globalEditLocked);
    });
  }
  syncLockButtons();
}


wireDashboardLocks();

document.getElementById("btn-collapse-all")?.addEventListener("click", () => {
  cells.forEach((c) => {
    c.collapsed = true;
    c.outCollapsed = true;
    c.maximized = false;
    try { renderCell(c); } catch (_) {}
  });
  saveNotebookLocal(true);
  setStatus("All cells minimized", "ready");
});



/* Styled input() for Python */
window.__jideInputQueue = [];
function jideShowInput(promptText) {
  return new Promise((resolve) => {
    let backdrop = document.getElementById("input-modal");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "input-modal";
      backdrop.className = "input-backdrop hidden";
      backdrop.innerHTML = `
        <div class="input-sheet">
          <h3>Input</h3>
          <div class="input-prompt" id="input-prompt-text"></div>
          <input id="input-modal-field" type="text" autocomplete="off" spellcheck="false" />
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" id="input-modal-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="input-modal-ok">OK</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
    }
    const field = document.getElementById("input-modal-field");
    const promptEl = document.getElementById("input-prompt-text");
    promptEl.textContent = promptText || "";
    field.value = "";
    backdrop.classList.remove("hidden");
    setTimeout(() => field.focus(), 50);
    const finish = (val) => {
      backdrop.classList.add("hidden");
      document.getElementById("input-modal-ok").onclick = null;
      document.getElementById("input-modal-cancel").onclick = null;
      field.onkeydown = null;
      resolve(val);
    };
    document.getElementById("input-modal-ok").onclick = () => finish(field.value);
    document.getElementById("input-modal-cancel").onclick = () => finish("");
    field.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(field.value); }
      if (e.key === "Escape") { e.preventDefault(); finish(""); }
    };
  });
}
window.jideShowInput = jideShowInput;
window.jideBlockingInput = function(promptText) {
  const msg = promptText && String(promptText).trim() ? String(promptText) : "Input:";
  const v = window.prompt(msg, "");
  return v === null ? "" : v;
};



(function wireSaveFormat() {
  const fmt = document.getElementById("save-format");
  const nameInput = document.getElementById("save-name");
  if (!fmt || !nameInput) return;
  fmt.addEventListener("change", () => {
    let n = nameInput.value.trim() || "notebook";
    n = n.replace(/\.ipynb$/i, "").replace(/\.py$/i, "").replace(/\.json$/i, "");
    nameInput.value = n + (fmt.value === "py" ? ".py" : ".ipynb");
  });
})();

initPyodide();

window.addEventListener("resize", () => {
  cells.forEach((c) => {
    if (c.maximized) layoutMaximizedCell(c);
  });
});
